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

// Covered-target substitution (fork addition, see CUSTOM.md). When a click has proved its
// target unreachable — the pointer's own arrival reveals a cover, and it survives every scroll
// alignment — and that cover leads exactly where the target leads, the click lands on the cover
// instead of failing.
//
// Two kinds of regression test matter here, because this makes click hit an element other than
// the one asked for:
//   - refusals, which must cost nothing and must still fail on the caller's timeout, exactly as
//     they did before this existed;
//   - restraint, where the click must land on the *target* because waiting or a locator handler
//     was about to work — substituting there would replace a click that would have been correct.
// Every cover is hover-revealed: one present at rest never proves the target unreachable, so a
// fixture built on it would refuse without the guards being consulted at all.
import { test as it, expect } from './pageTest';
import type { Page } from '@playwright/test';

const TILE_STYLE = `
  <style>
    /* Offset from the origin, where the pointer rests before any action: a tile there is
       hovered from the start, so its cover predates the pointer and is never recognised. */
    .tile { position: relative; width: 200px; height: 100px; margin: 300px 0 0 300px; }
    .underlay { position: absolute; inset: 0; z-index: 1; background: #eee; }
    .cover { position: absolute; inset: 0; z-index: 2; display: none; }
    .tile:hover .cover { display: block; }
    .fill { display: block; width: 100%; height: 100%; }
  </style>`;

// Records every click that reaches the document, named after the anchor it would activate.
// Refusal cases assert this stays empty; restraint cases assert it names the target.
async function installClickLog(page: Page) {
  await page.evaluate(() => {
    (window as any).clickLog = [];
    document.addEventListener('click', event => {
      // composedPath() is trimmed at a closed shadow root, hence the fallback label.
      const anchor = event.composedPath().find(node => (node as Element).localName === 'a') as HTMLElement | undefined;
      (window as any).clickLog.push(anchor?.dataset.name ?? 'unnamed');
    }, true);
  });
}

function clickLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).clickLog);
}

async function setTile(page: Page, server: any, body: string) {
  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`${TILE_STYLE}<div class="tile">${body}</div>`);
  await installClickLog(page);
}

// A refusal is the failure that would have happened anyway: same interception, same timeout,
// nothing clicked. The timeout assertion is the point — the substitution must never turn a
// doomed click into a faster one.
async function expectRefused(page: Page, options: Parameters<Page['click']>[1] = {}, selector = '.underlay') {
  const error = await page.locator(selector).click({ timeout: 2000, ...options }).catch(e => e);
  expect(error.message).toContain('Timeout 2000ms exceeded');
  expect(error.message).toContain('intercepts pointer events');
  expect(await clickLog(page)).toEqual([]);
}

it('should click a hover-revealed cover leading to the same destination', async ({ page, server }) => {
  // The production shape: hovering the tile to click it is what reveals the interceptor, so
  // the click defeats itself and retrying cannot converge.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>`);

  await page.locator('.underlay').click();
  expect(await clickLog(page)).toEqual(['cover']);
  expect(page.url()).toBe(server.EMPTY_PAGE + '#dest');
});

