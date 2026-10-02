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

// Document-space center of the recorded element (zazu's self-healing spec): viewport
// rect center plus the frame's scroll offset, on the retargeted element, for every
// locator-bearing action — not only clicks. Replay hit-tests it to tell apart elements
// the selectors no longer distinguish.
async function documentCenter(page: Page, selector: string, frame?: string): Promise<{ x: number, y: number }> {
  const target = frame ? page.frameLocator(frame).locator(selector) : page.locator(selector);
  return target.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 + window.scrollX, y: rect.top + rect.height / 2 + window.scrollY };
  });
}

test('records the recorded element\'s document-space center on click, fill, check and select', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="btn" style="position:absolute;left:100px;top:50px;width:120px;height:40px">Go</button>
    <input id="name" style="position:absolute;left:300px;top:50px;width:200px;height:30px" />
    <input id="agree" type="checkbox" style="position:absolute;left:100px;top:150px;width:20px;height:20px" />
    <select id="lang" style="position:absolute;left:300px;top:150px;width:120px;height:30px"><option value="fr">fr</option><option value="en">en</option></select>`);
  await page.locator('#btn').click();
  await page.locator('#name').fill('alice');
  await page.locator('#agree').check();
  await page.locator('#lang').selectOption('en');

  expect((log.action('click')[0].action as any).point).toEqual({ x: 160, y: 70 });
  expect((log.action('fill')[0].action as any).point).toEqual(await documentCenter(page, '#name'));
  // The checkbox keeps the browser's default margin, so its box is not where `left`/`top` say.
  expect((log.action('check')[0].action as any).point).toEqual(await documentCenter(page, '#agree'));
  expect((log.action('select')[0].action as any).point).toEqual(await documentCenter(page, '#lang'));
});

test('records the point of the retargeted element, not of the pressed child', async ({ context }) => {
  // The icon is at the far left of the link; the point is the link's own center,
  // like positionRatio is relative to the link — the selectors name the link.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <a id="lnk" href="#" style="position:absolute;left:100px;top:100px;display:inline-block;width:200px;height:40px;padding:0">
      <i id="ico" style="position:absolute;left:0;top:14px;width:12px;height:12px;background:#000"></i>
    </a>`);
  await page.locator('#ico').click();

  const action = log.action('click')[0].action as any;
  expect(action.selector).toBe('#lnk');
  expect(action.point).toEqual({ x: 200, y: 120 });
});

test('records no point when there is nothing to measure', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <form onsubmit="return false">
      <input id="user" type="text" />
      <button id="go" type="submit">Go</button>
    </form>
    <input id="tiny" style="position:absolute;width:0;height:0;padding:0;border:0" />`);
  await page.locator('#user').fill('alice');
  await page.locator('#user').press('Enter');
  // A keyboard-driven click has no pointer, but the button is a real box: it gets a point.
  const submitClick = log.action('click').find(a => (a.action as any).clickCount === 0);
  expect(submitClick).toBeTruthy();
  expect((submitClick!.action as any).point).toEqual(await documentCenter(page, '#go'));

  // A box with no area has no center to record: typed into through the keyboard, since
  // nothing can be clicked there.
  await page.evaluate(() => (document.getElementById('tiny') as HTMLInputElement).focus());
  await page.keyboard.type('a');
  const fill = log.action('fill').find(a => (a.action as any).selector.includes('tiny'));
  expect(fill).toBeTruthy();
  expect((fill!.action as any).point).toBeUndefined();
});

test('records the point in document coordinates: a scrolled click keeps its unscrolled position', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <div style="height:3000px"></div>
    <button id="deep" style="position:absolute;left:40px;top:2500px;width:100px;height:40px">Deep</button>
    <div style="height:1000px"></div>`);
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.locator('#deep').click();

  const action = log.action('click')[0].action as any;
  expect(action.point).toEqual({ x: 90, y: 2520 });
});

