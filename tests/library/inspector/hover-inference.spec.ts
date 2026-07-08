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

// Qanary fork — hover inference engine tests (packages/injected/src/recorder/hoverInference.ts).
// Each fixture reproduces a menu-hiding idiom found in the wild; the library or
// plugin that motivated it is noted per test. See zazu's docs/specs/hover-step-recording.md.

import { test, expect } from './inspectorTest';

import type { Page } from '@playwright/test';
import type * as actions from '@recorder/actions';

class RecorderLog {
  actions: (actions.ActionInContext & { code: string })[] = [];

  actionAdded(page: Page, actionInContext: actions.ActionInContext, code: string): void {
    this.actions.push({ ...actionInContext, code });
  }

  actionUpdated(page: Page, actionInContext: actions.ActionInContext, code: string): void {
    this.actions[this.actions.length - 1] = { ...actionInContext, code };
  }
}

async function startRecording(context) {
  const log = new RecorderLog();
  await (context as any)._enableRecorder({
    mode: 'recording',
    recorderMode: 'api',
  }, log);
  return log;
}

function names(log: RecorderLog): string[] {
  // Page creation records an openPage action; only the interactions matter here.
  return log.actions.map(a => a.action.name).filter(name => name !== 'openPage');
}

function hovers(log: RecorderLog) {
  return log.actions.filter(a => a.action.name === 'hover').map(a => a.action as actions.HoverAction);
}

// Give the engine time to process the reveal (rAF batch + any fade transition).
const SETTLE = 700;

test('should record an inferred hover when the next click depends on a revealed menu', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="products" onmouseenter="document.getElementById('menu').hidden = false">Products</button>
    <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0]).toEqual(expect.objectContaining({
    selector: 'internal:role=button[name="Products"i]',
    inferred: true,
  }));
});

test('should emit one hover per level of a nested menu, oldest first', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="products" onmouseenter="document.getElementById('menu').hidden = false">Products</button>
    <ul id="menu" hidden>
      <li id="software" onmouseenter="document.getElementById('submenu').hidden = false">Software
        <ul id="submenu" hidden><li><a href="#" id="ide">IDE</a></li></ul>
      </li>
    </ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.locator('#software').hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'IDE' }).click();

  expect(names(log)).toEqual(['hover', 'hover', 'click']);
  expect(hovers(log).map(h => h.selector)).toEqual([
    'internal:role=button[name="Products"i]',
    expect.stringContaining('Software'),
  ]);
});

test('should detect a class toggle on a pre-existing hidden menu (Bootstrap .show)', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>.menu { display: none; } .menu.show { display: block; }</style>
    <button id="team" onmouseenter="document.getElementById('menu').classList.add('show')">Team</button>
    <ul id="menu" class="menu"><li><a href="#" id="hire">Hire us</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Team' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Hire us' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Team"i]');
});

test('should detect a state class on the trigger revealing the menu via CSS (Beaver Builder)', async ({ context }) => {
  // Beaver Builder: JS toggles a class on the always-visible <li>; CSS shows the
  // hidden descendant. The mutated element itself never changes visibility.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>#menu { display: none; } li.focus > #menu { display: block; }</style>
    <ul><li id="item" onmouseenter="this.classList.add('focus')" onmouseleave="this.classList.remove('focus')">
      <a href="#top" id="brands">Brands</a>
      <ul id="menu"><li><a href="#" id="marine">Marine</a></li></ul>
    </li></ul>
  `);
  await page.getByRole('link', { name: 'Brands' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Marine' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=link[name="Brands"i]');
});

test('should detect an opacity fade menu settling after its transition', async ({ context }) => {
  // Fade mega menus: "hidden" is opacity: 0 + pointer-events: none at
  // full layout size, revealed by an ancestor class with a fade transition —
  // still at opacity ~0 one frame after the mutation.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      #menu { opacity: 0; pointer-events: none; transition: opacity 0.15s; }
      #wrap.open #menu { opacity: 1; pointer-events: auto; }
    </style>
    <div id="wrap" onmouseenter="this.classList.add('open')">
      <a href="#top" id="brands">Brands</a>
      <ul id="menu"><li><a href="#" id="marine">Marine</a></li></ul>
    </div>
  `);
  await page.getByRole('link', { name: 'Brands' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Marine' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].inferred).toBe(true);
});

test('should detect a visibility+opacity fade menu (JetMenu)', async ({ context }) => {
  // JetMenu: panel hidden with visibility: hidden + opacity: 0, flipped by a
  // state class on the <li> with a transition on both properties.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      #menu { visibility: hidden; opacity: 0; transition: opacity 0.15s, visibility 0.15s; }
      li.hover-state #menu { visibility: visible; opacity: 1; }
    </style>
    <ul><li id="item" onmouseenter="this.classList.add('hover-state')">
      <a href="#top" id="products">Products</a>
      <ul id="menu"><li><a href="#" id="kits">Kits</a></li></ul>
    </li></ul>
  `);
  await page.getByRole('link', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Kits' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=link[name="Products"i]');
});

test('should detect a pure-CSS menu hidden by off-screen positioning', async ({ context }) => {
  // WordPress themes hide .sub-menu at left: -9999px and a pure
  // :hover rule moves it on-screen — no JS, no mutation, no transition. The
  // menu is displayed, opaque and full-size the whole time; only its position
  // changes, so this exercises both the off-screen visibility model and the
  // pointer-entry watch-list poll.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      li { position: relative; display: inline-block; }
      .sub-menu { position: absolute; left: -9999px; top: 100%; }
      li:hover > .sub-menu { left: 0; }
    </style>
    <ul><li>
      <a href="#top" id="groupe">Le Groupe</a>
      <ul class="sub-menu"><li><a href="#" id="paris">Agence Paris</a></li></ul>
    </li></ul>
  `);
  await page.getByRole('link', { name: 'Le Groupe' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Agence Paris' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0]).toEqual(expect.objectContaining({
    selector: 'internal:role=link[name="Le Groupe"i]',
    inferred: true,
  }));
});

