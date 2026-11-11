# class: RecorderActionPayload
* since: v1.57
* Qanary fork

Represents the payload emitted by [`event: BrowserContext.recorderaction`] and [`event: Page.recorderaction`].

## property: RecorderActionPayload.action
* since: v1.57
- type: <[string]>

Recorded user action type. One of `'check'`, `'click'`, `'closePage'`, `'fill'`, `'hover'`, `'navigate'`, `'openPage'`, `'press'`, `'select'`, `'setInputFiles'`, `'uncheck'`, `'assertText'`, `'assertValue'`, `'assertChecked'`, `'assertVisible'`, `'assertSnapshot'`.

## property: RecorderActionPayload.selectors
* since: v1.60
- type: <[Array]<[Object]>>
  - `selector` <[string]>
  - `score` <[float]>

Every selector collected for the element, sorted strongest first. Each one resolves to the
target element alone at capture time, so the first entry is the one to lead with and the rest
are fallbacks that fail differently — a test id, an accessible name, a stable attribute, a
structural path. Consumers pick their own primary from this list; Playwright does not name one.

`score` is Playwright's own engine score for the selector, on its existing scale where **lower
is stronger** (a test id scores `1`, a role-with-name around `100`, a positional fallback path
in the millions). Treat it as ordinal and comparable only between selectors of the same action:
the scale orders selector families, it does not measure how much better one is than another.
Empty for actions that replay without an element, such as `'press'`, and for text
expectations (`'assertText'`, `'assertSnapshot'`), where the generator deliberately
produces a single selector that is not required to resolve to one element.

## property: RecorderActionPayload.role
* since: v1.57
- type: <[string]>

Element role (for example `'button'`, `'link'`) if detected.

## property: RecorderActionPayload.text
* since: v1.57
- type: <[string]>

Element text captured at the moment of the action, if any.

## property: RecorderActionPayload.value
* since: v1.57
- type: <[string]>

Value recorded for value-carrying actions. For example, the text passed to `locator.fill()` or the list of files passed to `setInputFiles()`.

For `'click'` actions, this encodes the mouse button together with any held modifier keys as a `'+'`-separated string, with the button always last: for example `'left'`, `'right'`, `'Control+left'`, or `'Control+Shift+middle'`. The leading tokens (`'Control'`, `'Alt'`, `'Shift'`, `'Meta'`) and trailing button (`'left'`, `'middle'`, `'right'`) map directly onto the `modifiers` and `button` options of `locator.click()`.

## property: RecorderActionPayload.sensitive
* since: v1.57
- type: <[boolean]>

Value recorded for value-carrying actions considered sensitive or not, based on input type (eg. `password` or not).

## property: RecorderActionPayload.submitter
* since: v1.57
- type: <[boolean]>

Whether the component targeted by locator is a form submitter.

## property: RecorderActionPayload.formId
* since: v1.57
- type: <[string]>

The `id` of the closest form for the component targeted by locator, or an empty string when there is no form or the form has no `id`.

## property: RecorderActionPayload.isInForm
* since: v1.57
- type: <[boolean]>

Whether the component targeted by locator is inside a form.

## property: RecorderActionPayload.frameSelectors
* since: v1.57
- type: <[Array]<[Array]<[Object]>>>
  - `selector` <[string]> Selector expression for that iframe element.
  - `score` <[float]> Playwright's engine score for it — **lower is stronger**.

Alternative selectors for each iframe in the frame path, from the outermost to the innermost. Each entry is the scored candidate set for the corresponding iframe element, sorted strongest first — same shape and score scale as [`property: RecorderActionPayload.selectors`]. Only present when the target element is inside an iframe.

## property: RecorderActionPayload.displayValue
* since: v1.57
- type: <[string]>

Human-readable representation of the selected value(s). For `'select'` actions, contains the visible labels of the selected options, separated by `", "`.

## property: RecorderActionPayload.cookieBanner
* since: v1.58
- type: <[string]>

Identifier of the cookie/consent banner ancestor of the action target, when the target element (or any of its ancestors, including across open shadow roots) carries the data attribute named in `window.__pwCookieBannerAttribute`. The value is the attribute's value (typically a vendor name like `"onetrust"` or a generic tag set by the consumer). Empty string when no banner ancestor was found or the global is unset.