test('records the point in the element\'s own frame coordinates', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <div style="height:300px"></div>
    <iframe id="frame1" style="position:absolute;left:500px;top:300px;width:400px;height:200px" srcdoc="<button id='inner' style='position:absolute;left:20px;top:30px;width:60px;height:20px'>Go</button>"></iframe>`);
  // The recorder lands in the child document asynchronously, shortly after it commits.
  const frame = page.frames()[1];
  await expect.poll(() => frame.evaluate(() => typeof (window as any).__pw_resolveAll === 'function')).toBe(true);
  await page.frameLocator('#frame1').locator('#inner').click();
  await expect.poll(() => log.action('click')).toHaveLength(1);

  const action = log.action('click')[0].action as any;
  // The iframe's own document: not offset by the frame's position in the parent.
  expect(action.point).toEqual({ x: 50, y: 40 });
});

test('forwards the point on the recorder action payload', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));
  const page = await recordedContext.newPage();
  await page.setContent(`<button id="btn" style="position:absolute;left:10px;top:20px;width:100px;height:40px">Go</button>`);
  await page.locator('#btn').click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);
  expect(events[0].point).toEqual({ x: 60, y: 40 });
  await recordedContext.close();
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
  type Payload = { action: string, selectors: { selector: string, score: number }[], role?: string, text?: string };
  const events: Payload[] = [];
  recordedContext.on('recorderaction' as any, (payload: Payload) => events.push(payload));

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

// Every recorded action as '<action> <first selector>', so a spurious check/uncheck shows
// up as clearly as a spurious click.
async function recordActions(context) {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const actions: string[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, selectors: { selector: string }[] }) => {
    actions.push(`${payload.action} ${payload.selectors[0]?.selector}`);
  });
  return { recordedContext, actions };
}

// The forwarded click arrives within the same task as the label click, so once the label
// click is in, a short settle is enough to prove nothing follows it.
async function expectSettled(actions: string[], expected: string[]) {
  await expect.poll(() => actions).toEqual(expected);
  await new Promise(f => setTimeout(f, 300));
  expect(actions).toEqual(expected);
}

for (const { name, control } of [
  { name: 'text input', control: '<input id="c" type="text">' },
  { name: 'textarea', control: '<textarea id="c"></textarea>' },
  { name: 'button', control: '<button id="c" type="button">Go</button>' },
  { name: 'checkbox', control: '<input id="c" type="checkbox">' },
  { name: 'radio', control: '<input id="c" type="radio" name="r">' },
]) {
  test(`should record a click on the label of a ${name} once, not again on the control`, async ({ context }) => {
    // A click on a <label> makes the browser dispatch a second, trusted click on the
    // labelled control (the label's activation behavior). That click is a consequence of
    // the one just recorded — replaying the label click re-creates it — so recording it
    // too replays one user click as two, the second aimed at a control the label may cover.
    // For a checkbox or radio the second click would surface as a check/uncheck step.
    const { recordedContext, actions } = await recordActions(context);
    const page = await recordedContext.newPage();
    await page.setContent(`<label for="c">Title</label>${control}`);
    await page.getByText('Title').click();

    await expectSettled(actions, ['click internal:text="Title"i']);
    await recordedContext.close();
  });

  test(`should record a click on a label wrapping a ${name} once`, async ({ context }) => {
    // Implicit association: the browser forwards to the first labelable descendant.
    const { recordedContext, actions } = await recordActions(context);
    const page = await recordedContext.newPage();
    await page.setContent(`<label><span>Title</span> ${control.replace(' id="c"', '')}</label>`);
    await page.getByText('Title').click();

    await expect.poll(() => actions).toHaveLength(1);
    await new Promise(f => setTimeout(f, 300));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatch(/^click /);
    await recordedContext.close();
  });
}

test('should record a click on a floating label covering its input once', async ({ context }) => {
  // The shape found in production: the label sits over the input until the field is
  // focused, so a replayed click on the input would be intercepted by the label.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`
    <div style="position:relative;width:400px">
      <label for="c" style="position:absolute;left:8px;top:12px;z-index:1">Give a title</label>
      <input id="c" type="text" style="width:400px;height:48px">
    </div>`);
  expect(await page.locator('#c').evaluate(input => {
    const box = input.getBoundingClientRect();
    return document.elementFromPoint(box.left + 40, box.top + box.height / 2)?.localName;
  })).toBe('label');
  await page.getByText('Give a title').click();

  await expectSettled(actions, ['click internal:text="Give a title"i']);
  await recordedContext.close();
});

test('should record a click on the label of a visually hidden checkbox once', async ({ context }) => {
  // Custom-control pattern: the real input is invisible and only the label is clicked.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`
    <input id="c" type="checkbox" style="position:absolute;opacity:0;width:1px;height:1px">
    <label for="c">Accept</label>`);
  await page.getByText('Accept').click();

  await expectSettled(actions, ['click internal:text="Accept"i']);
  expect(await page.locator('#c').isChecked()).toBe(true);
  await recordedContext.close();
});

test('should record a click on the label of a checked checkbox once when it unchecks it', async ({ context }) => {
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<input id="c" type="checkbox" checked><label for="c">Accept</label>`);
  await page.getByText('Accept').click();

  await expectSettled(actions, ['click internal:text="Accept"i']);
  expect(await page.locator('#c').isChecked()).toBe(false);
  await recordedContext.close();
});