test('should detect a pure-CSS display-flip menu on dwell (Suckerfish)', async ({ context }) => {
  // The classic `li:hover > ul { display: block }` menu: zero mutations, zero
  // transitions. Caught by the dwell-time document sweep.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      li { position: relative; display: inline-block; }
      .sub-menu { display: none; position: absolute; top: 100%; left: 0; }
      li:hover > .sub-menu { display: block; }
    </style>
    <ul><li>
      <a href="#top" id="services">Services</a>
      <ul class="sub-menu"><li><a href="#" id="seo">SEO</a></li></ul>
    </li></ul>
  `);
  await page.getByRole('link', { name: 'Services' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'SEO' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0]).toEqual(expect.objectContaining({
    selector: 'internal:role=link[name="Services"i]',
    inferred: true,
  }));
});

test('should not treat a display:contents wrapper as revealed content', async ({ context }) => {
  // Tailwind's `.contents`: boxless per checkVisibility,
  // yet its children render. The dwell sweep must not "reveal" it — any later
  // click inside the wrapper would confirm a spurious hover.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <span id="label">Just text</span>
    <div style="display: contents"><button id="cta">Buy</button></div>
  `);
  await page.getByText('Just text').hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('button', { name: 'Buy' }).click();

  expect(names(log)).toEqual(['click']);
});

