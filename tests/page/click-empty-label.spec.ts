/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Empty-label fallback (fork addition, see CUSTOM.md). A switch drawn by CSS on an empty label
// leaves the click nothing it can act on: the label has no box, the checkbox under it is at
// opacity 0. Once the retry loop has seen the label stay "not visible", the click lands where
// the control is drawn, provided the browser hit-tests the label or its control there.
//
// As for the covered-target fallback, refusals matter as much as the substitution: they must
// cost nothing and still fail on the caller's timeout, exactly as before this existed.
import { test as it, expect } from './pageTest';
import type { Page } from '@playwright/test';

// Bootstrap 4 custom-switch: an empty inline-block label whose ::before draws the track and
// ::after the knob, over the real checkbox at opacity 0.
const SWITCH_STYLE = `
  <style>
    body { font: 16px sans-serif; padding: 40px }
    .custom-control { position: relative; display: block; min-height: 1.5rem; padding-left: 2.25rem; margin-bottom: 16px }
    .custom-control-input { position: absolute; left: 0; z-index: -1; width: 1rem; height: 1.25rem; opacity: 0 }
    .custom-control-label { position: relative; display: inline-block; margin-bottom: 0; vertical-align: top }
    .custom-control-label::before { position: absolute; top: .25rem; left: -2.25rem; width: 1.75rem; height: 1rem; border-radius: .5rem; content: ""; background: #ccc }
    .custom-control-label::after { position: absolute; top: calc(.25rem + 2px); left: calc(-2.25rem + 2px); width: calc(1rem - 4px); height: calc(1rem - 4px); border-radius: .5rem; content: ""; background: #fff }
  </style>`;

function customSwitch(id: string, inputAttributes = '', type = 'checkbox', name = '') {
  return `<div class="custom-control custom-switch">
    <input type="${type}" class="custom-control-input" id="${id}" ${name ? `name="${name}"` : ''} ${inputAttributes}>
    <label class="custom-control-label" for="${id}"></label>
  </div>`;
}

// Counts `change` events per control and records where each click reached the document.
async function setPage(page: Page, server: any, body: string) {
  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`${SWITCH_STYLE}${body}`);
  await page.evaluate(() => {
    (window as any).changes = {};
    (window as any).clicks = [];
    document.addEventListener('change', event => {
      const id = (event.target as Element).id;
      (window as any).changes[id] = ((window as any).changes[id] ?? 0) + 1;
    }, true);
    document.addEventListener('click', event => (window as any).clicks.push({ x: event.clientX, trusted: event.isTrusted }), true);
  });
}

const changes = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (window as any).changes);
const clicks = (page: Page): Promise<{ x: number, trusted: boolean }[]> => page.evaluate(() => (window as any).clicks);

// A refusal is the failure that would have happened anyway: the same timeout, nothing toggled.
async function expectRefused(page: Page, click: Promise<unknown>) {
  const error = await click.catch(e => e);
  expect(error.message).toContain('Timeout 2000ms exceeded');
  expect(error.message).toContain('element is not visible');
  expect(await changes(page)).toEqual({});
}

it('should click where an empty label draws its switch', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw'));
  expect(await page.locator('label').boundingBox()).toEqual(expect.objectContaining({ width: 0, height: 0 }));

  await page.locator('label').click();
  expect(await page.locator('#sw').isChecked()).toBe(true);
  expect(await changes(page)).toEqual({ sw: 1 });
  // A real click, as the user's: trusted events, forwarded by the browser's own label activation.
  expect((await clicks(page))[0].trusted).toBe(true);
});

it('should toggle back on a second click', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw'));
  await page.locator('label').click();
  await page.locator('label').click();
  expect(await page.locator('#sw').isChecked()).toBe(false);
  expect(await changes(page)).toEqual({ sw: 2 });
});

it('should reach the switch through the hidden-input redirect', async ({ page, server }) => {
  // A click on the opacity-0 checkbox is redirected to its label, which is empty in turn.
  await setPage(page, server, customSwitch('sw'));
  await page.locator('#sw').click();
  expect(await page.locator('#sw').isChecked()).toBe(true);
  expect(await changes(page)).toEqual({ sw: 1 });
});

it('should select an empty-label custom radio', async ({ page, server }) => {
  await setPage(page, server, customSwitch('r1', '', 'radio', 'group') + customSwitch('r2', '', 'radio', 'group'));
  await page.locator('label[for=r2]').click();
  expect(await page.locator('#r2').isChecked()).toBe(true);
  expect(await page.locator('#r1').isChecked()).toBe(false);
});

it('should refuse when something else sits over the switch', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw') + `
    <div id="overlay" style="position:absolute;left:0;top:0;width:400px;height:200px;z-index:10"></div>`);
  await expectRefused(page, page.locator('label').click({ timeout: 2000 }));
  expect(await clicks(page)).toEqual([]);
});

it('should click the label itself when it gets a box while waiting', async ({ page, server }) => {
  // The restraint: a label still rendering is waited for, and the click it then gets is the
  // ordinary one, on the label, not one where its control is drawn.
  await setPage(page, server, customSwitch('sw') + `
    <script>setTimeout(() => document.querySelector('label').textContent = 'Toutes les factures', 100);</script>`);
  await page.locator('label').click();
  expect(await changes(page)).toEqual({ sw: 1 });
  const controlBox = await page.locator('#sw').boundingBox();
  expect((await clicks(page))[0].x).toBeGreaterThan(controlBox!.x + controlBox!.width);
});

it('should refuse when the control has no box', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw', 'style="display:none"'));
  await expectRefused(page, page.locator('label').click({ timeout: 2000 }));
});

it('should refuse when the control is disabled', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw', 'disabled'));
  await expectRefused(page, page.locator('label').click({ timeout: 2000 }));
  expect(await page.locator('#sw').isChecked()).toBe(false);
});

it('should refuse a click that is not a plain left single click', async ({ page, server }) => {
  await setPage(page, server, customSwitch('sw'));
  await expectRefused(page, page.locator('label').dblclick({ timeout: 2000 }));
  await expectRefused(page, page.locator('label').click({ timeout: 2000, modifiers: ['Shift'] }));
  await expectRefused(page, page.locator('label').click({ timeout: 2000, button: 'right' }));
});

it('should refuse an empty label inside a link', async ({ page, server }) => {
  await setPage(page, server, `<a href="#elsewhere">${customSwitch('sw')}</a>`);
  await expectRefused(page, page.locator('label').click({ timeout: 2000 }));
  expect(await page.evaluate(() => location.hash)).toBe('');
});

it('should leave the covered-target fallback working alongside', async ({ page, server }) => {
  // Both fallbacks on one page, each clicked through its own path: a hover-revealed cover
  // leading where its link leads, and an empty-label switch.
  await setPage(page, server, `
    <style>
      .tile { position: relative; width: 200px; height: 100px; margin: 300px 0 0 300px; }
      .underlay { position: absolute; inset: 0; z-index: 1; background: #eee; }
      .cover { position: absolute; inset: 0; z-index: 2; display: none; }
      .tile:hover .cover { display: block; }
      .fill { display: block; width: 100%; height: 100%; }
    </style>
    ${customSwitch('sw')}
    <div class="tile">
      <a class="underlay" href="#dest">underlay</a>
      <div class="cover"><a href="#dest"><span class="fill"></span></a></div>
    </div>`);

  await page.locator('label').click();
  expect(await changes(page)).toEqual({ sw: 1 });
  await page.locator('.underlay').click();
  // The page's own location: page.url() follows a same-document navigation a moment later.
  expect(await page.evaluate(() => location.hash)).toBe('#dest');
});
