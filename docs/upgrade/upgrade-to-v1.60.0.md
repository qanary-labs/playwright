# Upgrade Spec: Fork v1.58.0 → Upstream v1.60.0

Status: draft — not started
Date: 2026-06-10

## 1. Context

| | |
| --- | --- |
| Current fork base | upstream commit `961381ec7` (v1.58.0 line, Jan 2026) |
| Target | upstream tag `v1.60.0` = commit `87bb9ddbd` (released 2026-05-11) |
| Fork commits to carry | 20 commits, ~2,146 insertions across 55 files (see §3) |
| Upstream delta | v1.58.0 → v1.60.0: ~1,500 files changed (includes two releases: v1.59.0 2026-04-01, v1.60.0 2026-05-11, plus the v1.58.1/.2 patches the fork never absorbed) |

⚠️ The local tag `v1.58.0` is the **fork's own release tag** (it includes fork commits) and does **not** match upstream's `v1.58.0`. Never use the local tag as the upstream base in diffs or rebase commands — always use `961381ec7`.

## 2. What the upgrade buys us

- **Browsers**: Chromium 145.0.7632 → 148.0.7778, Firefox 146.0.1 → 150.0.2, WebKit 26.0 → 26.4 (~4 months of site-compat and security fixes).
- **v1.59 `page.screencast`**: in-page action annotations (`showActions`), HTML overlays / chapter titles (`showOverlay`, `showChapter`) injected into the page DOM via the injected script — they render in any capture of the tab, including our WebRTC stream, with no dependency on the CDP frame pipeline. The CDP-based frame capture / ffmpeg recording half is redundant for us.
- **v1.60**: `locator.drop()` (synthetic external file/clipboard drag-and-drop), aria snapshots with `boxes` option and page-level `toMatchAriaSnapshot()`, `tracing.startHar()/stopHar()`, `test.abort()`.
- v1.58.1/.2 patch fixes (msedge local-network permissions, trace-viewer stdin paths, mac swiftshader).

## 3. Fork commits to carry (in order)

All 20 commits between `961381ec7` and current `main`. None should be dropped; `bd1b8a724` (CLAUDE.md) and the docs/test-only ones rebase trivially.

```text
25207780b Page.getSelectedText() and Page.selectorAtPoint(x, y) added
78d07d396 Page.generateSelectors() added
b12bc205f Recorder can be launched programatically
1bcf8249b SelectorAtPoint() & GenerateSelectors() removed since native recorder is now used
bf584d337 Press action returns key as value
2ffb9a24a Codegen overlay can be disabled
414792c7c Multi selectors v1
8b923542a Fill action tells if input is sensitve
6e2e40f4e RecordActionEvent: press key event takes in account all possible modifiers
24a8736e9 RecordActionEvent: interaction provides following infos on targeted element: submit element or not, if in a form, formID
af17e7f4c Combobox select action returns selected values and associated labels in record action payload
11644a2ea RecordActionPayload returns Iframes locators too
9f807442f Click on a labeled radio/checkbox input leads to only one event
981dfe846 Synthetic click tolerance added in recorder to bypass limitations relative to third libraries stopping event propagation and replaying trusted events
5e4929755 Cookie banner detector added
487f5c27b Click/Unclick command search for labels in case the input is present but not visible, in order to interact with
cfaf818d5 Recorder (api mode) attributes a click to the pressed control when a mousedown-triggered overlay steals the mouseup
c365ba496 Record Event returns element boundRect relative position for click interactions
8eec33aff Sensitive inputs are also based on autocomplete values, not only type
bd1b8a724 Claude guidelines added
```

Note: `25207780b`/`78d07d396` are later reverted by `1bcf8249b`. If interactive rebase produces conflicts in those three, an acceptable simplification is to drop all three pairs-and-revert commits together — verify nothing else references `getSelectedText`/`selectorAtPoint`/`generateSelectors` first.

## 4. Strategy: rebase, not merge

Rebase the 20 fork commits onto `v1.60.0` so the fork stays "N commits on top of an upstream tag" (same structure as today). Work on a branch; `main` stays untouched until the gate in §8 passes.

```bash
git remote add upstream https://github.com/microsoft/playwright.git  # if absent
git fetch upstream tag v1.60.0 --no-tags
git checkout -b upgrade/v1.60.0 main
git rebase --onto v1.60.0 961381ec7 upgrade/v1.60.0
```

Resolve commit by commit; after each conflicted commit, `npm run build` must succeed before continuing (catches type breaks early instead of at the end).

## 5. Conflict map

Churn between fork and upstream on the same files (lines added+deleted):