test('should detect a re-hover after the menu closed as a CSS side effect (JetMenu re-hover)', async ({ context }) => {
  // JetMenu: closing the menu removes the state class from the <li>; the
  // panel re-hides purely via CSS and never mutates itself (animation: none, so
  // no transitionend either). Without re-registering it as hidden, every reveal
  // after the first is undetectable once a committed action has flushed the
  // candidate stack.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      #menu { opacity: 0; visibility: hidden; pointer-events: none; }
      li.hovered #menu { opacity: 1; visibility: visible; pointer-events: auto; }
    </style>
    <ul><li id="item" onmouseenter="this.classList.add('hovered')" onmouseleave="this.classList.remove('hovered')">
      <a href="#top" id="products">Products</a>
      <ul id="menu"><li><a href="#" id="kits">Kits</a></li></ul>
    </li></ul>
    <button id="other" style="margin-left: 400px">Other</button>
  `);
  // First hover opens the menu, but the user clicks elsewhere: the close
  // re-hides the panel as a side effect, and the click flushes the candidates.
  await page.getByRole('link', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('button', { name: 'Other' }).click();
  await page.waitForTimeout(SETTLE);
  // Second hover must still be detected.
  await page.getByRole('link', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Kits' }).click();

  expect(names(log)).toEqual(['click', 'hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=link[name="Products"i]');
});

test('should survive an AJAX menu replacing its loader with the rendered content (JetMenu template)', async ({ context }) => {
  // JetMenu first hover of a session: the mega panel opens EMPTY (zero-height
  // — not yet a reveal), a loader mounts (reveal root = the loader, attributed
  // to the trigger), then the AJAX-rendered Elementor template REPLACES the
  // loader. The disconnected root must fall back to its mount container instead
  // of costing the trigger candidate, and the replacement content must count as
  // growth inside the revealed region, not as a fresh reveal attributed to
  // whatever panel-internal element the pointer sits on.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <style>
      #panel { position: absolute; visibility: hidden; opacity: 0; pointer-events: none; }
      li.hovered #panel { visibility: visible; opacity: 1; pointer-events: auto; }
    </style>
    <ul><li id="item" onmouseenter="this.classList.add('hovered'); window.__load && __load()" onmouseleave="this.classList.remove('hovered')">
      <a href="#top" id="products">Products</a>
      <div id="panel"></div>
    </li></ul>
    <script>
      let loaded = false;
      window.__load = () => {
        if (loaded) return; loaded = true;
        setTimeout(() => { document.getElementById('panel').innerHTML = '<div id="loader">loading…</div>'; }, 100);
        setTimeout(() => { document.getElementById('panel').innerHTML = '<ul><li><a href="#" id="kits">Kits</a></li></ul>'; }, 600);
      };
    </script>
  `);
  await page.getByRole('link', { name: 'Products' }).hover();
  await page.waitForTimeout(600 + SETTLE);
  await page.getByRole('link', { name: 'Kits' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=link[name="Products"i]');
});

test('should keep the trigger candidate when the AJAX menu empties before re-rendering', async ({ context }) => {
  // JetMenu, fast interaction on a fresh session: the pointer waits inside
  // the (still empty) panel while JetMenu renders. The panel is emptied in one
  // tick and filled in a later one — the removal-only batch must not expire the
  // trigger candidate (its only revealed root, the loader, disconnects), or the
  // re-rendered content has no candidate to confirm and only a bare click is
  // recorded.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <ul style="list-style: none; padding: 0 40px"><li id="item" style="position: relative; display: inline-block; padding: 12px">
      <a href="#top" id="products">Products</a>
      <div id="panel" style="position: absolute; top: 100%; left: 0"></div>
    </li></ul>
  `);
  await page.getByRole('link', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.evaluate(() => { document.getElementById('panel').innerHTML = '<div id="loader">loading…</div>'; });
  await page.waitForTimeout(SETTLE);
  // The user's pointer moves onto the loader, waiting for the content.
  await page.locator('#loader').hover();
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('panel').innerHTML = ''; });
  await page.waitForTimeout(SETTLE);
  await page.evaluate(() => { document.getElementById('panel').innerHTML = '<ul><li><a href="#" id="kits">Kits</a></li></ul>'; });
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Kits' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=link[name="Products"i]');
});

test('should attribute a late reveal to the trigger even when the pointer parks over dead space', async ({ context }) => {
  // Impatient pointers leave the trigger and wait over empty page area for slow
  // menu content; headed browsers also interleave stray OS-cursor events on
  // <body>. Neither must anchor the reveal: a recorded hover on <body> replays
  // as a no-op and the menu never opens.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <div style="height: 30px">
      <button id="products" style="margin-left: 200px"
        onmouseenter="setTimeout(() => document.getElementById('menu').hidden = false, 700)">Products</button>
    </div>
    <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(100);
  // The pointer wanders onto bare <body> below the content and rests there
  // while the menu content is still on its way.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(700 + SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should infer hovers when a page script swallows window-level mousemoves (CookieYes)', async ({ context }) => {
  // CookieYes pre-consent: real mousemoves are captured on window,
  // stopImmediatePropagation'd, and re-dispatched as synthetic copies. Page
  // menus still open (their handlers run on the synthetic stream and ignore
  // isTrusted), but document-level listeners never see a trusted move — the
  // engine's pointer feed must win the capture order at the window level.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <script>
      window.addEventListener('mousemove', e => {
        if (!e.isTrusted) return;
        e.stopImmediatePropagation();
        e.target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: e.clientX, clientY: e.clientY }));
      }, true);
    </script>
    <button id="products" onmouseenter="document.getElementById('menu').hidden = false">Products</button>
    <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should discard candidates when the next action does not depend on the reveal', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <span id="info" onmouseenter="if (!document.getElementById('tip')) { const t = document.createElement('div'); t.id = 'tip'; t.textContent = 'tooltip'; document.body.appendChild(t); }">Info</span>
    <button id="other" style="margin-left: 300px">Other</button>
  `);
  await page.getByText('Info').hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('button', { name: 'Other' }).click();

  expect(names(log)).toEqual(['click']);
});

test('should not attribute a click-opened menu to the hover that preceded the click', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="account" onclick="document.getElementById('menu').hidden = false">Account</button>
    <ul id="menu" hidden><li><a href="#" id="logout">Log out</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Account' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Log out' }).click();

  expect(names(log)).toEqual(['click', 'click']);
});

