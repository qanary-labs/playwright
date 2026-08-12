# Custom

## Behavior changes vs upstream

- **`HttpsUpgrades` left enabled** (`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`).
  Upstream disables it (PR #27605); we removed it from `disabledFeatures` so Chromium keeps its default
  http→https auto-upgrade. Without it, targets that 302 from https to an http-only host (e.g. OIDC
  downgrade redirects) fail with "site can't be reached". Re-removing this is required after any rebase
  onto a newer Playwright base, since the upstream list will re-add `HttpsUpgrades`.

- **Hover completes the "real mouse" handshake** (`packages/playwright-core/src/server/dom.ts`,
  `_hover`). Some menu libraries deliberately ignore a single teleport `mousemove`: SmartMenus
  (WordPress/Elementor navs) opens hover submenus only after two consecutive
  mousemoves ≤2px apart within 300ms, a stream only physical mice produce. The fork's hover
  moves to the resolved point, then nudges one pixel out and back. Travel-based intent
  detectors (found in production on a global-nav flyout) are stricter still — they ignore
  both the teleport and the nudge, opening only when the pointer enters the element across
  its boundary while producing sustained movement — so hover then re-enters the element:
  it jumps just outside the nearest vertical edge and walks back to the hover point in
  small steps. The short excursion stays within an open menu panel when hovers chain.
  Net effect: hover-revealed menus open for a replayed hover exactly like they did for the
  live user. Guarded by the SmartMenus and travel-gate fixture tests in
  `tests/library/inspector/hover-inference.spec.ts`.

- **Hover inference engine** — the largest customization the fork carries. Recording never produced
  hover steps (upstream only records hovers via its codegen action-list dialog, which the api-mode
  tool doesn't have), so flows like *hover menu → click revealed item* replayed against a hidden
  target and timed out. The engine records a `hover` action only when it provably mattered:
  the pointer was over an element (dwell 300ms/5px, and/or) while new content became visible
  (`MutationObserver` on the document plus every open shadow root encountered; visibility evaluated
  one `requestAnimationFrame` after the mutation batch), and the next committed action's target is
  inside that revealed content. Confirmed hovers are recorded retroactively, immediately before the
  confirming action, flagged `inferred: true` on the payload (consumers replay them as optional
  steps). Nested menus emit one hover per level (candidate stack). Reveals caused by a committed
  action (click-to-open menus) are suppressed; candidates expire when their revealed content is
  removed or re-hidden. Reveal idioms covered (each verified on a real site):
  - nodes mounted into the DOM (React/portal menus, tooltips);
  - `hidden`/class/style flip on the hidden element itself (Bootstrap `.show`);
  - state-class flip on an always-visible ancestor whose CSS shows a hidden descendant
    (Beaver Builder `li.focus > ul.sub-menu`) — descendant scan, gated to the pointer's chain;
  - `opacity: 0` + `pointer-events: none` fade menus — visibility is opacity-aware (Playwright's
    own `isElementVisible` deliberately is not), and `transitionend`/`animationend` re-evaluates
    fades that are still at opacity ≈ 0 one frame after the triggering mutation;
  - pure-CSS `:hover` menus hidden by off-screen positioning (`.sub-menu { left: -9999px }`,
    a common WordPress theme idiom) — a full-size box entirely at negative document coordinates
    counts as invisible (unreachable by scrolling, unlike below-the-fold content), and since the
    reveal fires no mutation and no transition, a capped watch list of off-screen elements is
    polled on every pointer entry;
  - pure-CSS `:hover` display/visibility flips (Suckerfish `li:hover > ul { display: block }`)
    — a whole-document sweep for seeded-invisible-but-now-visible elements runs on each dwell.
  Remaining known gap (spec, *Known gap*): a sub-dwell (<300 ms) sweep through a mutation-free,
  non-off-screen pure-CSS menu — no signal fires before the pointer moves on.
  Hardening from production debugging (all covered by tests):
  - invisibility seeding re-runs at window `load` (reconciling), on the first pointer move
    (additive), and whenever a stylesheet arrives late (link `load`, `media` attribute flip, or
    an injected `<style>` — additive) — async CSS (WP Rocket) can hide menus after every earlier
    seed point on a cold cache, with no DOM mutation on the menu itself;
  - a class flip on a visible element re-seeds its subtree: closing a menu by removing the state
    class from the `<li>` re-hides the panel purely via CSS (the panel never mutates and
    `animation: none` fires no transition), and without re-registering it every reveal after the
    first would be undetectable once a committed action flushed the candidates (JetMenu);
  - zero-size containers with visible overflow (Elementor headers compute 1440×0) are not
    seeding boundaries — only clipping zero-size containers hide their subtree;
  - `display: contents` wrappers (Tailwind `.contents`) are not seeding boundaries
    either — `checkVisibility()` calls them hidden (no box) while their children
    render, which would turn every such wrapper into a false reveal that any later click
    inside it confirms;
  - candidates expire only when revealed content leaves the DOM, never on re-hiding — animated
    menus (JetMenu) dip through hidden states mid-interaction, and clickability at confirm time
    already proves the reveal mattered;
  - a revealed root that leaves the DOM falls back to its mount parent (body-level parents
    excepted) — AJAX menus render in stages (empty panel → loader → rendered Elementor
    template, each tick replacing the last), and losing the only root between ticks must not
    cost the trigger candidate (JetMenu template loading, systematic on fast first hovers);
  - the recorder's own overlay elements (`x-pw-*`) are excluded from seeding, reveals and
    attribution — the glass pane mounts around user interactions and, being permanently
    connected, a candidate holding it as a revealed root would never expire;
  - `<body>`/`<html>` never anchor dwell or reveal attribution — the pointer regularly parks
    on dead space while waiting for slow menu content (and headed browsers interleave stray
    OS-cursor events), and a recorded body hover replays as a no-op;
  - the engine's pointer feed listens on window for `mousemove` + `pointermove` +
    `pointerrawupdate`, not only through the recorder's document-level dispatch — consent
    blockers (CookieYes) capture window mousemove pre-consent, stopImmediatePropagation it and
    re-dispatch untrusted copies: page menus still open while the engine would see no trusted
    move at all (the recorder injects after page scripts, so it always loses the capture
    registration order; redundant event types make the order irrelevant).
  Diagnostics: per-frame main-world global `__pw_recorderHoverDebug()` (candidates, revealed
  roots, entered chain) — the intended way to debug a missing hover step on a live page.
  Full design and rationale: zazu's `docs/specs/hover-step-recording.md`.
  File map:
  - `packages/injected/src/recorder/hoverInference.ts` — the engine (new file; state, signals,
    confirmation, performance batching).
  - `packages/injected/src/recorder/recorder.ts` — `JsonRecordActionTool` integration: pointer/scroll
    feed, `_recordConfirmedAction` (emits confirmed hovers before each recorded action),
    `flushInferredHovers` on the tool interface and `Recorder`.
  - `packages/injected/src/recorder/pollingRecorder.ts` — main-world global
    `__pw_recorderFlushInferredHovers()` (same pattern as `__pw_refreshOverlay`): the embedder calls
    it per frame before assertions, which bypass the recorder, so a hover confirmed only by an
    assertion (tooltip checks) still gets recorded.
  - `packages/recorder/src/actions.d.ts` — `HoverAction.inferred?: boolean`.
  - `packages/playwright-core/src/client/browserContext.ts` — `_simplifyRecordedAction` forwards
    `inferred` onto the `recorderaction` payload.
  - `docs/src/api/class-recorderactionpayload.md` — payload docs (regenerates `types.d.ts`).
  - `tests/library/inspector/hover-inference.spec.ts` — regression tests, one local fixture per
    reveal idiom above; run with
    `npx playwright test --config=tests/library/playwright.config.ts --project="chromium-*" hover-inference`.
    Run these after every rebase — an upstream recorder change that silently breaks the engine
    shows up here first.

- **`Locator.generateSelectors()`** — public on-demand selector generation for the element a
  locator strictly resolves to (consumer: zazu's relocate mode, see its
  `docs/specs/relocate-mode.md`). Returns the same ranked `selector`/`selectors` the recorder
  emits at capture time, plus `frameSelectors` for elements inside iframes (reuses the
  recorder's `generateFrameSelector` walk). Generation calls core
  `injectedScript.generateSelector` with record mode's exact options (`multiple: true`,
  `collectSelectors: true` — what `recordSelectors: true` hardwires — and the context's
  `testIdAttributeName`), so ranking and interactive-ancestor promotion match a fresh recording
  by construction; no recorder session is required. Plumbing follows the standard channel path:
  `packages/protocol/spec/frame.yml` → generated channels/validator/metainfo,
  `server/frames.ts` (`generateSelectors`), `server/dispatchers/frameDispatcher.ts`,
  `client/locator.ts`, `docs/src/api/class-locator.md` (regenerates `types.d.ts`). Guarded by
  the `generateSelectors` tests (capture parity, frame chain, promotion, strictness) in
  `tests/library/inspector/recorder-api.spec.ts`.

- **Covered-target substitution inside `click`** — the fork's one change to what `click` may
  click, and its only change to `click` at all. Some interactive tiles stack sibling anchors
  that all navigate to the same URL and reveal one above the others on hover. Clicking requires
  moving the mouse onto the element, which is what reveals the cover, so the click creates its
  own interceptor: every retry re-hovers and the hit-target check fails again. A real user never
  clicks the underlay — their click lands on the cover, whose anchor declares the same
  destination — and that is what this reproduces. Full rationale: zazu's
  `docs/specs/covered-target-click-fallback.md`.

  **It never shortens a failure.** The caller's timeout stays the only thing that ends the retry
  loop, with the error it always produced. When the substitution declines, `_retryAction` simply
  continues. A refusal costs nothing and looks like nothing.

  *Knowing the target is unreachable.* No new hit test was needed: the action already runs two,
  and they were merely indistinguishable to the caller. `setupHitTargetInterceptor` checks the
  point *before* the interceptor is armed and the pointer has moved; the interceptor's listener
  checks again on the first real event. Preliminary passing and event-time failing means the
  cover materialised as the pointer arrived, so retrying cannot converge — carried as
  `revealedUnderPointer` on the existing `{ hitTargetDescription }` result. Both paths also
  carry the point it happened at, in viewport and frame coordinates, so the substitution works
  from what the failed attempt resolved instead of re-deriving it. The flag is withheld when the
  preliminary check was skipped: a transformed iframe has no translatable hit point, so an
  event-time interception there says nothing about when the cover appeared.

  *When it may fire.* Proof is necessary but not sufficient — substituting must never pre-empt a
  click that was about to work. `_retryAction` waits for one attempt per scroll alignment (the
  alignments are cycled precisely because a sticky overlay often *is* escapable by scrolling
  differently), which also costs the loop's own `0+20+100+100ms` of waiting, so a cover that
  clears on its own is waited out rather than substituted for. Any attempt not ending in an
  interception resets the count, and so does a locator handler running: `addLocatorHandler`
  exists to dismiss exactly these overlays, so a handler firing is the page being actively
  changed between attempts — the opposite of the futility the proof claims.
  `performActionPreChecks` and `_performLocatorHandlersCheckpoint` (`server/page.ts`) return
  whether a handler ran, for that reason alone. Offered at most once per action call, re-armed
  when those counters reset, and only for plain left single clicks (no modifiers, no
  multi-click, no `force`, no `trial`) — anything else means something a cover cannot be assumed
  to do the same way. No other action offers a recovery.

  *Guards*, all required: the target is (or is inside) a link whose `href` leads somewhere — a
  bare `#` and `javascript:` are the "anchor as button" idioms and prove nothing; something
  other than the target is on top at the point; the element on top is inside a link resolving to
  the identical absolute URL; both links carry the same `target` attribute. Interception from an
  ancestor document never arrives here at all — the frame check catches it before the
  interceptor is armed, so it is never flagged as pointer-revealed.

  The design point is that the guards read the hit chain the browser itself hit-tests. Rather
  than rebuild an approximation from outside the page — `document.elementFromPoint` plus
  `closest('a')` — `expectHitTarget` was split so its chain is reusable: it descends into the
  target's own shadow roots (so "nothing intercepts" stays correct for a target inside one),
  carries the `display: contents` and cross-browser element-ordering workarounds, and walks
  `assignedSlot ?? parentElementOrShadowHost` — the composed tree a click is dispatched along,
  which for slotted content reaches an anchor `closest()` cannot see. Targets are retargeted
  with the same `'button-link'` behavior `setupHitTargetInterceptor` uses, so this and the check
  that just failed agree on which element they mean. Nothing is re-derived between deciding and
  clicking, so there is no window for the page to move in between.

  Known limits, each pinned by a test: a cover already present when the click starts is never
  proven unreachable and is refused even when it leads to the same place; likewise a cover
  revealed by an *earlier* action with the pointer still parked on the element, since the
  evidence is a transition; and an interceptor whose anchor lives inside a *closed* shadow root
  is opaque to everything outside it, this chain included.

  Deliberately silent: `click` returns void and records the substitution only in its call log,
  so a caller cannot tell a substituted click from a plain one. Giving `click` a return value
  would change the signature of the most-used method in the API for one consumer. If that ever
  needs fixing, a page event is the additive way.

  Files: `packages/injected/src/coveredTarget.ts` (the guards, kept out of upstream files),
  `packages/injected/src/injectedScript.ts` (`hitTargetChain` extracted from `expectHitTarget`,
  which is otherwise unchanged, plus a thin `coveredTargetHref`), `server/dom.ts`
  (`PerformActionResult`, `scrollAlignments` hoisted to module scope so `_retryAction` can count
  against its length, `_performPointerAction`, `_retryAction`'s counters and recovery hook,
  `_click`'s eligibility gate, `_clickCoveredTarget`), `server/page.ts` (the two pre-check
  functions returning a boolean). No protocol, client, type or docs change: this is not new API,
  and no upstream test file is modified. Guarded by
  `tests/page/click-covered-target.spec.ts`; run with
  `npx playwright test --config=tests/library/playwright.config.ts --project="chromium-*" click-covered-target`.
  Its refusal and restraint cases are the regression tests — this makes `click` hit an element
  other than the one asked for, so every guard preventing it from doing so wrongly is pinned
  there, refusals assert an empty click log *and* a failure on the caller's timeout, and every
  fixture is hover-revealed because a cover present at rest would refuse without the guards
  being consulted at all.

## Installation

Follow [CONTRIBUTING.md](./CONTRIBUTING.md) guidelines.

## Build locally

Do these following commands into `packages/playwright` to build `.tgz` file.

```Bash
npm install
npm run build
npm pack
```

Integrate it into a real project through `npm`:

```Bash
npm install produced-file.tgz
```

And look like this in `package.json`:

```JSON
  "dependencies": {
    "playwright": "file:./playwright.tgz",
  }
```
