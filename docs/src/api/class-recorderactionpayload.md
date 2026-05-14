# class: RecorderActionPayload
* since: v1.57
* Qanary fork

Represents the payload emitted by [`event: BrowserContext.recorderaction`] and [`event: Page.recorderaction`].

## property: RecorderActionPayload.selector
* since: v1.57
- type: <[string]>

The primary selector Playwright generated for the element.

## property: RecorderActionPayload.action
* since: v1.57
- type: <[string]>

Recorded user action type. One of `'check'`, `'click'`, `'closePage'`, `'fill'`, `'hover'`, `'navigate'`, `'openPage'`, `'press'`, `'select'`, `'setInputFiles'`, `'uncheck'`, `'assertText'`, `'assertValue'`, `'assertChecked'`, `'assertVisible'`, `'assertSnapshot'`.

## property: RecorderActionPayload.selectors
* since: v1.57
- type: <[Array]<[string]>>

Additional selectors ranked from best to worst. May be empty.

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
- type: <[Array]<[Array]<[string]>>>

Alternative selectors for each iframe in the frame path, from the outermost to the innermost. Each entry is an array of selectors ranked from best to worst for the corresponding iframe element. Only present when the target element is inside an iframe.

## property: RecorderActionPayload.displayValue
* since: v1.57
- type: <[string]>

Human-readable representation of the selected value(s). For `'select'` actions, contains the visible labels of the selected options, separated by `", "`.

## property: RecorderActionPayload.cookieBanner
* since: v1.58
- type: <[string]>

Identifier of the cookie/consent banner ancestor of the action target, when the target element (or any of its ancestors, including across open shadow roots) carries the data attribute named in `window.__pwCookieBannerAttribute`. The value is the attribute's value (typically a vendor name like `"onetrust"` or a generic tag set by the consumer). Empty string when no banner ancestor was found or the global is unset.