test('should record clicks on radio labels in a group once each', async ({ context }) => {
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`
    <input id="a" type="radio" name="g"><label for="a">Alpha</label>
    <input id="b" type="radio" name="g"><label for="b">Beta</label>`);
  await page.getByText('Alpha').click();
  await page.getByText('Beta').click();

  await expectSettled(actions, ['click internal:text="Alpha"i', 'click internal:text="Beta"i']);
  await recordedContext.close();
});

test('should record a check and an uncheck for direct clicks on a checkbox', async ({ context }) => {
  // No label involved: the checkbox branch records the state change, not a click.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Accept</label><input id="c" type="checkbox">`);
  await page.locator('#c').click();
  await page.locator('#c').click();

  await expectSettled(actions, ['check internal:role=checkbox[name="Accept"i]', 'uncheck internal:role=checkbox[name="Accept"i]']);
  await recordedContext.close();
});

test('should record a check for a direct click on a radio', async ({ context }) => {
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Alpha</label><input id="c" type="radio" name="g">`);
  await page.locator('#c').click();

  await expectSettled(actions, ['check internal:role=radio[name="Alpha"i]']);
  await recordedContext.close();
});

test('should record a check for a direct click on a checkbox inside its label', async ({ context }) => {
  // The browser forwards nothing when the click lands on the control itself.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label>Accept <input id="c" type="checkbox"></label>`);
  await page.locator('#c').click();

  await expectSettled(actions, ['check internal:role=checkbox[name="Accept"i]']);
  await recordedContext.close();
});

test('should still record a click on a text input inside its label', async ({ context }) => {
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label>Title <input id="c" type="text"></label>`);
  await page.locator('#c').click();

  await expectSettled(actions, ['click internal:role=textbox[name="Title"i]']);
  await recordedContext.close();
});

test('should still record a user click on the control right after a click on its label', async ({ context }) => {
  // Two physical clicks, two recorded clicks: only the browser's forwarded click is dropped.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Title</label><input id="c" type="text">`);
  await page.getByText('Title').click();
  await page.locator('#c').click();

  await expectSettled(actions, ['click internal:text="Title"i', 'click internal:role=textbox[name="Title"i]']);
  await recordedContext.close();
});

test('should still record a click on the control when its label prevented the forwarding', async ({ context }) => {
  // A label click whose default is prevented forwards nothing, so the next click on the
  // control — here a keyboard activation, which carries no pointer — is the user's own.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`
    <label for="c" onclick="event.preventDefault()">Title</label><button id="c" type="button">Go</button>`);
  await page.getByText('Title').click();
  await page.locator('#c').focus();
  await page.keyboard.press('Enter');

  await expect.poll(() => actions).toContain('click internal:role=button[name="Title"i]');
  expect(actions[0]).toBe('click internal:text="Title"i');
  await recordedContext.close();
});

test('should record a double click on a label without the forwarded clicks', async ({ context }) => {
  // Each click of the pair is forwarded; only the label's own clicks are recorded, as a
  // repeated click on the label (last-wins consumers keep the count of 2).
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Title</label><input id="c" type="text">`);
  await page.getByText('Title').dblclick();

  await expect.poll(() => actions.length).toBeGreaterThan(0);
  await new Promise(f => setTimeout(f, 300));
  expect(new Set(actions)).toEqual(new Set(['click internal:text="Title"i']));
  await recordedContext.close();
});

test('should record a check for the keyboard toggle of a focused checkbox', async ({ context }) => {
  // Space on a checkbox dispatches a trusted click with detail 0 and no pointer: it is the
  // user's toggle and records as one, like a pointer click on the checkbox.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Accept</label><input id="c" type="checkbox">`);
  await page.locator('#c').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');

  await expectSettled(actions, ['check internal:role=checkbox[name="Accept"i]', 'uncheck internal:role=checkbox[name="Accept"i]']);
  await recordedContext.close();
});