it('should follow the composed tree for slotted content', async ({ page, server }) => {
  // The hit element is a light-DOM node distributed into a slot inside the cover's anchor:
  // its composed-tree parent is that anchor, its light-DOM parent is the plain host div.
  // closest('a') would find nothing; the path a click is dispatched along finds the anchor.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div id="host" class="cover"><span class="fill" id="slotted"></span></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<a data-name="cover" href="#dest" style="display:block;height:100%"><slot></slot></a>';
    </script>`);

  expect(await page.evaluate(() => document.getElementById('slotted').closest('a'))).toBe(null);
  await page.locator('.underlay').click();
  expect(await clickLog(page)).toEqual(['cover']);
});

it('should click normally when the target is on top inside a shadow root', async ({ page, server }) => {
  // Nothing intercepts, so the click just works. Resolving that needs a descent into the
  // target's own shadow root: from outside, elementFromPoint reports the host, whose enclosing
  // anchor declares the very same destination — which would read as a same-destination cover
  // and substitute where a plain click lands fine.
  await setTile(page, server, `
    <a class="underlay" data-name="wrapper" href="#dest"><div id="host"></div></a>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<a data-name="inner" href="#dest" style="position:absolute;inset:0;z-index:3;display:block"></a>';
    </script>`);

  await page.locator('a[data-name=inner]').click();
  expect(await clickLog(page)).toEqual(['inner']);
});

it('should decide per click point', async ({ page, server }) => {
  // Same element, two points. The cover occupies only the top 40px of the 100px tile, so a
  // point under it substitutes while a point below it is not intercepted at all — the decision
  // follows the point the click actually uses, not the element.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover" style="bottom: auto; height: 40px"><a data-name="cover" href="#dest"><span class="fill" style="height: 40px"></span></a></div>`);

  await page.locator('.underlay').click({ position: { x: 10, y: 80 } });
  expect(await clickLog(page)).toEqual(['underlay']);

  // That click left the pointer on the tile, so the cover is already up: park it elsewhere so
  // the next click observes the reveal rather than inheriting it. See the parked-pointer test.
  await page.mouse.move(0, 0);
  await page.locator('.underlay').click({ position: { x: 10, y: 10 } });
  expect(await clickLog(page)).toEqual(['underlay', 'cover']);
});

it('should not change anything when nothing covers the target', async ({ page, server }) => {
  await setTile(page, server, `<a class="underlay" data-name="underlay" href="#dest">plain</a>`);

  await page.locator('.underlay').click();
  expect(await clickLog(page)).toEqual(['underlay']);
  expect(page.url()).toBe(server.EMPTY_PAGE + '#dest');
});

it('should let a cover that clears on its own be waited out', async ({ page, server }) => {
  // Same destination, so substituting would "work" — and would be wrong. The cover goes away
  // by itself, so the click was always going to reach the real target, and reaching the fifth
  // attempt takes at least the loop's own 0+20+100+100ms of waiting, which this outlives.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover" id="cover"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>
    <script>
      document.querySelector('.tile').addEventListener('mouseenter', () => {
        setTimeout(() => document.getElementById('cover').remove(), 150);
      }, { once: true });
    </script>`);

  await page.locator('.underlay').click();
  expect(await clickLog(page)).toEqual(['underlay']);
});

it('should let a locator handler win over substituting', async ({ page, server }) => {
  // The cover is re-shown by every mouseover and leads to the same destination, so substituting
  // would look like a success — but the handler is dismissing it and the real target becomes
  // reachable. A handler running resets the count, so the loop keeps letting it work. More
  // rounds than there are scroll alignments, so without that reset this would substitute.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div id="cover" style="position:absolute;inset:0;z-index:2;display:none"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>
    <script>
      let times = 8;
      document.querySelector('.tile').addEventListener('mouseover', () => {
        if (times-- > 0)
          document.getElementById('cover').style.display = 'block';
      });
    </script>`);
  // noWaitAfter: the click's own mouse move re-fires mouseover and re-shows the cover, so
  // waiting for it to stay hidden after the handler would never resolve.
  await page.addLocatorHandler(page.locator('#cover'), async () => {
    await page.evaluate(() => document.getElementById('cover').style.display = 'none');
  }, { noWaitAfter: true });

  await page.locator('.underlay').click({ timeout: 15000 });
  expect(await clickLog(page)).toEqual(['underlay']);
});

it('should refuse a cover that was already there', async ({ page, server }) => {
  // Same destination, but nothing proves the target unreachable: a cover present before the
  // pointer arrives may yet be escaped by a different scroll alignment or simply go away, so
  // the caller's timeout stays the only authority.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover" style="display: block"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>`);

  await expectRefused(page);
});

it('should refuse when the pointer was already parked on the target', async ({ page, server }) => {
  // A known limit, pinned deliberately. The evidence is a transition — clear before the
  // pointer arrives, intercepted once it has — so a cover already revealed by an earlier
  // action is indistinguishable from one that was always there.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>`);

  // Raw move, not locator.hover(): hover is a pointer action too, and would hit the same
  // interception this fixture is built to produce.
  const box = await page.locator('.underlay').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await expectRefused(page);
});

