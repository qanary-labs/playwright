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