test('should record a check for the keyboard selection of a radio', async ({ context }) => {
  // Arrow keys move the selection within a radio group by clicking the next radio.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`
    <input id="a" type="radio" name="g"><label for="a">Alpha</label>
    <input id="b" type="radio" name="g"><label for="b">Beta</label>`);
  await page.locator('#a').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');

  await expect.poll(() => actions).toEqual(expect.arrayContaining(['check internal:role=radio[name="Alpha"i]', 'check internal:role=radio[name="Beta"i]']));
  await new Promise(f => setTimeout(f, 300));
  expect(actions.filter(a => !a.startsWith('press '))).toEqual(['check internal:role=radio[name="Alpha"i]', 'check internal:role=radio[name="Beta"i]']);
  expect(await page.locator('#b').isChecked()).toBe(true);
  await recordedContext.close();
});

test('should record a check and an uncheck for a double click on a checkbox', async ({ context }) => {
  // Each click of the pair toggles the checkbox, so each records its state change.
  const { recordedContext, actions } = await recordActions(context);
  const page = await recordedContext.newPage();
  await page.setContent(`<label for="c">Accept</label><input id="c" type="checkbox">`);
  await page.locator('#c').dblclick();

  await expectSettled(actions, ['check internal:role=checkbox[name="Accept"i]', 'uncheck internal:role=checkbox[name="Accept"i]']);
  expect(await page.locator('#c').isChecked()).toBe(false);
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

test('generateSelectors matches what recording the same element emits', async ({ context }) => {
  // Relocate-mode parity contract (zazu's relocate-mode spec): on-demand generation and
  // capture-time generation are the same feature — same engine, same options — so for the
  // same element they must return identical ranked lists.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, selectors: { selector: string, score: number }[], frameSelectors?: { selector: string, score: number }[][] }[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<button id="submit">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  const generated = await page.locator('#submit').generateSelectors();
  expect(generated.selectors).toEqual(events[0].selectors);
  expect(generated.selectors.length).toBeGreaterThan(1);
  expect(generated.frameSelectors).toEqual([]);
  await recordedContext.close();
});

test('generateSelectors returns the frame chain for elements inside iframes', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, selectors: { selector: string, score: number }[], frameSelectors?: { selector: string, score: number }[][] }[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<iframe id="frame1" srcdoc="<button id='inner'>Go</button>"></iframe>`);
  const button = page.frameLocator('#frame1').locator('#inner');
  await button.click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  const generated = await button.generateSelectors();
  expect(generated.selectors).toEqual(events[0].selectors);
  expect(generated.frameSelectors).toEqual(events[0].frameSelectors);
  expect(generated.frameSelectors).toHaveLength(1);
  // A hop carries the same scored shape an element does (weighted-locator-generation
  // spec): candidates for that one iframe, strongest first, on the engine's own scale.
  const hop = generated.frameSelectors[0];
  expect(hop.length).toBeGreaterThan(0);
  for (const entry of hop) {
    expect(typeof entry.selector).toBe('string');
    expect(entry.score).toBeGreaterThan(0);
  }
  expect(hop.map(e => e.score)).toEqual([...hop.map(e => e.score)].sort((a, b) => a - b));
  expect(hop.map(e => e.selector)).toContain('#frame1');
  await recordedContext.close();
});

test('generateSelectors promotes to the interactive ancestor and needs no recorder', async ({ context }) => {
  // Plain context — no recordSelectors, no recorder session: generation lives on core
  // InjectedScript. The icon resolves to the enclosing button exactly like a fresh
  // recording of a click on the icon would.
  const page = await context.newPage();
  await page.setContent(`<button id="btn"><span id="icon">star</span></button>`);
  const forIcon = await page.locator('#icon').generateSelectors();
  const forButton = await page.locator('#btn').generateSelectors();
  expect(forIcon.selectors).toEqual(forButton.selectors);
  expect(forIcon.selectors.length).toBeGreaterThan(1);
});