test('should flush showing candidates through the embedder global before an assertion', async ({ context }) => {
  // Assertions bypass the recorder: the embedder pings every frame's
  // __pw_recorderFlushInferredHovers() before screenshotting (tooltip checks).
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <span id="info" onmouseenter="if (!document.getElementById('tip')) { const t = document.createElement('div'); t.id = 'tip'; t.textContent = 'tooltip'; document.body.appendChild(t); }">Info</span>
  `);
  await page.getByText('Info').hover();
  await page.waitForTimeout(SETTLE);
  await page.evaluate('window.__pw_recorderFlushInferredHovers()');
  await expect.poll(() => names(log)).toEqual(['hover']);
  expect(hovers(log)[0].inferred).toBe(true);
});

test('hover() should complete the real-mouse handshake required by SmartMenus-style menus', async ({ context }) => {
  // Replay-side regression (fork's dom.ts _hover): SmartMenus opens
  // hover submenus only after two consecutive mousemoves ≤2px apart within 300ms.
  // A plain teleport hover never satisfies that; the fork's hover nudges the
  // pointer one pixel out and back.
  const page = await context.newPage();
  await page.setContent(`
    <button id="trigger">Products</button>
    <ul id="menu" hidden><li><a href="#" id="item">Pricing</a></li></ul>
    <script>
      let mouseMode = false;
      let last = null;
      document.addEventListener('mousemove', e => {
        const now = Date.now();
        if (last) {
          const dx = Math.abs(e.pageX - last.x), dy = Math.abs(e.pageY - last.y);
          if ((dx > 0 || dy > 0) && dx <= 2 && dy <= 2 && now - last.t <= 300)
            mouseMode = true;
        }
        last = { x: e.pageX, y: e.pageY, t: now };
      });
      document.getElementById('trigger').addEventListener('mousemove', () => {
        if (mouseMode)
          document.getElementById('menu').hidden = false;
      });
    </script>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await expect(page.locator('#menu')).toBeVisible();
});