it('should refuse a cover whose anchor is inside a closed shadow root', async ({ page, server }) => {
  // A known limit, pinned deliberately. A closed root is opaque to everything outside it,
  // this chain included: the hit resolves to the host, which declares no destination. A real
  // click there would navigate, but nothing available can prove where to — so we decline.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div id="host" class="cover"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<a data-name="cover" href="#dest" style="display:block;height:100%"><span class="fill"></span></a>';
    </script>`);

  await expectRefused(page);
});

it('should refuse when the interceptor lives in an ancestor document', async ({ page, server }) => {
  // The element receiving the click would be one this frame's guard chain never inspects.
  // The parent's cover is caught by the frame check before the interceptor is even armed, so
  // it never counts as pointer-revealed and no substitution is ever offered.
  // The iframe is built in place: reparenting one reloads it and detaches the frame.
  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`${TILE_STYLE}<div class="tile">
      <iframe src="${server.EMPTY_PAGE}" style="position:absolute;inset:0;width:200px;height:100px;border:0;z-index:1"></iframe>
      <a class="cover" data-name="parent-cover" href="#dest" style="display:block"></a>
    </div>`);
  await installClickLog(page);
  const frame = page.frames()[1];
  await frame.setContent(`${TILE_STYLE}<a class="underlay" data-name="inner" href="#dest">inner</a>`);

  const error = await frame.locator('.underlay').click({ timeout: 2000 }).catch(e => e);
  expect(error.message).toContain('Timeout 2000ms exceeded');
  expect(await clickLog(page)).toEqual([]);
  expect(page.url()).toBe(server.EMPTY_PAGE);
});

it('should refuse a cover leading somewhere else', async ({ page, server }) => {
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"><a data-name="cover" href="#other"><span class="fill"></span></a></div>`);

  await expectRefused(page);
  expect(page.url()).toBe(server.EMPTY_PAGE);
});

it('should refuse a cover that is not a link', async ({ page, server }) => {
  // The shape of a cookie wall or a modal: on top, but with no destination to match.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"></div>`);

  await expectRefused(page);
});

it('should refuse when the target is not a link', async ({ page, server }) => {
  // A button covered by a same-href anchor: nothing says the button leads there too.
  await setTile(page, server, `
    <button class="underlay">underlay</button>
    <div class="cover"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>`);

  await expectRefused(page);
});

it('should refuse a cover opening a new tab', async ({ page, server }) => {
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"><a data-name="cover" href="#dest" target="_blank"><span class="fill"></span></a></div>`);

  await expectRefused(page);
});

it('should refuse anchors that do not lead anywhere', async ({ page, server }) => {
  // A bare '#' and a javascript: URL are the two "this anchor is really a button" idioms:
  // sharing one says nothing about where a click leads.
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="#">underlay</a>
    <div class="cover"><a data-name="cover" href="#"><span class="fill"></span></a></div>`);
  await expectRefused(page);

  // The refused click left the pointer on the tile, and the second fixture puts a tile at the
  // same coordinates: park the pointer so its cover is revealed rather than already up.
  await page.mouse.move(0, 0);
  await setTile(page, server, `
    <a class="underlay" data-name="underlay" href="javascript:void 0">underlay</a>
    <div class="cover"><a data-name="cover" href="javascript:void 0"><span class="fill"></span></a></div>`);
  await expectRefused(page);
});

it('should refuse for any click carrying more than "reach this destination"', async ({ page, server }) => {
  // The same fixture the first test accepts. A right, middle, modifier or double click means
  // something the cover cannot be assumed to do the same way, so none of them substitute.
  const fixture = `
    <a class="underlay" data-name="underlay" href="#dest">underlay</a>
    <div class="cover"><a data-name="cover" href="#dest"><span class="fill"></span></a></div>`;

  for (const options of [{ button: 'right' as const }, { button: 'middle' as const }, { clickCount: 2 }, { modifiers: ['Shift' as const] }]) {
    await page.mouse.move(0, 0);
    await setTile(page, server, fixture);
    await expectRefused(page, options);
  }
});
