/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './inspectorTest';

import type { Page } from '@playwright/test';
import type * as actions from '@recorder/actions';
import type * as channels from '@protocol/channels';

class RecorderLog {
  actions: (actions.ActionInContext & { code: string })[] = [];

  actionAdded(page: Page, actionInContext: actions.ActionInContext, code: string): void {
    this.actions.push({ ...actionInContext, code });
  }

  actionUpdated(page: Page, actionInContext: actions.ActionInContext, code: string): void {
    this.actions[this.actions.length - 1] = { ...actionInContext, code };
  }
}

async function startRecording(context, params: Partial<channels.BrowserContextEnableRecorderParams> = {}) {
  const log = new RecorderLog();
  await (context as any)._enableRecorder({
    mode: 'recording',
    recorderMode: 'api',
    ...params,
  }, log);
  return {
    action: (name: string) => log.actions.filter(a => a.action.name === name),
  };
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}

test('should click', async ({ context, browserName, platform, channel }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<button onclick="console.log('click')">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();

  const clickActions = log.action('click');
  expect(clickActions).toEqual([
    expect.objectContaining({
      action: expect.objectContaining({
        name: 'click',
        selector: 'internal:role=button[name="Submit"i]',
        ref: 'e2',
        // Safari does not focus after a click: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#clicking_and_focus
        ariaSnapshot: (browserName === 'webkit' && (platform === 'darwin' || (platform === 'win32' && channel !== 'webkit-wsl'))) ? '- button "Submit" [ref=e2]' : '- button "Submit" [active] [ref=e2]',
      }),
      startTime: expect.any(Number),
    })
  ]);

  expect(normalizeCode(clickActions[0].code)).toEqual(`await page.getByRole('button', { name: 'Submit' }).click();`);

  // Every click records a normalized position within the recorded element's padding box.
  const ratio = (clickActions[0].action as any).positionRatio;
  expect(ratio).toBeTruthy();
  expect(ratio.x).toBeGreaterThanOrEqual(0);
  expect(ratio.x).toBeLessThanOrEqual(1);
  expect(ratio.y).toBeGreaterThanOrEqual(0);
  expect(ratio.y).toBeLessThanOrEqual(1);
});

test('should double click', async ({ context, browserName, platform, channel }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<button onclick="console.log('click')" ondblclick="console.log('dblclick')">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).dblclick();

  const clickActions = log.action('click');
  expect(clickActions).toEqual([
    expect.objectContaining({
      action: expect.objectContaining({
        name: 'click',
        clickCount: 2,
        selector: 'internal:role=button[name="Submit"i]',
        ref: 'e2',
        // Safari does not focus after a click: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#clicking_and_focus
        ariaSnapshot: (browserName === 'webkit' && (platform === 'darwin' || (platform === 'win32' && channel !== 'webkit-wsl'))) ? '- button "Submit" [ref=e2]' : '- button "Submit" [active] [ref=e2]',
      }),
      startTime: expect.any(Number),
    })
  ]);

  expect(normalizeCode(clickActions[0].code)).toEqual(`await page.getByRole('button', { name: 'Submit' }).dblclick();`);
});