test('hover() should satisfy travel-based intent gates by entering across the element boundary', async ({ context }) => {
  // Replay-side regression (fork's dom.ts _hover): travel-based intent detectors
  // ignore both the teleport move and the ±1px handshake nudge — the menu opens
  // only after sustained pointer travel over the trigger, and only reliably when
  // the pointer enters the element across its boundary while moving. The fork's
  // hover re-enters the element: it jumps just outside the nearest vertical edge
  // and walks back to the hover point in small steps.
  const page = await context.newPage();
  await page.setContent(`
    <button id="trigger" style="margin: 40px">Products</button>
    <ul id="menu" hidden><li><a href="#" id="item">Pricing</a></li></ul>
    <script>
      let travel = 0, last = null;
      const trigger = document.getElementById('trigger');
      trigger.addEventListener('mousemove', e => {
        if (last)
          travel += Math.abs(e.pageX - last.x) + Math.abs(e.pageY - last.y);
        last = { x: e.pageX, y: e.pageY };
        if (travel >= 8)
          document.getElementById('menu').hidden = false;
      });
      trigger.addEventListener('mouseleave', () => { travel = 0; last = null; });
    </script>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await expect(page.locator('#menu')).toBeVisible();
});

test('should detect menus hidden by stylesheets that apply after load (WP Rocket)', async ({ context }) => {
  // WP Rocket: async-loaded CSS (media="print" onload flip) hides the
  // menu AFTER the engine's initial invisibility seeding, with no DOM mutation on
  // the menu itself. The engine re-seeds on window load and on the first pointer
  // move, so the later hover reveal is still recognized.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="products" onmouseenter="document.getElementById('menu').classList.add('show')">Products</button>
    <ul id="menu"><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  // The hiding CSS lands well after load — the menu was "visible" at seed time.
  await page.waitForTimeout(300);
  await page.addStyleTag({ content: '#menu { display: none; } #menu.show { display: block; }' });
  await page.waitForTimeout(200);

  // A real pointer always approaches before hovering; the first move triggers the re-seed.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should detect menus hidden by a stylesheet injected after the first pointer move', async ({ context }) => {
  // WP Rocket on a cold cache: the hiding CSS applies after
  // DOMContentLoaded, window load AND the first pointer move — after every
  // scheduled re-seed. The menu was seeded "visible", so without re-seeding on
  // stylesheet arrival no reveal path can ever fire.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="products" onmouseenter="document.getElementById('menu').classList.add('show')">Products</button>
    <ul id="menu"><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  // The first pointer move happens while the menu is still unstyled…
  await page.mouse.move(400, 300);
  await page.waitForTimeout(100);
  // …and only then does the hiding CSS land (Remove Unused CSS injects <style>).
  await page.addStyleTag({ content: '#menu { display: none; } #menu.show { display: block; }' });
  await page.waitForTimeout(200);

  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should detect menus hidden by a media="print" stylesheet flipped after the first pointer move', async ({ context }) => {
  // The classic WP Rocket async-CSS delivery: the stylesheet is fetched with
  // media="print" (inert) and flipped to media="all" in its onload — the flip,
  // not the load, is when the hiding rules apply.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.route('**/late.css', async route => {
    await new Promise(f => setTimeout(f, 500));
    await route.fulfill({ contentType: 'text/css', body: '#menu { display: none; } #menu.show { display: block; }' });
  });
  await page.setContent(`
    <link rel="stylesheet" href="https://stub.test/late.css" media="print" onload="this.media='all'">
    <button id="products" onmouseenter="document.getElementById('menu').classList.add('show')">Products</button>
    <ul id="menu"><li><a href="#" id="pricing">Pricing</a></li></ul>
  `, { waitUntil: 'domcontentloaded' });
  // Pointer starts moving before the CSS has been fetched and flipped.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should detect menus inside zero-height containers with visible overflow', async ({ context }) => {
  // Elementor: the header computes 1440×0 while its nav
  // overflows it visibly. Zero-size must not make the seed walk treat the
  // container as an invisible boundary, or nothing inside the header ever gets
  // seeded and menu reveals go unnoticed.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <header style="height: 0; overflow: visible">
      <nav>
        <button id="products" onmouseenter="document.getElementById('menu').hidden = false">Products</button>
        <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
      </nav>
    </header>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should survive a revealed menu blinking through a hidden state before the click', async ({ context }) => {
  // JetMenu: panels dip through visibility:hidden while the
  // pointer crosses from the trigger into the panel (animation restarts). A rAF
  // batch catching that dip must not expire the candidate — the following click
  // inside the panel is the proof the hover mattered.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <button id="products"
      onmouseenter="const m = document.getElementById('menu'); m.hidden = false;
        setTimeout(() => { m.style.visibility = 'hidden'; setTimeout(() => { m.style.visibility = ''; }, 80); }, 150);">
      Products</button>
    <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE); // blink happens in here
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0].selector).toBe('internal:role=button[name="Products"i]');
});

test('should surface the inferred flag on the recorderaction payload', async ({ context }) => {
  // Locks in the client layer: _simplifyRecordedAction (browserContext.ts) must
  // carry `inferred` into the flattened RecorderActionPayload consumers see.
  const recordedContext = await context.browser().newContext({ recordSelectors: true });
  const events: { action: string, inferred?: boolean }[] = [];
  recordedContext.on('recorderaction' as any, (payload: { action: string, inferred?: boolean }) => events.push(payload));

  const page = await recordedContext.newPage();
  await page.setContent(`
    <button id="products" onmouseenter="document.getElementById('menu').hidden = false">Products</button>
    <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  await expect.poll(() => events.map(e => e.action)).toEqual(['hover', 'click']);
  expect(events[0].inferred).toBe(true);
  expect(events[1].inferred).toBeUndefined();
  await recordedContext.close();
});

test('should detect a reveal inside an open shadow root', async ({ context }) => {
  // The document-level mutation observer cannot see into shadow trees; the
  // engine observes shadow roots discovered while seeding and along the
  // pointer's composed path.
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = \`
        <button id="products">Products</button>
        <ul id="menu" hidden><li><a href="#" id="pricing">Pricing</a></li></ul>
      \`;
      root.getElementById('products').addEventListener('mouseenter', () => {
        root.getElementById('menu').hidden = false;
      });
    </script>
  `);
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('link', { name: 'Pricing' }).click();

  expect(names(log)).toEqual(['hover', 'click']);
  expect(hovers(log)[0]).toEqual(expect.objectContaining({
    selector: 'internal:role=button[name="Products"i]',
    inferred: true,
  }));
});

test('should not record hovers for pauses over inert elements', async ({ context }) => {
  const log = await startRecording(context);
  const page = await context.newPage();
  await page.setContent(`
    <p id="text">Some long paragraph the user reads while parking the cursor.</p>
    <button id="go">Go</button>
  `);
  await page.getByText('Some long paragraph').hover();
  await page.waitForTimeout(SETTLE);
  await page.getByRole('button', { name: 'Go' }).click();

  expect(names(log)).toEqual(['click']);
});
