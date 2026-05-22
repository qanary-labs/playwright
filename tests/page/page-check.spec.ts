/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
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

import { test as it, expect } from './pageTest';

it('should check the box @smoke', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
  await page.check('input');
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(true);
});

it('should not check the checked box', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox' checked></input>`);
  await page.check('input');
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(true);
});

it('should uncheck the box', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox' checked></input>`);
  await page.uncheck('input');
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(false);
});

it('should not uncheck the unchecked box', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
  await page.uncheck('input');
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(false);
});

it('should check radio', async ({ page }) => {
  await page.setContent(`
    <input type='radio'>one</input>
    <input id='two' type='radio'>two</input>
    <input type='radio'>three</input>`);
  await page.check('#two');
  expect(await page.evaluate(() => window['two'].checked)).toBe(true);
});

it('should check radio by aria role', async ({ page }) => {
  await page.setContent(`<div role='radio' id='checkbox'>CHECKBOX</div>
    <script>
      checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
    </script>`);
  await page.check('div');
  expect(await page.evaluate(() => window['checkbox'].getAttribute('aria-checked'))).toBe('true');
});

it('should uncheck radio by aria role', async ({ page }) => {
  await page.setContent(`<div role='radio' id='checkbox' aria-checked="true">CHECKBOX</div>
    <script>
      checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));
    </script>`);
  await page.uncheck('div');
  expect(await page.evaluate(() => window['checkbox'].getAttribute('aria-checked'))).toBe('false');
});

it('should check the box by aria role', async ({ page }) => {
  for (const role of ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem']) {
    await it.step(`role=${role}`, async () => {
      await page.setContent(`<div role='${role}' id='checkbox'>CHECKBOX</div>
        <script>
          checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
        </script>`);
      await page.check('div');
      expect(await page.evaluate(() => window['checkbox'].getAttribute('aria-checked'))).toBe('true');
    });
  }
});

it('should uncheck the box by aria role', async ({ page }) => {
  for (const role of ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem']) {
    await it.step(`role=${role}`, async () => {
      await page.setContent(`<div role='${role}' id='checkbox' aria-checked="true">CHECKBOX</div>
        <script>
          checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));
        </script>`);
      await page.uncheck('div');
      expect(await page.evaluate(() => window['checkbox'].getAttribute('aria-checked'))).toBe('false');
    });
  }
});

it('should throw when not a checkbox', async ({ page }) => {
  await page.setContent(`<div>Check me</div>`);
  const error = await page.check('div').catch(e => e);
  expect(error.message).toContain('Not a checkbox or radio button');
});

it('should throw when not a checkbox 2', async ({ page }) => {
  await page.setContent(`<div role=button>Check me</div>`);
  const error = await page.check('div').catch(e => e);
  expect(error.message).toContain('Not a checkbox or radio button');
});

it('should check the box inside a button', async ({ page }) => {
  await page.setContent(`<div role='button'><input type='checkbox'></div>`);
  await page.check('input');
  expect(await page.$eval('input', input => input.checked)).toBe(true);
  expect(await page.isChecked('input')).toBe(true);
  expect(await (await page.$('input')).isChecked()).toBe(true);
});

it('should check the label with position', async ({ page, server }) => {
  await page.setContent(`
    <input id='checkbox' type='checkbox' style='width: 5px; height: 5px;'>
    <label for='checkbox'>
      <a href=${JSON.stringify(server.EMPTY_PAGE)}>I am a long link that goes away so that nothing good will happen if you click on me</a>
      Click me
    </label>`);
  const box = await (await page.$('text=Click me')).boundingBox();
  await page.check('text=Click me', { position: { x: box.width - 10, y: 2 } });
  expect(await page.$eval('input', input => input.checked)).toBe(true);
});

it('should check the box when the input is hidden behind its label', async ({ page }) => {
  // Bootstrap-style custom checkbox: the <input> is visually hidden (opacity:0, z-index:-1),
  // and a sibling <label for="..."> is the visible clickable surface. Direct click on the
  // input fails the hit-test (the label intercepts pointer events), so check() redirects
  // the click to the label and the browser forwards it back to the input via the HTML
  // spec's label activation behavior.
  await page.setContent(`
    <style>
      .custom-control { position: relative; padding: 0.5rem 0 0.5rem 1.5rem; }
      .custom-control-input {
        position: absolute;
        left: 0;
        z-index: -1;
        width: 1rem;
        height: 1.25rem;
        opacity: 0;
      }
      .custom-control-label { display: inline-block; cursor: pointer; }
    </style>
    <div class="custom-control custom-checkbox">
      <input type="checkbox" class="custom-control-input" id="role">
      <label class="custom-control-label" for="role">
        <strong>Administrator</strong>
        <span>Role description spanning some width.</span>
      </label>
    </div>`);
  // Target the input directly — goes through the redirect path in _click.
  await page.check('#role');
  expect(await page.evaluate(() => window['role'].checked)).toBe(true);
  // Reset and target the label — no redirect, pure spec-defined label activation.
  await page.evaluate(() => { window['role'].checked = false; });
  await page.click('label[for=role]');
  expect(await page.evaluate(() => window['role'].checked)).toBe(true);
});

it('should check the box when wrapping label contains links', async ({ page }) => {
  // WooCommerce-style: visible <input> wrapped by a <label> that also contains <a> links.
  // Redirecting the click to the label's geometric center would land on a link, the HTML
  // spec then skips label activation, and the checkbox never toggles. Verify the click
  // goes to the input directly (no anchor click fires) and the box gets checked.
  await page.setContent(`
    <p class="form-row validate-required">
      <label class="woocommerce-form__label woocommerce-form__label-for-checkbox checkbox">
        <input type="checkbox" class="woocommerce-form__input woocommerce-form__input-checkbox input-checkbox" name="terms" id="terms">
        <span class="woocommerce-terms-and-conditions-checkbox-text">J'accepte les <a href="https://example.com/cgv/" target="_blank">Conditions générales de vente</a> &amp; la <a href="https://example.com/privacy/" target="_blank">Politique de confidentialité</a></span>&nbsp;<abbr class="required" title="obligatoire">*</abbr>
      </label>
    </p>
    <script>
      window['anchorClicks'] = 0;
      document.addEventListener('click', e => {
        if (e.target.closest('a')) {
          window['anchorClicks']++;
          e.preventDefault();
        }
      }, true);
    </script>`);
  await page.check('#terms');
  expect(await page.evaluate(() => window['terms'].checked)).toBe(true);
  expect(await page.evaluate(() => window['anchorClicks'])).toBe(0);
});

it('trial run should not check', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
  await page.check('input', { trial: true });
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(false);
});

it('trial run should not uncheck', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox' checked></input>`);
  await page.uncheck('input', { trial: true });
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(true);
});

it('should check the box using setChecked', async ({ page }) => {
  await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
  await page.setChecked('input', true);
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(true);
  await page.setChecked('input', false);
  expect(await page.evaluate(() => window['checkbox'].checked)).toBe(false);
});

it('should throw when trying to uncheck radio button', async ({ page }) => {
  await page.setContent(`<input type='radio' name='test' checked id='radio'>`);
  const error = await page.uncheck('#radio').catch(e => e);
  expect(error.message).toContain('Cannot uncheck radio button');
});