| File | Fork | Upstream | Expected effort |
| --- | --- | --- | --- |
| `packages/playwright-core/src/client/browserContext.ts` | 122 | 139 | **High** — both sides changed it heavily; our `_simplifyRecordedAction()` / payload assembly vs upstream screencast & API wiring. Resolve by hand, keep both. |
| `packages/playwright-core/src/server/recorder.ts` | 19 | 192 | **Medium** — upstream restructured; our 19 lines must be re-applied onto the new shape, not the old one. |
| `packages/injected/src/recorder/recorder.ts` | 377 | 63 | **Medium** — our biggest file, but upstream churn is small; conflicts should be local. |
| `packages/injected/src/selectorGenerator.ts` | 80 | 11 | Low |
| `packages/playwright-core/src/server/recorder/recorderUtils.ts` | small | 20 | Low |
| `packages/playwright-core/src/server/recorder/recorderSignalProcessor.ts` | small | 7 | Low |
| `packages/protocol/src/protocol.yml` | 6 | 4,391 | Low — keep our 6 lines (`recorderMode` etc. additions), take upstream for the rest, then **regenerate** (§6). |
| `packages/playwright-core/src/server/codegen/jsonl.ts` | 0 vs base | 2 | None — file is upstream's; we never diverged. Confirm our `languages.ts` registration still holds. |
| `tests/library/inspector/recorder-api.spec.ts` | fork additions | 39 | Low — upstream added tests to the same file; keep both sets. |

The `recorderMode: 'api'` entry point exists upstream at v1.60.0 — our foundation is intact.

## 6. Generated files — regenerate, never hand-merge

Take **theirs** (upstream) on conflict, then regenerate after the rebase completes:

| Generated file | Regenerate with |
| --- | --- |
| `packages/playwright-core/src/generated/*Source.ts` (injectedScript, pollingRecorder…) | `npm run build` or `node utils/generate_injected.js` |
| `packages/protocol/src/channels.d.ts`, protocol validators (`validator.ts`) | `node utils/generate_channels.js` (after protocol.yml is resolved) |
| `packages/playwright-core/types/types.d.ts`, `packages/playwright-client/types/types.d.ts` | `node utils/generate_types/` (after `docs/src/api/*.md` are resolved — our `class-recorderactionpayload.md` and `_enableRecorder`-related doc additions must survive) |

Commit the regenerated output as part of the resolved rebase commits, not as a separate fix-up at the end.

## 7. Breaking changes to absorb

Check each against fork code **and** downstream Qanary consumers of the package:

v1.59:

- WebKit dropped macOS 14 support (dev machines on macOS 25.x — fine; verify CI images).
- `@playwright/experimental-ct-svelte` removed — our rebase must not resurrect `packages/playwright-ct-svelte`; drop our version-bump change to its package.json.
- junit reporter reports some `<failure>` as `<error>` — only matters if downstream CI parses junit output.

v1.60 (removed long-deprecated APIs — grep fork + consumers for usage):

- `Locator.ariaRef()`
- `handle` option on `exposeBinding`
- `logger` option on `connect` / `connectOverCDP`
- Context options `videosPath` / `videoSize` (use `recordVideo`)

Already-absorbed v1.58.0 breaking changes (`_react`/`_vue` selectors, `:light` suffix, `devtools` option) need no action.

## 8. Verification gate (must all pass before merging to main)

```bash
npm ci
npx playwright install          # new browser builds: Cr 148 / Ff 150 / WK 26.4
npm run build
npm run lint                    # eslint + tsc + doclint + codegen checks
npm run ctest -- tests/library/inspector/recorder-api.spec.ts
npm run ctest -- tests/library/selector-generator.spec.ts
npm run ctest -- -g "cli-codegen"
npm run ctest                   # full library suite, Chromium
npm run test                    # all three browsers (at minimum the recorder suites)
```

Manual smoke test on top of the suites: run a recording session in api mode against a real form-heavy page and confirm a `recorderaction` payload still carries the fork fields (`selectors[]`, `sensitive`, `cookieBanner`, `positionRatio`, form info, frame selectors).

## 9. Release

- Re-tag the fork (`v1.60.0-qanary.1` or follow the existing fork tag convention — note the existing local `v1.58.0` clash, prefer suffixed tags going forward).
- Repackage per `CUSTOM.md`: `npm install && npm run build && npm pack` in `packages/playwright`, deliver the `.tgz` to consumers.
- Update `CLAUDE.md` "forked at upstream v1.58.0, last upstream commit `961381ec7`" line to the new base (`v1.60.0`, `87bb9ddbd`).

## 10. Out of scope (follow-ups, separate from the upgrade)

- Adopting `screencast.showActions()` / `showOverlay()` / `showChapter()` for replay receipts in the WebRTC stream. If pursued, verify the injected overlay elements don't trip our recorder's detectors (sensitive input, cookie banner, selector generation) during active recording sessions.
- `locator.drop()` support in recorded-action replay.