test('should record the pressed control when a mousedown overlay steals the mouseup', async ({ context }) => {
  // Repro of bootstrap-touchspin + PrestaShop: clicking the control fires an async
  // action on mousedown that shows a full-screen loading overlay. With the pointer
  // held still, the overlay captures mouseup, so the browser fires the trusted click
  // on <body> (the common ancestor of mousedown=button and mouseup=overlay). The
  // recorded action must still point at the button, not <body>.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <div id="overlay" style="position:fixed;inset:0;display:none;z-index:9999"></div>
    <button id="plus">+</button>
    <script>
      const overlay = document.getElementById('overlay');
      document.getElementById('plus').addEventListener('mousedown', () => { overlay.style.display = 'block'; });
      window.addEventListener('mouseup', () => { overlay.style.display = 'none'; }, true);
    </script>
  `);
  await page.getByRole('button', { name: '+' }).click();

  const clickActions = log.action('click');
  expect(clickActions.length).toBe(1);
  expect(clickActions[0].action).toEqual(expect.objectContaining({
    name: 'click',
    selector: 'internal:role=button[name="+"i]',
  }));
});

test('records a click position when retargeting to an interactive ancestor', async ({ context }) => {
  // <a><i></i></a> where the listener is on the inner <i>: generateSelector retargets
  // to the <a> (a robust role locator), but a center click on a padded <a> would miss
  // the icon. The recorded action keeps the <a> selector AND a position relative to it
  // so replay lands on the icon.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <a id="lnk" href="#" style="display:inline-block;padding:40px">
      <i id="ico" style="display:inline-block;width:12px;height:12px;background:#000"></i>
    </a>`);
  await page.locator('#ico').click();

  const clickActions = log.action('click');
  expect(clickActions.length).toBe(1);
  const action = clickActions[0].action as any;
  // Selector targets the interactive ancestor (the link), not the inner <i>.
  expect(action.selector).toBe('#lnk');
  // Normalized position (0..1 of the link's padding box) so replay lands on the icon.
  expect(action.positionRatio).toBeTruthy();
  expect(action.positionRatio.x).toBeGreaterThan(0);
  expect(action.positionRatio.x).toBeLessThan(1);
  expect(action.positionRatio.y).toBeGreaterThan(0);
  expect(action.positionRatio.y).toBeLessThan(1);
  // The icon's normalized region within the link; the recorded ratio falls inside it.
  const iconRatio = await page.locator('#ico').evaluate(el => {
    const a = (el.closest('a') as HTMLElement).getBoundingClientRect();
    const i = el.getBoundingClientRect();
    return { left: (i.left - a.left) / a.width, top: (i.top - a.top) / a.height, right: (i.right - a.left) / a.width, bottom: (i.bottom - a.top) / a.height };
  });
  expect(action.positionRatio.x).toBeGreaterThanOrEqual(iconRatio.left - 0.01);
  expect(action.positionRatio.x).toBeLessThanOrEqual(iconRatio.right + 0.01);
  expect(action.positionRatio.y).toBeGreaterThanOrEqual(iconRatio.top - 0.01);
  expect(action.positionRatio.y).toBeLessThanOrEqual(iconRatio.bottom + 0.01);
});

test('does not record a click position for an Enter-key implicit form submission', async ({ context }) => {
  // Pressing Enter in a form fires a synthetic (detail === 0, clientX/Y === 0) click
  // on the submit button. Recording positionRatio {x:0,y:0} would make replay click
  // the padding-box corner, which misses rounded buttons. No ratio must be recorded
  // so replay falls back to the center click.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <form onsubmit="return false">
      <input id="user" type="text" />
      <button id="go" type="submit" style="border-radius:9999px">Go</button>
    </form>`);
  await page.locator('#user').click();
  await page.locator('#user').fill('alice');
  await page.locator('#user').press('Enter');

  // The implicit submission is recorded as a synthetic click (clickCount === 0) on
  // the submit button, with no positionRatio.
  const submitClick = log.action('click').find(a => (a.action as any).clickCount === 0);
  expect(submitClick).toBeTruthy();
  expect((submitClick!.action as any).selector).toBe('internal:role=button[name="Go"i]');
  expect((submitClick!.action as any).positionRatio).toBeUndefined();
});

test('should right click', async ({ context, browserName, platform, channel }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<button oncontextmenu="console.log('contextmenu')">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click({ button: 'right' });

  const clickActions = log.action('click');
  expect(clickActions).toEqual([
    expect.objectContaining({
      action: expect.objectContaining({
        name: 'click',
        button: 'right',
        selector: 'internal:role=button[name="Submit"i]',
        ref: 'e2',
        // Safari does not focus after a click: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#clicking_and_focus
        ariaSnapshot: (browserName === 'webkit' && (platform === 'darwin' || (platform === 'win32' && channel !== 'webkit-wsl'))) ? '- button "Submit" [ref=e2]' : '- button "Submit" [active] [ref=e2]',
      }),
      startTime: expect.any(Number),
    })
  ]);

  expect(normalizeCode(clickActions[0].code)).toEqual(`await page.getByRole('button', { name: 'Submit' }).click({ button: 'right' });`);
});

test('should type', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<input type="text" />`);

  await page.getByRole('textbox').pressSequentially('Hello');

  const fillActions = log.action('fill');
  expect(fillActions).toEqual([
    expect.objectContaining({
      action: expect.objectContaining({
        name: 'fill',
        selector: 'internal:role=textbox',
        ref: 'e2',
        ariaSnapshot: '- textbox [active] [ref=e2]: Hello',
      }),
      startTime: expect.any(Number),
    })
  ]);

  expect(normalizeCode(fillActions[0].code)).toEqual(`await page.getByRole('textbox').fill('Hello');`);
});

