# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository and behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```markdown
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Match the Testing Bar

**If a package already has tests, your changes need tests too.**

Playwright requires a test for almost any new or modified functionality (per `CONTRIBUTING.md`). Recorder changes belong in the existing suites under `tests/library/` (see below). New behavior → add a test for it. Changed behavior → update the assertions or add new ones that lock in the new behavior. Bug fix → add a test that would have caught the bug.

Tests must lock in behavior, not just execute lines. An assertion like "doesn't throw", a mock that observes nothing, or a check that mirrors the implementation is coverage theater — strengthen it or delete it.

Tests must be hermetic (no external services) and pass on macOS/Linux/Windows.

Exceptions: trivial renames, comment-only changes, generated code edits.

---

## Project

Qanary Labs' fork of Playwright (forked at upstream v1.58.0, last upstream commit `961381ec7`). All fork work customizes the **codegen recorder**: it turns the CLI-only recorder into a dual-mode system with a programmatic, event-based API ("api" recorder mode) and a JSON Lines codegen output. When working on "the recorder" or "the json recorder", this is the feature set in question. See `CUSTOM.md` for packaging notes.

## Common Commands

| Task | Command |
| --- | --- |
| Install (npm workspaces, `packages/*`) | `npm ci` |
| Build in watch mode (recommended during dev) | `npm run watch` |
| One-shot build | `npm run build` |
| Download browsers (needed once) | `npx playwright install` |
| Full lint (eslint + tsc + doclint + codegen checks) | `npm run lint` |
| ESLint only (faster) | `npm run eslint` |
| Type-check only | `npm run tsc` |
| Library tests, Chromium only (fast path) | `npm run ctest` |
| Library tests, all three browsers | `npm run test` |
| Test-runner tests | `npm run ttest` |
| Single test file | `npm run ctest -- tests/library/inspector/recorder-api.spec.ts` |
| Filter tests by title | `npm run ctest -- -g "title substring"` |

Recorder-related test suites:

- `tests/library/inspector/recorder-api.spec.ts` — programmatic recorder / RecorderActionPayload (the fork's main suite)
- `tests/library/inspector/cli-codegen-*.spec.ts` — codegen behavior per language
- `tests/library/selector-generator.spec.ts` — selector generation incl. fork's multi-selector support

## Generated Files — Edit the Source, Not the Output

Several files are build outputs; the watch process will overwrite manual edits:

- `packages/playwright-core/src/generated/*Source.ts` (e.g. `injectedScriptSource.ts`, `pollingRecorderSource.ts`) are bundled from `packages/injected/src/`. After editing injected code, rebuild via `npm run build`/`watch` (or `node utils/generate_injected.js`).
- `packages/protocol/src/channels.d.ts` and protocol validators are generated from `packages/protocol/src/protocol.yml` via `node utils/generate_channels.js`.
- `packages/playwright-core/types/types.d.ts` is generated from `docs/src` API markdown via `node utils/generate_types/`. To change public API types (e.g. `RecorderActionPayload`), edit the corresponding `docs/src/api/class-*.md` file.

## Recorder Architecture (Fork Focus)

Data flow of one recorded action:

```text
DOM event in the page
  → injected recorder (packages/injected/src/recorder/recorder.ts)
      captures the event, retargets to the interactive element, generates
      selector(s) via packages/injected/src/selectorGenerator.ts, attaches
      fork metadata (sensitive, cookieBanner, positionRatio, form info…)
  → server recorder (packages/playwright-core/src/server/recorder.ts
      + src/server/recorder/* for signals, merging, replay)
      emits ActionAdded; codegen renders it per language
      (packages/playwright-core/src/server/codegen/, incl. fork's jsonl.ts)
  → client (packages/playwright-core/src/client/browserContext.ts)
      _simplifyRecordedAction() flattens it into a RecorderActionPayload and
      emits a 'recorderaction' event on BrowserContext/Page
```

So one recorder behavior change usually touches up to four layers: injected (`packages/injected/src/recorder/`), action types (`packages/recorder/src/actions.d.ts`), server codegen (`packages/playwright-core/src/server/codegen/jsonl.ts` for the JSON output), and the client payload mapping in `browserContext.ts` plus its public type in `docs/src/api/` markdown.

### Fork-Specific Pieces

- **Programmatic recorder ("api" mode)**: `_enableRecorder({ recorderMode: 'api', ... })` in the protocol (`packages/protocol/src/protocol.yml`); the client wires events instead of writing files. Entry points and payload assembly live in `packages/playwright-core/src/client/browserContext.ts`.
- **JSONL codegen**: `packages/playwright-core/src/server/codegen/jsonl.ts`, registered in `codegen/languages.ts` under language id `jsonl`. One JSON object per action (selector, ranked `selectors[]`, form info, `cookieBanner`, `positionRatio`, frame selectors, locator).
- **Multi-selectors**: `generateSelector()` in `packages/injected/src/selectorGenerator.ts` can collect a ranked list of alternative selectors (`collectSelectors` option), surfaced as `selectors[]` in payloads.
- **Injected-side detectors** (all in `packages/injected/src/recorder/recorder.ts`): sensitive-input detection (input `type` and `autocomplete` values), cookie-banner detection (ancestor attribute named by `window.__pwCookieBannerAttribute`), click `positionRatio` (click position normalized to the element's box, for replay tolerance), label/overlay click attribution quirks.

## Conventions

- Commit messages: upstream uses Conventional Commits (`fix(codegen): ...`); fork commits on top of v1.58 use plain descriptive sentences — follow the style of recent fork commits for fork features.
- Coding style is enforced by `eslint.config.mjs`; comments only where the code can't be made self-explanatory.
- **Upstream upgrades**: whenever an upgrade of this fork to a newer upstream Playwright release is discussed or planned, always write (or update) a spec file in `docs/upgrade/` (e.g. `docs/upgrade/upgrade-to-v1.60.0.md`) covering: current base commit vs target tag, fork commits to carry, conflict map, generated files to regenerate, breaking changes to absorb, and the verification gate. Beware: local fork tags (e.g. `v1.58.0`) may not match upstream's tags — always diff against the upstream base commit.