test('records the scored selector set on every action payload', async ({ context }) => {
  // zazu's weighted-locator-generation spec: an action payload carries exactly one
  // locator field, the scored set - which entry to lead with is the consumer's call, so
  // the payload names no primary. That the set is a superset of what the engine's own
  // enumeration produces is an engine guarantee, asserted in selector-generator.spec.ts.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`
    <main>
      <div class="row" data-row="7">
        <a class="row__link" href="/item/7">Open 7</a>
      </div>
    </main>`);
  await page.getByRole('link', { name: 'Open 7' }).click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  const { selector, selectors } = events[0];
  expect(selector).toBeUndefined();
  expect(selectors.length).toBeGreaterThan(1);
  for (const entry of selectors) {
    expect(typeof entry.selector).toBe('string');
    expect(entry.score).toBeGreaterThan(0);
  }
  // Scores are the engine's: lower is stronger, and the list is sorted by them.
  const scores = selectors.map((entry: any) => entry.score);
  expect(scores).toEqual([...scores].sort((a: number, b: number) => a - b));
  // The point of the exercise: something that outlives the link's text changing.
  expect(selectors.some((entry: any) => !entry.selector.includes('Open 7'))).toBe(true);
  await recordedContext.close();
});

test('still names a step when only the scored set carries a role', async ({ context }) => {
  // `role`/`text` are read from the engine's primary first and from the scored set after,
  // now that the unscored list no longer travels on the action. Here the test id wins the
  // primary and both buttons share a name, so the metadata has to come out of the scored
  // set - the path the payload compaction changed.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`
    <div name="row-7"><button data-testid="buy-7">Buy</button></div>
    <div name="row-8"><button data-testid="buy-8">Buy</button></div>`);
  await page.locator('[data-testid="buy-7"]').click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  const roleBearing = events[0].selectors.filter((entry: any) => entry.selector.includes('internal:role=button'));
  expect(roleBearing.length).toBeGreaterThan(0);
  expect(events[0].role).toBe('button');
  expect(events[0].text).toBe('Buy');
  await recordedContext.close();
});

test('records at most the requested number of selectors', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: { max: 3 } });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<button id="submit" class="btn cta" data-testid="submit" title="Submit">Submit</button>`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  expect(events[0].selectors.length).toBeGreaterThan(0);
  expect(events[0].selectors.length).toBeLessThanOrEqual(3);
  await recordedContext.close();
});

test('generateSelectors returns the same scored set a recording of that element carries', async ({ context }) => {
  // The relocate-mode parity contract, extended to the scored set: same engine, same
  // options, same budget default - so an old test relocated matches a fresh recording.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`<div class="box"><button id="submit" class="cta">Submit</button></div>`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(1);

  const generated = await page.locator('#submit').generateSelectors();
  expect(generated.selectors).toEqual(events[0].selectors);
  expect(generated.selectors.length).toBeGreaterThan(1);

  // A smaller budget takes the strongest entries, in the same order.
  const narrowed = await page.locator('#submit').generateSelectors({ maxSelectors: 2 });
  expect(narrowed.selectors).toEqual(generated.selectors.slice(0, 2));
  await recordedContext.close();
});

test('generateSelectors rejects when the locator is ambiguous or resolves to nothing', async ({ context }) => {
  context.setDefaultTimeout(1000);
  const page = await context.newPage();
  await page.setContent(`<div class="x"></div><div class="x"></div>`);
  await expect(page.locator('.x').generateSelectors()).rejects.toThrow(/strict mode violation/);
  await expect(page.locator('#missing').generateSelectors()).rejects.toThrow(/Timeout/);
});

// `window.__pw_resolveAll` — the consensus binding (zazu's consensus-locator-resolution
// spec): one atomic resolution pass over a step's selectors, meant to be polled.
async function resolveAll(target: Page | import('@playwright/test').Frame, selectors: string[], stableMs: number, token: string) {
  return await target.evaluate(([selectors, stableMs, token]) => (window as any).__pw_resolveAll(selectors, stableMs, token), [selectors, stableMs, token] as const);
}

test('resolveAll names the element each selector matched, and nothing for a non-unique one', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const page = await recordedContext.newPage();
  await page.setContent(`<div class="x"><button id="go" class="y">Go</button></div><div class="y"></div>`);
  // stableMs 0 decides on the current pass, whatever its history.
  const pass = await resolveAll(page, ['#go', 'internal:role=button[name="Go"i]', '.y', '#missing', 'bogus:engine'], 0, 't1');
  expect(pass).toEqual({ matches: [
    { id: 0, count: 1 },
    { id: 0, count: 1 },     // same node as #go: same id
    { id: null, count: 2 },  // ambiguous: names nothing
    { id: null, count: 0 },  // dead
    { id: null, count: 0 },  // unparsable: dead, not an exception
  ], ancestors: [[]] });
  await recordedContext.close();
});

test('resolveAll reports which uniquely-matched elements contain which', async ({ context }) => {
  // A wrapper and the control inside it are one target seen at two depths; a consumer
  // ranking disagreeing groups must be able to tell that from two unrelated elements.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const page = await recordedContext.newPage();
  await page.setContent(`<div id="wrap"><span id="mid"><button id="go">Go</button></span></div><button id="other">Other</button>`);
  const pass = await resolveAll(page, ['#wrap', '#go', '#other', '#mid'], 0, 't');
  expect(pass).toEqual({
    matches: [{ id: 0, count: 1 }, { id: 1, count: 1 }, { id: 2, count: 1 }, { id: 3, count: 1 }],
    ancestors: [
      [],       // #wrap: contained by nothing matched
      [0, 3],   // #go: inside #wrap and #mid
      [],       // #other: unrelated
      [0],      // #mid: inside #wrap
    ],
  });
  await recordedContext.close();
});