test('keeps a password field sensitive after an eye-button flips it to text', async ({ context }) => {
  // A reveal "eye" button toggles the input's type from password to text. Sensitivity
  // must stick to the element, otherwise fills recorded after the toggle leak the value.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <input id="pwd" type="password" />
    <button id="eye" onclick="document.getElementById('pwd').type='text'">show</button>`);
  await page.locator('#pwd').pressSequentially('ab'); // typed while type=password
  await page.locator('#eye').click(); // flips the field to type=text
  await page.locator('#pwd').pressSequentially('cd'); // typed while type=text, same element

  const fills = log.action('fill');
  expect(fills.length).toBeGreaterThanOrEqual(1);
  // Every recorded fill on the toggled field stays sensitive, including the ones typed
  // after the field became type=text.
  for (const f of fills)
    expect((f.action as any).sensitive).toBe(true);
});

test('treats autocomplete=current-password as sensitive even when type is text', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<input id="pwd" type="text" autocomplete="current-password" />`);
  await page.locator('#pwd').pressSequentially('secret');

  const fills = log.action('fill');
  expect(fills.length).toBeGreaterThanOrEqual(1);
  for (const f of fills)
    expect((f.action as any).sensitive).toBe(true);
});

test('should disable recorder', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`<button onclick="console.log('click')">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('button', { name: 'Submit' }).click();
  expect(log.action('click')).toHaveLength(2);
  await (context as any)._disableRecorder();
  await page.getByRole('button', { name: 'Submit' }).click();
  expect(log.action('click')).toHaveLength(2);
});

test('page.pickLocator should return locator for picked element', async ({ page }) => {
  await page.setContent(`<button>Submit</button>`);

  const scriptReady = page.waitForEvent('console', msg => msg.text() === 'Recorder script ready for test');
  const pickPromise = page.pickLocator();
  await scriptReady;

  const box = await page.getByRole('button', { name: 'Submit' }).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  const locator = await pickPromise;
  await expect(locator).toHaveText('Submit');
});

test('page.cancelPickLocator should cancel ongoing pickLocator', async ({ page }) => {
  const pickPromise = page.pickLocator();
  await Promise.all([
    page.cancelPickLocator(),
    expect(pickPromise).rejects.toThrow('Locator picking was cancelled')
  ]);
});

test('closing page should cancel ongoing pickLocator', async ({ page }) => {
  await page.setContent(`<button>Click me</button>`);
  const pickPromise = page.pickLocator().catch(e => e.message);
  await page.close();
  expect(await pickPromise).toContain('Target page, context or browser has been closed');
});

test('page2.pickLocator() should cancel page1.pickLocator()', async ({ page, context, browserName, headless, isMac, macVersion }) => {
  test.fixme(browserName === 'chromium' && !headless && isMac && macVersion === 14, 'times out on chromium headed on macOS 14');
  const pick1Promise = page.pickLocator().catch(e => e.message);

  const page2 = await context.newPage();
  page2.pickLocator().catch(() => {});

  expect(await pick1Promise).toContain('Locator picking was cancelled');
});

test('should collect multiple selectors when requested', async ({ context }) => {
  const log = await startRecording(context, { collectSelectors: true });
  const page = await context.newPage();
  await page.setContent(`<button>Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();

  const clickActions = log.action('click');
  expect((clickActions[0].action as actions.ActionWithSelector).selectors?.length).toBeGreaterThan(1);
});

test('should emit recorder action events for recordSelectors option', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, selector: string, selectors: string[], role?: string, text?: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, selector: string, selectors: string[], role?: string, text?: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<button>Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();

  expect(events).toHaveLength(1);
  expect(events[0].action).toBe('click');
  expect(events[0].selectors.length).toBeGreaterThan(1);
  await recordedContext.close();
});

