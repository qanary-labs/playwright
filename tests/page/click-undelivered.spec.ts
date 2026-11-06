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

// Undelivered-click fallback (fork addition, see CUSTOM.md). A page that rewrites the element
// under a freshly arrived pointer leaves the browser holding a detached node as the one under
// the mouse, and a press made at once goes there: no pointer event reaches the document.
// Upstream reports that click as done. A plain click now retries with the pointer settled,
// and fails with an explicit reason if the press still never arrives.
import { test as it, expect } from './pageTest';
import type { Page } from '@playwright/test';

const PICTURE = `<img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='375'%3E%3Crect width='300' height='375' fill='gray'/%3E%3C/svg%3E" style="display:block;width:300px;height:375px">`;
const SLIDE = `<div style="position:relative;width:300px;height:375px">${PICTURE}</div>`;

// A store's product card: on mouseenter, the image area uncomments its next hidden slide by
// rewriting its whole innerHTML. One rewrite per arrival, and each rewrite
// replaces the node under the pointer, which the browser treats as a new arrival: a chain.
// `onEveryMove` also rewrites it on every move, the click's own included, so no press can
// ever land on a node that is still in the document.
function rewrittenCard(slides: number, onEveryMove = false) {
  const moveHandler = onEveryMove ? ` onmousemove="this.innerHTML = this.innerHTML"` : '';
  return `<script>
      function uncomment(e) {
        if (e.innerHTML.includes('<!--'))
          e.innerHTML = e.innerHTML.replace('<!--', '').replace('-->', '');
      }
    </script>
    <a id="card" href="#" style="display:block;width:300px">
      <div onmouseenter="uncomment(this)"${moveHandler} style="position:relative;width:300px;height:375px;overflow:hidden">
        ${SLIDE}
        ${`<!-- ${SLIDE} -->`.repeat(slides)}
      </div>
      <h3>Card</h3>
    </a>`;
}

// Records every pointer event that reaches the document, in the capture phase.
async function setPage(page: Page, server: any, body: string) {
  await page.goto(server.EMPTY_PAGE);
  await page.mouse.move(0, 0);
  await page.setContent(body);
  await page.evaluate(() => {
    (window as any).events = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu'])
      window.addEventListener(type, () => (window as any).events.push(type), true);
  });
}

const events = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).events);
const clicks = async (page: Page) => (await events(page)).filter(type => type === 'click').length;

it('loses a press made on arrival over a rewritten card', async ({ page, server, browserName }) => {
  it.skip(browserName !== 'chromium', 'the detached hover node is a Chromium behavior');
  // The fixture's own proof: without the fallback, this is the click Playwright reports as done.
  await setPage(page, server, rewrittenCard(7));
  await page.mouse.click(150, 200);
  expect(await events(page)).toEqual([]);
});

it('should deliver a click to a card rewritten on arrival', async ({ page, server }) => {
  await setPage(page, server, rewrittenCard(7));
  await page.locator('#card').click();
  // Exactly once: the lost attempt dispatched nothing, the settled one the whole click.
  expect(await clicks(page)).toBe(1);
  expect(await events(page)).toEqual(['pointerdown', 'mousedown', 'mouseup', 'click']);
});

it('should click an ordinary link once', async ({ page, server }) => {
  await setPage(page, server, `<a id="card" href="#" style="display:block;width:300px;height:300px;background:gray">Card</a>`);
  await page.locator('#card').click();
  expect(await clicks(page)).toBe(1);
});

it('should follow a link that navigates at once', async ({ page, server }) => {
  await setPage(page, server, `<a id="card" href="${server.PREFIX}/one-style.html">Go</a>`);
  await page.locator('#card').click();
  await expect(page).toHaveURL(server.PREFIX + '/one-style.html');
});

it('should fail with the reason when no pointer event reaches the page', async ({ page, server }) => {
  // A page whose own window capture listener, registered before Playwright's, stops every
  // pointer event: from Playwright's side, no press ever arrives. Upstream reports it as done.
  await page.addInitScript(() => {
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'auxclick', 'dblclick', 'contextmenu'])
      window.addEventListener(type, event => event.stopImmediatePropagation(), true);
  });
  server.setRoute('/card.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<a id="card" href="#" style="display:block;width:300px;height:300px;background:gray">Card</a>`);
  });
  await page.goto(server.PREFIX + '/card.html');
  const error = await page.locator('#card').click({ timeout: 3000 }).catch(e => e);
  // Never a silent success: the timeout, with what went wrong.
  expect(error.message).toContain('Timeout 3000ms exceeded');
  expect(error.message).toContain('click not delivered: no pointer event reached the page');
});

it('should keep upstream behavior for clicks that are not plain', async ({ page, server }) => {
  await setPage(page, server, rewrittenCard(7, true));
  // Double, right and modifier clicks are outside the fallback: no retry, no new error.
  await page.locator('#card').dblclick({ timeout: 3000 });
  await page.locator('#card').click({ button: 'right', timeout: 3000 });
  await page.locator('#card').click({ modifiers: ['Shift'], timeout: 3000 });
});

it('should keep upstream behavior for trial and force clicks', async ({ page, server }) => {
  await setPage(page, server, rewrittenCard(7, true));
  await page.locator('#card').click({ trial: true, timeout: 3000 });
  await page.locator('#card').click({ force: true, timeout: 3000 });
});