test('resolveAll withholds a decision until the agreement pattern has held for stableMs', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const page = await recordedContext.newPage();
  await page.setContent(`<button id="go">Go</button>`);
  const selectors = ['#go', 'internal:role=button[name="Go"i]', '#later'];

  expect(await resolveAll(page, selectors, 150, 'step-1')).toBeNull();
  await expect.poll(() => resolveAll(page, selectors, 150, 'step-1')).not.toBeNull();

  // A signature change restarts the clock: a selector that starts matching is new evidence.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<span id="later"></span>'));
  expect(await resolveAll(page, selectors, 150, 'step-1')).toBeNull();
  await expect.poll(() => resolveAll(page, selectors, 150, 'step-1')).toEqual({ matches: [
    { id: 0, count: 1 }, { id: 0, count: 1 }, { id: 1, count: 1 },
  ], ancestors: [[], []] });

  // The clock is keyed by token: a later step whose resolution coincides never inherits
  // the earlier step's stability.
  expect(await resolveAll(page, selectors, 150, 'step-2')).toBeNull();
  await expect.poll(() => resolveAll(page, selectors, 150, 'step-2')).not.toBeNull();

  // Nodes may be replaced under a stable pattern: a keyed re-render does not reset it.
  await page.evaluate(() => document.body.innerHTML = document.body.innerHTML);
  expect(await resolveAll(page, selectors, 150, 'step-2')).not.toBeNull();
  await recordedContext.close();
});

test('resolveAll keeps polling while no selector resolves uniquely', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const page = await recordedContext.newPage();
  await page.setContent(`<div class="x"></div><div class="x"></div>`);
  const selectors = ['#missing', '.x'];
  expect(await resolveAll(page, selectors, 150, 't')).toBeNull();
  await page.waitForTimeout(300);
  // Nothing to decide on, however long it has been that way — only the caller's ceiling ends this.
  expect(await resolveAll(page, selectors, 150, 't')).toBeNull();
  expect(await resolveAll(page, selectors, 0, 't')).toEqual({ matches: [{ id: null, count: 0 }, { id: null, count: 2 }], ancestors: [] });
  await recordedContext.close();
});

test('resolveAll is installed in child frames', async ({ context }) => {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const page = await recordedContext.newPage();
  await page.setContent(`<iframe id="frame1" srcdoc="<button id='inner'>Go</button>"></iframe>`);
  const frame = page.frames()[1];
  // The recorder lands in a new document asynchronously, shortly after it commits.
  await expect.poll(() => resolveAll(frame, ['#inner'], 0, 't').catch(() => 'not installed yet')).toEqual({ matches: [{ id: 0, count: 1 }], ancestors: [[]] });
  await recordedContext.close();
});

// zazu's press-class-recording spec: a class the page adds while the element is pressed
// describes the gesture, not the element. Replay resolves before the click, when the class
// is not there yet, so a locator built on it is dead from the day it is recorded.
async function recordClickSelectors(context, html: string, click: (page: Page) => Promise<void>, count = 1): Promise<string[][]> {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));
  const page = await recordedContext.newPage();
  await page.setContent(html);
  await click(page);
  await expect.poll(() => events.filter(e => e.action === 'click')).toHaveLength(count);
  await recordedContext.close();
  return events.filter(e => e.action === 'click').map(e => e.selectors.map((entry: any) => entry.selector));
}

test('leaves out a class the page adds to the clicked element on mousedown', async ({ context }) => {
  // The roche-bobois shape: two buttons share their classes at rest, so the press class is
  // what made a class combination unique to the pressed one.
  const [selectors] = await recordClickSelectors(context, `
    <div class="pos-s"><button class="btn-full add-to-cart" aria-label="Ajouter au panier">Ajouter au panier</button></div>
    <button class="btn-full add-to-cart" aria-label="Ajouter au panier">Ajouter au panier</button>
    <script>
      for (const b of document.querySelectorAll('.add-to-cart'))
        b.addEventListener('mousedown', () => b.classList.add('click-hide-focus'));
    </script>`, page => page.locator('.pos-s button').click());
  expect(selectors.length).toBeGreaterThan(0);
  expect(selectors.filter(s => s.includes('click-hide-focus'))).toEqual([]);
});