test('should emit recorder action for each fill', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, value?: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, value?: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<input type="text" />`);
  await page.getByRole('textbox').fill('Hello');
  await page.getByRole('textbox').fill('World');

  // Recorder events are delivered asynchronously, poll until they arrive.
  await expect.poll(() => events.filter(e => e.action === 'fill').map(e => e.value)).toEqual(['Hello', 'World']);
  await recordedContext.close();
});

test('should emit recorder action for every keystroke while typing', async ({ context }) => {
  // Consecutive fills on the same element merge into actionUpdated events; each update
  // must still surface as a recorderaction so consumers can apply last-wins.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, value?: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, value?: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<input type="text" />`);
  await page.getByRole('textbox').pressSequentially('Hello');

  // Recorder events are delivered asynchronously, poll until they arrive.
  await expect.poll(() => events.filter(e => e.action === 'fill').map(e => e.value)).toEqual(['H', 'He', 'Hel', 'Hell', 'Hello']);
  await recordedContext.close();
});

test('should report the click count of a double click', async ({ context }) => {
  // The second click of a double click merges into an update of the first; both surface
  // as recorderaction payloads, so a last-wins consumer ends up with count 2.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, count: number }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, count: number }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<button>Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).dblclick();

  await expect.poll(() => events.filter(e => e.action === 'click').map(e => e.count)).toEqual([1, 2]);
  await recordedContext.close();
});

test('should report the click count of a triple click', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, count: number }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, count: number }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<button>Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click({ clickCount: 3 });

  await expect.poll(() => events.filter(e => e.action === 'click').map(e => e.count)).toEqual([1, 2, 3]);
  await recordedContext.close();
});

test('should not duplicate a recorded click when the page re-fires it synthetically', async ({ context }) => {
  // An element-level interceptor re-fires the click via element.click() without
  // suppressing the original. The recorder sees the trusted click first (it
  // listens at document capture), records it, then must reject the synthetic
  // echo as a duplicate rather than recording a second click.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`
    <button id="accept">Accept</button>
    <script>
      const b = document.getElementById('accept');
      b.addEventListener('click', e => {
        if (e.isTrusted)
          setTimeout(() => b.click(), 50);
      });
    </script>
  `);
  await page.getByRole('button', { name: 'Accept' }).click();

  // Wait past the 2s echo window, then assert only one click was recorded.
  await page.waitForTimeout(2100);
  expect(events.filter(e => e.action === 'click')).toHaveLength(1);
  await recordedContext.close();
});

test('should still record a synthetic click echo when the trusted click was suppressed', async ({ context }) => {
  // A document-level interceptor suppresses the trusted click before it reaches
  // the recorder, then re-fires it synthetically (the cookie-consent pattern the
  // echo tolerance was built for). With no trusted click recorded, the echo must
  // still be accepted so the action is not lost — exactly one click recorded.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`
    <button id="accept">Accept</button>
    <script>
      const b = document.getElementById('accept');
      let refired = false;
      document.addEventListener('click', e => {
        if (e.isTrusted && !refired) {
          refired = true;
          e.stopImmediatePropagation();
          setTimeout(() => b.click(), 50);
        }
      }, true);
    </script>
  `);
  await page.getByRole('button', { name: 'Accept' }).click();

  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);
  await recordedContext.close();
});

test('should encode the mouse button and modifiers in the click value', async ({ context }) => {
  // The click value packs held modifiers and the mouse button as a '+'-separated
  // string with the button last, so a consumer can replay it straight back into
  // locator.click({ modifiers, button }).
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, value?: string }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, value?: string }) => events.push(payload));

  const page = await recordedContext.newPage();
  // Use distinct targets so the clicks do not merge into last-wins updates of a single action.
  await page.setContent(`<button>One</button><button>Two</button><button>Three</button><button>Four</button>`);
  await page.getByRole('button', { name: 'One' }).click();
  await page.getByRole('button', { name: 'Two' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Three' }).click({ button: 'middle' });
  // Avoid Control here: on macOS Control+click is the OS secondary click and would be
  // recorded as a right button. Alt+Shift exercises modifier encoding on all platforms.
  await page.getByRole('button', { name: 'Four' }).click({ modifiers: ['Alt', 'Shift'] });

  await expect.poll(() => events.filter(e => e.action === 'click').map(e => e.value))
      .toEqual(['left', 'right', 'middle', 'Alt+Shift+left']);
  await recordedContext.close();
});