## property: RecorderActionPayload.count
* since: v1.58
- type: <[int]>

How many times the action occurred in quick succession on the same element. For `'click'` actions this is the click count: `1` for a single click, `2` for a double click, `3` for a triple click. A repeated action surfaces as successive payloads with an increasing count for the same element — consumers applying last-wins keep the final occurrence. Always `1` for actions without repeat semantics.

## property: RecorderActionPayload.inferred
* since: v1.60
- type: ?<[boolean]>

Present and `true` on `'hover'` actions produced by the hover inference engine: the hover was not an explicit recording gesture but was recorded retroactively because the next committed action targeted content the hover revealed (dropdown menu, tooltip, row actions). Consumers may render such steps distinctly and should replay them as optional — a stale inferred hover must not fail the run. Absent otherwise.

## property: RecorderActionPayload.positionRatio
* since: v1.58
- type: ?<[Object]>
  - `x` <[float]>
  - `y` <[float]>

Normalized click point, with each axis in `[0, 1]`, relative to the recorded element's padding box, for `'click'` actions. Multiplying these ratios by the element's padding-box size at replay reconstructs the exact point that was pressed, robust to layout/viewport changes. This also keeps replay accurate when the selector was retargeted to an interactive ancestor (for example an icon `<i>` inside a `<a>`/`<button>`): the ratios are relative to that ancestor, so the click still lands on the pressed sub-element. Absent for non-click actions and when the element's box could not be measured.

## property: RecorderActionPayload.point
* since: v1.60
- type: ?<[Object]>
  - `x` <[float]>
  - `y` <[float]>

Where the recorded element is on the whole page: the center of its bounding box in the document coordinates of its own frame — viewport position plus the frame's scroll offset, in CSS pixels — read on the element the selectors were generated for (after any retarget to an interactive ancestor, like [`property: RecorderActionPayload.positionRatio`]). Present on every action that carries selectors, clicks and keyboard-driven actions alike, so a consumer can later tell apart elements the selectors no longer distinguish (a repeated component whose distinguishing attributes drifted) by where the element was. Absent when the element's box has no area. Unlike [`property: RecorderActionPayload.positionRatio`], it says which element, not where on it.

## property: RecorderActionPayload.fingerprint
* since: v1.60
- type: ?<[Object]>
  - `role` <[string]> The element's ARIA role, empty when it has none.
  - `name` <[string]> Its accessible name, capped at 100 characters.
  - `tag` <[string]> Its tag name.
  - `text` ?<[string]> Its visible text, capped at 100 characters. Never the value of a field.
  - `label` ?<[string]> For a field: its label, else its placeholder.
  - `context` <[Array]<[Object]>> Up to 3 entries: the nearest landmark, region, form, dialog, list item, row, article or table ancestors, innermost first, then the nearest visible heading before the element.
    - `role` <[string]>
    - `name` <[string]>
  - `repeat` ?<[Object]> Present when the element is one of several structural copies.
    - `index` <[int]> Which copy, from 0, in document order.
    - `count` <[int]> How many copies.
    - `distinct` ?<[boolean]> `true` when no other copy's element has this element's accessible name (a menu's entries, a list of differently named links). Absent otherwise.

What the recorded element is, in human terms, read on the same element and in the same tick as [`property: RecorderActionPayload.point`]. `repeat` is found by walking up from the element to the first ancestor whose parent holds other children of its tag and role in which the path down to the element (tag and role of each hop) also matches: a card in a list of cards, a row in a table. Present on every action that carries selectors.

## property: RecorderActionPayload.collection
* since: v1.60
- type: ?<[Object]>
  - `items` <[Array]<[Object]>> Selectors matching every copy and nothing outside their parent, strongest first, at most 5.
    - `selector` <[string]>
    - `score` <[float]>
  - `target` <[Array]<[Object]>> Selectors relative to one copy, each matching exactly one element in every copy, strongest first, at most 5.
    - `selector` <[string]>
    - `score` <[float]>

Present when [`property: RecorderActionPayload.fingerprint`] has a `repeat` and both lists validated: selectors naming the set of copies and the element inside a copy, so a consumer can act on "the first copy" whichever copy that is, where [`property: RecorderActionPayload.selectors`] name the copy the user acted on. In the element's frame: [`property: RecorderActionPayload.frameSelectors`] apply to both.