test('leaves out a press class in the structural fallback too', async ({ context }) => {
  // Elements with no role, text or attribute fall back to CSS paths, a second place classes
  // are read.
  const [selectors] = await recordClickSelectors(context, `
    <span class="tile" style="display:inline-block;width:40px;height:40px"></span>
    <span class="tile" style="display:inline-block;width:40px;height:40px"></span>
    <script>
      for (const t of document.querySelectorAll('.tile'))
        t.addEventListener('mousedown', () => t.classList.add('tile--pressed'));
    </script>`, page => page.locator('.tile').first().click());
  expect(selectors.length).toBeGreaterThan(0);
  expect(selectors.filter(s => s.includes('tile--pressed'))).toEqual([]);
});

test('leaves out a class the page adds to an ancestor of the clicked element on mousedown', async ({ context }) => {
  // Chains are collected for a target that is unique on its own; the wrapper becomes a
  // unique anchor only through its press class, so that is the chain it must not get.
  const [selectors] = await recordClickSelectors(context, `
    <div class="wrap"><button>Go</button></div>
    <div class="wrap"><button>Stop</button></div>
    <script>
      for (const b of document.querySelectorAll('button'))
        b.addEventListener('mousedown', () => b.closest('.wrap').classList.add('is-active'));
    </script>`, page => page.getByRole('button', { name: 'Go' }).click());
  expect(selectors.length).toBeGreaterThan(0);
  expect(selectors.filter(s => s.includes('is-active'))).toEqual([]);
});

test('keeps the classes an element had before the press', async ({ context }) => {
  const [selectors] = await recordClickSelectors(context, `
    <button class="only-me">One</button>
    <button class="other">Two</button>`, page => page.getByRole('button', { name: 'One' }).click());
  expect(selectors.some(s => s.includes('only-me'))).toBe(true);
});

test('keeps a class toggled during the press that the element had before it', async ({ context }) => {
  // The page removes `ready` on pointerdown and puts it back on mousedown: the snapshot is
  // taken before the page's own pointerdown handlers run, so it holds `ready`.
  const [selectors] = await recordClickSelectors(context, `
    <span class="ready" style="display:inline-block;width:40px;height:40px"></span>
    <span style="display:inline-block;width:40px;height:40px"></span>
    <script>
      const ready = document.querySelector('.ready');
      ready.addEventListener('pointerdown', () => ready.classList.remove('ready'));
      ready.addEventListener('mousedown', () => ready.classList.add('ready'));
    </script>`, page => page.locator('.ready').click());
  expect(selectors.some(s => s.includes('ready'))).toBe(true);
});

test('takes the snapshot per press: a class kept from an earlier press is part of the element at the next one', async ({ context }) => {
  // The first press adds `was-pressed` and the page keeps it. At the second press it is
  // the element's state at rest, so the second click may use it, and the first may not.
  const [first, second] = await recordClickSelectors(context, `
    <button class="btn">Save</button>
    <button class="btn">Save</button>
    <script>
      const b = document.querySelector('.btn');
      b.addEventListener('mousedown', () => b.classList.add('was-pressed'));
    </script>`, async page => {
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.getByRole('button', { name: 'Save' }).first().click();
  }, 2);
  expect(first.filter(s => s.includes('was-pressed'))).toEqual([]);
  expect(second.some(s => s.includes('was-pressed'))).toBe(true);
});

// Hover part of the same spec: classes the page adds when the pointer enters an element are
// just as absent at replay, which resolves before the action moves the pointer there.
async function recordEvents(context, html: string, act: (page: Page) => Promise<void>, actions: string[], only?: string): Promise<{ action: string, selectors: string[] }[]> {
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: any[] = [];
  recordedContext.on('recorderaction' as any, (payload: any) => events.push(payload));
  const page = await recordedContext.newPage();
  await page.setContent(html);
  await act(page);
  const kept = () => events.filter(e => !only || e.action === only);
  await expect.poll(() => kept().map(e => e.action)).toEqual(actions);
  await recordedContext.close();
  return kept().map(e => ({ action: e.action, selectors: e.selectors.map((entry: any) => entry.selector) }));
}

test('leaves out a class the page adds to the clicked element on mouseenter', async ({ context }) => {
  // The date-picker shape: day cells sharing their classes, the one under the pointer
  // highlighted, so the highlight is what makes a class combination unique.
  const [click] = await recordEvents(context, `
    <span class="day" style="display:inline-block;width:40px;height:40px">1</span>
    <span class="day" style="display:inline-block;width:40px;height:40px">1</span>
    <script>
      for (const d of document.querySelectorAll('.day')) {
        d.addEventListener('mouseenter', () => d.classList.add('is-highlighted'));
        d.addEventListener('mouseleave', () => d.classList.remove('is-highlighted'));
      }
    </script>`, page => page.locator('.day').first().click(), ['click']);
  expect(click.selectors.length).toBeGreaterThan(0);
  expect(click.selectors.filter(s => s.includes('is-highlighted'))).toEqual([]);
});

test('leaves out a class the page adds to an ancestor of the clicked element on mouseover', async ({ context }) => {
  // The row becomes a unique anchor only through its hover class.
  const [click] = await recordEvents(context, `
    <div class="row"><button>Go</button></div>
    <div class="row"><button>Stop</button></div>
    <script>
      for (const r of document.querySelectorAll('.row'))
        r.addEventListener('mouseover', () => r.classList.add('row--hover'));
    </script>`, page => page.getByRole('button', { name: 'Go' }).click(), ['click']);
  expect(click.selectors.length).toBeGreaterThan(0);
  expect(click.selectors.filter(s => s.includes('row--hover'))).toEqual([]);
});

test('leaves out a hover class when the page re-renders the hovered element', async ({ context }) => {
  // The ngx-bootstrap date-picker shape: hovering a day rebuilds the rows, so the day under the
  // pointer is a new node, created already highlighted. It inherits the snapshot of the node it
  // replaced. Only the click matters: WebKit's timing also lets the hover-inference engine read
  // the rebuilt rows as content the hover revealed, and record a hover on them.
  const [click] = await recordEvents(context, `
    <table><tbody id="days"></tbody></table>
    <script>
      let hovered = -1;
      function render() {
        const cell = i => '<td><span class="day' + (i === hovered ? ' is-highlighted' : '') + '" data-i="' + i + '" style="display:inline-block;width:40px;height:40px">1</span></td>';
        document.getElementById('days').innerHTML = '<tr>' + cell(0) + cell(1) + '</tr>';
        for (const d of document.querySelectorAll('.day'))
          d.addEventListener('mouseenter', () => { const i = +d.dataset.i; if (i !== hovered) { hovered = i; render(); } });
      }
      render();
    </script>`, page => page.locator('.day').first().click(), ['click'], 'click');
  expect(click.selectors.length).toBeGreaterThan(0);
  expect(click.selectors.filter(s => s.includes('is-highlighted'))).toEqual([]);
});

const MENUS = `
  <style>.menu { display: none; } .menu.show { display: block; }</style>
  <button class="nav-trigger nav-products">Products</button><ul class="menu"><li><a href="#">Pricing</a></li></ul>
  <button class="nav-trigger">Company</button><ul class="menu"><li><a href="#">Team</a></li></ul>
  <script>
    for (const t of document.querySelectorAll('.nav-trigger'))
      t.addEventListener('mouseenter', () => { t.classList.add('is-hovered'); t.nextElementSibling.classList.add('show'); });
  </script>`;

test('leaves out a hover class from an inferred hover step', async ({ context }) => {
  // "Company" has no class of its own: only its hover class makes a class combination unique.
  const [hover] = await recordEvents(context, MENUS, async page => {
    await page.getByRole('button', { name: 'Company' }).hover();
    await page.waitForTimeout(700);
    await page.getByRole('link', { name: 'Team' }).click();
  }, ['hover', 'click']);
  expect(hover.selectors.length).toBeGreaterThan(0);
  expect(hover.selectors.filter(s => s.includes('is-hovered'))).toEqual([]);
});

test('keeps the classes an element had before the pointer arrived', async ({ context }) => {
  // `nav-products` is there at rest: the inferred hover may still use it.
  const [hover] = await recordEvents(context, MENUS, async page => {
    await page.getByRole('button', { name: 'Products' }).hover();
    await page.waitForTimeout(700);
    await page.getByRole('link', { name: 'Pricing' }).click();
  }, ['hover', 'click']);
  expect(hover.selectors.some(s => s.includes('nav-products'))).toBe(true);
});

test('takes the snapshot at rest per entry: a hover class kept after leaving is part of the element next time', async ({ context }) => {
  // The page keeps `was-hovered` once added. The first click leaves it out; after the pointer
  // left and came back, it is the element's state at rest, and the second click may use it.
  const [first, second] = await recordEvents(context, `
    <button class="btn">Save</button>
    <button class="btn">Save</button>
    <script>
      const b = document.querySelector('.btn');
      b.addEventListener('mouseenter', () => b.classList.add('was-hovered'));
    </script>`, async page => {
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: 'Save' }).first().click();
  }, ['click', 'click']);
  expect(first.selectors.filter(s => s.includes('was-hovered'))).toEqual([]);
  expect(second.selectors.some(s => s.includes('was-hovered'))).toBe(true);
});
