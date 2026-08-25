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

import { contextTest as it, expect } from '../config/browserTest';
import type { Page, Frame } from 'playwright-core';

async function generate(pageOrFrame: Page | Frame, target: string, expected?: string): Promise<string> {
  return pageOrFrame.$eval(target, (e, expected) => {
    const playwright = (window as any).playwright;
    const selector = playwright.selector(e);
    const expectedTarget = expected ? playwright.$(expected) : e;
    if (playwright.$(selector) === expectedTarget)
      return selector;
    return 'FAILED: ' + selector;
  }, expected);
}

async function generateMultiple(pageOrFrame: Page | Frame, target: string): Promise<string> {
  return pageOrFrame.$eval(target, e => (window as any).__injectedScript.generateSelector(e, { multiple: true, testIdAttributeName: 'data-testid' }).selectors);
}

it.describe('selector generator', () => {
  it.skip(({ mode }) => mode !== 'default');

  it.beforeEach(async ({ context, page }) => {
    // Make sure `page`(fixture) is created before enabling recorder, so that
    // we properly wait for `extendInjectedScript` call to finish. Otherwise
    // if the page is created later, there is a race between ConsoleAPI
    // initialization and playwright.selector(e) call in `generate()` function above.
    await (context as any)._enableRecorder({ language: 'javascript' });
  });

  it('should prefer button over inner span', async ({ page }) => {
    await page.setContent(`<button><span>text</span></button>`);
    expect(await generate(page, 'span', 'button')).toBe('internal:role=button[name="text"i]');
  });

  it('should prefer role=button over inner span', async ({ page }) => {
    await page.setContent(`<div role=button><span>text</span></div>`);
    expect(await generate(page, 'span', 'div')).toBe('internal:role=button[name="text"i]');
  });

  it('should not prefer zero-sized button over inner span', async ({ page }) => {
    await page.setContent(`
      <button style="width:0;height:0;padding:0;border:0;overflow:visible;">
        <span style="width:100px;height:100px;">text</span>
      </button>
    `);
    expect(await generate(page, 'span')).toBe('internal:text="text"i');
  });

  it('should generate text and normalize whitespace', async ({ page }) => {
    await page.setContent(`<div>Text  some\n\n\n more \t text   </div>`);
    expect(await generate(page, 'div')).toBe('internal:text="Text some more text"i');
  });

  it('should not escape spaces inside named attr selectors', async ({ page }) => {
    await page.setContent(`<input placeholder="Foo b ar"/>`);
    expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"Foo b ar\"i]');
  });

  it('should generate text for <input type=button>', async ({ page }) => {
    await page.setContent(`<input type=button value="Click me">`);
    expect(await generate(page, 'input')).toBe('internal:role=button[name=\"Click me\"i]');
  });

  it('should trim text', async ({ page }) => {
    await page.setContent(`
      <div>Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789</div>
      <div>Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789!Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789</div>
    `);
    expect(await generate(page, 'div')).toBe('internal:text="Text0123456789Text0123456789Text0123456789Text0123456789Text0123456789Text012345"i');
  });

  it('should try to improve role name', async ({ page }) => {
    await page.setContent(`<div role=button>Issues 23</div>`);
    expect(await generate(page, 'div')).toBe('internal:role=button[name="Issues"i]');
  });

  it('should use description when name is not unique', async ({ page }) => {
    await page.setContent(`
      <button aria-description="Upload report">Submit</button>
      <button aria-description="Upload photo">Submit</button>
    `);
    expect(await generate(page, 'button[aria-description="Upload report"]')).toBe('internal:role=button[name="Submit"i][description="Upload report"s]');
    expect(await generate(page, 'button[aria-description="Upload photo"]')).toBe('internal:role=button[name="Submit"i][description="Upload photo"s]');
  });

  it('should not use description when name is unique', async ({ page }) => {
    await page.setContent(`
      <button aria-description="Some description">Submit</button>
      <button aria-description="Other description">Cancel</button>
    `);
    expect(await generate(page, 'button[aria-description="Some description"]')).toBe('internal:role=button[name="Submit"i]');
  });

  it('should use description from aria-describedby', async ({ page }) => {
    await page.setContent(`
      <span id="desc1">Save form data</span>
      <span id="desc2">Save as draft</span>
      <button aria-describedby="desc1">Submit</button>
      <button aria-describedby="desc2">Submit</button>
    `);
    expect(await generate(page, 'button[aria-describedby="desc1"]')).toBe('internal:role=button[name="Submit"i][description="Save form data"s]');
    expect(await generate(page, 'button[aria-describedby="desc2"]')).toBe('internal:role=button[name="Submit"i][description="Save as draft"s]');
  });

  it('should fall back to nth when name and description are both not unique', async ({ page }) => {
    await page.setContent(`
      <button aria-description="Same desc">Submit</button>
      <button aria-description="Same desc">Submit</button>
    `);
    expect(await generate(page, 'button:first-of-type')).toBe('internal:role=button[name="Submit"i] >> nth=0');
  });

  it('should use description when role has no name', async ({ page }) => {
    await page.setContent(`
      <div role="alert" aria-description="Error in field A"></div>
      <div role="alert" aria-description="Error in field B"></div>
    `);
    expect(await generate(page, 'div[aria-description="Error in field A"]')).toBe('internal:role=alert[description="Error in field A"s]');
    expect(await generate(page, 'div[aria-description="Error in field B"]')).toBe('internal:role=alert[description="Error in field B"s]');
  });

  it('should try to improve text', async ({ page }) => {
    await page.setContent(`<div>23 Issues</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="Issues"i');
  });

  it('should try to improve text by shortening', async ({ page }) => {
    await page.setContent(`<div>Longest verbose description of the item</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="Longest verbose description"i');
  });

  it('should try to improve label text by shortening', async ({ page }) => {
    await page.setContent(`<label>Longest verbose description of the item<input></label>`);
    expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"Longest verbose description\"i]');
  });

  it('should not improve guid text', async ({ page }) => {
    await page.setContent(`<div>91b1b23</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="91b1b23"i');
  });

  it('should not escape text with >>', async ({ page }) => {
    await page.setContent(`<div>text&gt;&gt;text</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="text>>text"i');
  });

  it('should escape text with quote', async ({ page }) => {
    await page.setContent(`<div>text"text</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="text\\\"text"i');
  });

  it('should escape text with slash', async ({ page }) => {
    await page.setContent(`<div>/text</div>`);
    expect(await generate(page, 'div')).toBe('internal:text="\/text"i');
  });

  it('should not use text for select', async ({ page }) => {
    await page.setContent(`
      <select><option>foo</option></select>
      <select mark=1><option>bar</option></select>
    `);
    expect(await generate(page, '[mark="1"]')).toBe('internal:role=combobox >> nth=1');
  });

  it('should use ordinal for identical nodes', async ({ page }) => {
    await page.setContent(`<div>Text</div><div>Text</div><div mark=1>Text</div><div>Text</div>`);
    expect(await generate(page, 'div[mark="1"]')).toBe(`internal:text="Text"i >> nth=2`);
  });

  it('should prefer data-testid', async ({ page }) => {
    await page.setContent(`<div>Text</div><div>Text</div><div data-testid=a>Text</div><div>Text</div>`);
    expect(await generate(page, '[data-testid="a"]')).toBe('internal:testid=[data-testid=\"a\"s]');
  });

  it('should use data-testid in strict errors', async ({ contextFactory, page, playwright }) => {
    const content = `
      <div>
        <div></div>
        <div>
          <div></div>
          <div></div>
        </div>
      </div>
      <div>
        <div class='foo bar:0' data-custom-id='One'>
        </div>
        <div class='foo bar:1' data-custom-id='Two'>
        </div>
      </div>
    `;

    const checkPage = async (page: Page) => {
      await page.setContent(content);
      const error = await page.locator('.foo').hover().catch(e => e);
      expect(error.message).toContain('strict mode violation');
      expect(error.message).toContain('<div class=\"foo bar:0');
      expect(error.message).toContain('<div class=\"foo bar:1');
      expect(error.message).toContain(`aka getByTestId('One')`);
      expect(error.message).toContain(`aka getByTestId('Two')`);
    };

    playwright.selectors.setTestIdAttribute('data-custom-id');
    // Check page and context that were created before setting the attribute.
    await checkPage(page);

    const context2 = await contextFactory();
    const page2 = await context2.newPage();
    // Check page and context that were created after setting the attribute.
    await checkPage(page2);
  });

  it('should handle first non-unique data-testid', async ({ page }) => {
    await page.setContent(`
      <div data-testid=a mark=1>
        Text
      </div>
      <div data-testid=a>
        Text
      </div>`);
    expect(await generate(page, 'div[mark="1"]')).toBe('internal:testid=[data-testid=\"a\"s] >> nth=0');
  });

  it('should handle second non-unique data-testid', async ({ page }) => {
    await page.setContent(`
      <div data-testid=a>
        Text
      </div>
      <div data-testid=a mark=1>
        Text
      </div>`);
    expect(await generate(page, 'div[mark="1"]')).toBe(`internal:testid=[data-testid=\"a\"s] >> nth=1`);
  });

  it('should use readable id', async ({ page }) => {
    await page.setContent(`
      <div></div>
      <div id=first-item mark=1></div>
    `);
    expect(await generate(page, 'div[mark="1"]')).toBe('#first-item');
  });

  it('should not use generated id', async ({ page }) => {
    await page.setContent(`
      <div></div>
      <div id=aAbBcCdDeE mark=1></div>
    `);
    expect(await generate(page, 'div[mark="1"]')).toBe(`div >> nth=1`);
  });

  it('should use internal:has-text', async ({ page }) => {
    await page.setContent(`
      <div>Hello world</div>
      <a>Hello <span>world</span></a>
      <a>Goodbye <span>world</span></a>
    `);
    expect(await generate(page, 'a:has-text("Hello")')).toBe(`a >> internal:has-text="Hello world"i`);
  });

  it('should use internal:has-text with regexp', async ({ page }) => {
    await page.setContent(`
      <span>Hello world</span>
      <div><div>Hello <span>world</span></div>extra</div>
      <a>Goodbye <span>world</span></a>
    `);
    expect(await generate(page, 'div div')).toBe(`div >> internal:has-text=/^Hello world$/`);
  });

  it('should use internal:has-text with regexp with a quote', async ({ page }) => {
    await page.setContent(`
      <span>Hello'world</span>
      <div><div>Hello'<span>world</span></div>extra</div>
      <a>Goodbye'<span>world</span></a>
    `);
    expect(await generate(page, 'div div')).toBe(`div >> internal:has-text=/^Hello\\'world$/`);
  });

  it('should chain text after parent', async ({ page }) => {
    await page.setContent(`
      <div>Hello <span>world</span></div>
      <b>Hello <span mark=1>world</span></b>
    `);
    expect(await generate(page, '[mark="1"]')).toBe(`b >> internal:text="world"i`);
  });

  it('should use parent text', async ({ page }) => {
    await page.setContent(`
      <div>Hello <span>world</span></div>
      <div>Goodbye <span mark=1>world</span></div>
    `);
    expect(await generate(page, '[mark="1"]')).toBe(`div >> internal:has-text="Goodbye world"i >> span`);
  });

  it('should separate selectors by >>', async ({ page }) => {
    await page.setContent(`
      <div>
        <div>Text</div>
      </div>
      <div id="id">
        <div>Text</div>
      </div>
    `);
    expect(await generate(page, '#id > div')).toBe('#id >> internal:text="Text"i');
  });

  it('should trim long text', async ({ page }) => {
    await page.setContent(`
      <div>
        <div>Text that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on</div>
      </div>
      <div id="id">
      <div>Text that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on</div>
      <div>Text that goes on and on and on and on and on and on and on and on and X on and on and on and on and on and on and on</div>
      </div>
    `);
    expect(await generate(page, '#id > div')).toBe(`#id >> internal:text="Text that goes on and on and on and on and on and on and on and on and on and"i`);
  });

  it('should use nested ordinals', async ({ page }) => {
    await page.setContent(`
      <div><c></c><c></c><c></c><c></c><c></c><b></b></div>
      <div>
        <b>
          <c>
          </c>
        </b>
        <b>
          <c mark=1></c>
        </b>
      </div>
      <div><b></b></div>
    `);
    expect(await generate(page, 'c[mark="1"]')).toBe('b:nth-child(2) > c');
  });

  it('should prefer class to ordinal', async ({ page }) => {
    await page.setContent(`
      <div><c></c><c></c><c></c><c></c><c></c><b></b></div>
      <div>
        <b class="foo">
          <c>
          </c>
        </b>
        <b>
          <c mark=1></c>
        </b>
      </div>
      <div><b class="foo"></b></div>
    `);
    await page.$eval('[mark="1"]', c => c.parentElement.className = 'foo 12.bar.baz[&x]-_?"\'');
    expect(await generate(page, 'c[mark="1"]')).toBe(`.foo.\\31 2\\.bar\\.baz\\[\\&x\\]-_\\?\\"\\' > c`);
  });

  it('should properly join child selectors under nested ordinals', async ({ page }) => {
    await page.setContent(`
      <div><c></c><c></c><c></c><c></c><c></c><b></b></div>
      <div>
        <b>
          <div>
            <c>
            </c>
          </div>
        </b>
        <b>
          <div>
            <c mark=1></c>
          </div>
        </b>
      </div>
      <div><b></b></div>
    `);
    expect(await generate(page, 'c[mark="1"]')).toBe('b:nth-child(2) > div > c');
  });

  it('should not use input[value]', async ({ page }) => {
    await page.setContent(`
      <input value="one">
      <input value="two" mark="1">
      <input value="three">
    `);
    expect(await generate(page, 'input[mark="1"]')).toBe('internal:role=textbox >> nth=1');
  });

  it.describe('should prioritize attributes correctly', () => {
    it('role', async ({ page }) => {
      await page.setContent(`<input name="foobar" type="text"/>`);
      expect(await generate(page, 'input')).toBe('internal:role=textbox');
    });
    it('placeholder', async ({ page }) => {
      await page.setContent(`<input placeholder="foobar" type="text"/>`);
      expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"foobar\"i]');
    });
    it('name', async ({ page }) => {
      await page.setContent(`
        <input aria-hidden="false" name="foobar" type="date"/>
        <div role="textbox"/>content</div>
      `);
      expect(await generate(page, 'input')).toBe('input[name="foobar"]');
    });
    it('type', async ({ page }) => {
      await page.setContent(`
        <input aria-hidden="false" type="checkbox"/>
        <div role="checkbox"/>content</div>
      `);
      expect(await generate(page, 'input')).toBe('input[type="checkbox"]');
    });
  });

  it('should find text in shadow dom', async ({ page }) => {
    await page.setContent(`<div></div>`);
    await page.$eval('div', div => {
      const shadowRoot = div.attachShadow({ mode: 'open' });
      const span = document.createElement('span');
      span.textContent = 'Target';
      shadowRoot.appendChild(span);
    });
    expect(await generate(page, 'span')).toBe('internal:text="Target"i');
  });

  it('should match in shadow dom', async ({ page }) => {
    await page.setContent(`<div></div>`);
    await page.$eval('div', div => {
      const shadowRoot = div.attachShadow({ mode: 'open' });
      const input = document.createElement('input');
      shadowRoot.appendChild(input);
    });
    expect(await generate(page, 'input')).toBe('internal:role=textbox');
  });

  it('should match in deep shadow dom', async ({ page }) => {
    await page.setContent(`<div></div><div></div><div><input></div>`);
    await page.$eval('div', div1 => {
      const shadowRoot1 = div1.attachShadow({ mode: 'open' });
      const input1 = document.createElement('input');
      shadowRoot1.appendChild(input1);
      const divExtra3 = document.createElement('div');
      shadowRoot1.append(divExtra3);
      const div2 = document.createElement('div');
      shadowRoot1.append(div2);
      const shadowRoot2 = div2.attachShadow({ mode: 'open' });
      const input2 = document.createElement('input');
      input2.setAttribute('value', 'foo');
      shadowRoot2.appendChild(input2);
    });
    expect(await generate(page, 'input[value=foo]')).toBe('internal:role=textbox >> nth=2');
  });

  it('should work in dynamic iframes without navigation', async ({ page }) => {
    await page.setContent(`<div></div>`);
    const [frame] = await Promise.all([
      page.waitForEvent('frameattached'),
      page.evaluate(() => {
        return new Promise<void>(f => {
          const iframe = document.createElement('iframe');
          iframe.onload = () => {
            iframe.contentDocument.body.innerHTML = '<div>Target</div>';
            f();
          };
          document.body.appendChild(iframe);
        });
      }),
    ]);
    expect(await generate(frame, 'div')).toBe('internal:text="Target"i');
  });

  it('should use the name attributes for elements that can have it', async ({ page }) => {
    for (const tagName of ['button', 'input', 'textarea']) {
      await page.setContent(`<form><${tagName} name="foo"></${tagName}><${tagName} name="bar"></${tagName}></form>`);
      expect(await generate(page, '[name=bar]')).toBe(`${tagName}[name="bar"]`);
    }

    await page.setContent(`<iframe name="foo"></iframe><iframe name="bar"></iframe>`);
    expect(await generate(page, '[name=bar]')).toBe(`iframe[name="bar"]`);

    await page.setContent(`<frameset><frame name="foo"></frame><frame name="bar"></frame></frameset>`);
    expect(await generate(page, '[name=bar]')).toBe(`frame[name="bar"]`);
  });

  it('should work with tricky attributes', async ({ page }) => {
    await page.setContent(`<button id="this:is-my-tricky.id"><span></span></button>`);
    expect(await generate(page, 'button')).toBe('[id="this:is-my-tricky.id"]');

    await page.setContent(`<ng:switch><span></span></ng:switch>`);
    expect(await generate(page, 'ng\\:switch')).toBe('ng\\:switch');

    await page.setContent(`<button><span></span></button><button></button>`);
    await page.$eval('span', span => span.textContent = `!#'!?"\\:`);
    expect(await generate(page, 'button')).toBe(`internal:role=button[name="!#'!?\\"\\\\:"i]`);

    await page.setContent(`<div><span></span></div>`);
    await page.$eval('div', div => div.id = `!#'!?"\\:`);
    expect(await generate(page, 'div')).toBe(`[id="!#'!?\\"\\\\:"]`);
  });

  it('should work without CSS.escape', async ({ page }) => {
    await page.setContent(`<button aria-hidden="false"></button><div role="button"></div>`);
    await page.$eval('button', button => {
      delete window.CSS.escape;
      button.setAttribute('name', '-tricky\u0001name');
    });
    expect(await generate(page, 'button')).toBe(`button[name="-tricky\u0001name"]`);
  });

  it('should not over-escape for CSS syntax', async ({ page }) => {
    await page.setContent(`<button aria-hidden="false" name="123"></button><div role="button"></div>`);
    expect(await generate(page, 'button')).toBe(`button[name="123"]`);
  });

  it('should ignore empty aria-label for candidate consideration', async ({ page }) => {
    await page.setContent(`<button aria-label="" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('#buttonId');
  });

  it('should accept valid aria-label for candidate consideration', async ({ page }) => {
    await page.setContent(`<button aria-label="ariaLabel" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('internal:role=button[name=\"ariaLabel\"i]');
  });

  it('should generate title selector', async ({ page }) => {
    await page.setContent(`<div>
      <button title="Send to" aria-description="High-Speed Parcel Delivery">Send</button>
      <button aria-description="High-Speed Parcel Delivery">Send</button>
    </div>`);
    expect(await generate(page, 'button')).toBe('internal:attr=[title=\"Send to\"i]');
  });

  it('should ignore empty role for candidate consideration', async ({ page }) => {
    await page.setContent(`<button role="" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('#buttonId');
  });

  it('should not accept invalid role for candidate consideration', async ({ page }) => {
    await page.setContent(`<button role="roleDescription" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('#buttonId');
  });

  it('should ignore empty data-test-id for candidate consideration', async ({ page }) => {
    await page.setContent(`<button data-test-id="" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('#buttonId');
  });

  it('should accept valid data-test-id for candidate consideration', async ({ page }) => {
    await page.setContent(`<button data-test-id="testId" id="buttonId"></button>`);
    expect(await generate(page, 'button')).toBe('[data-test-id="testId"]');
  });

  it('should generate label selector', async ({ page }) => {
    await page.setContent(`
      <label for=target1>Target1</label><input id=target1>
      <label for=target2>Target2</label><button id=target2>??</button>
      <label for=target3>Target3</label><select id=target3><option>hey</option></select>
      <label for=target4>Target4</label><progress id=target4 value=70 max=100>70%</progress>
      <label for=target5>Target5</label><input id=target5 type=hidden>
      <label for=target6>Target6</label><div id=target6>text</div>
    `);
    expect.soft(await generate(page, '#target1')).toBe('internal:role=textbox[name=\"Target1\"i]');
    expect.soft(await generate(page, '#target2')).toBe('internal:role=button[name=\"Target2\"i]');
    expect.soft(await generate(page, '#target3')).toBe('internal:label=\"Target3\"i');
    expect.soft(await generate(page, '#target4')).toBe('internal:label=\"Target4\"i');
    expect.soft(await generate(page, '#target5')).toBe('#target5');
    expect.soft(await generate(page, '#target6')).toBe('internal:text="text"i');

    await page.setContent(`<label for=target>Coun"try</label><input id=target>`);
    expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"Coun\\\"try\"i]');
  });

  it('should prefer role other input[type]', async ({ page }) => {
    await page.setContent(`<input type=checkbox><div data-testid=wrapper><input type=checkbox></div>`);
    expect(await generate(page, '[data-testid=wrapper] > input')).toBe('internal:testid=[data-testid="wrapper"s] >> internal:role=checkbox');
  });

  it('should generate exact text when necessary', async ({ page }) => {
    await page.setContent(`
      <span>Text</span>
      <span>Text and more</span>
    `);
    expect(await generate(page, 'span')).toBe('internal:text=\"Text\"s');
  });

  it('should generate exact title when necessary', async ({ page }) => {
    await page.setContent(`
      <span title="Text"></span>
      <span title="Text and more"></span>
    `);
    expect(await generate(page, 'span')).toBe('internal:attr=[title=\"Text\"s]');
  });

  it('should generate exact placeholder when necessary', async ({ page }) => {
    await page.setContent(`
      <input placeholder="Text"></input>
      <input placeholder="Text and more"></input>
    `);
    expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"Text\"s]');
  });

  it('should generate exact role when necessary', async ({ page }) => {
    await page.setContent(`
      <img alt="Text"></img>
      <img alt="Text and more"></img>
    `);
    expect(await generate(page, 'img')).toBe('internal:role=img[name=\"Text\"s]');
  });

  it('should generate exact label when necessary', async ({ page }) => {
    await page.setContent(`
      <label>Text <input></input></label>
      <label>Text and more <input></input></label>
    `);
    expect(await generate(page, 'input')).toBe('internal:role=textbox[name=\"Text\"s]');
  });

  it('should generate relative selector', async ({ page }) => {
    await page.setContent(`
      <div>
        <span>Hello</span>
        <span>World</span>
      </div>
      <section>
        <span>Hello</span>
        <span>World</span>
      </section>
    `);
    const selectors = await page.evaluate(() => {
      const target = document.querySelector('section > span');
      const root = document.querySelector('section');
      const relative = (window as any).__injectedScript.generateSelectorSimple(target, { root });
      const absolute = (window as any).__injectedScript.generateSelectorSimple(target);
      return { relative, absolute };
    });
    expect(selectors).toEqual({
      relative: `internal:text="Hello"i`,
      absolute: `section >> internal:text="Hello"i`,
    });
  });

  it('should generate multiple: noText in role', async ({ page }) => {
    await page.setContent(`
      <button>Click me</button>
    `);
    expect(await generateMultiple(page, 'button')).toEqual([`internal:role=button[name="Click me"i]`, `internal:role=button`]);
  });

  it('should generate multiple: noText in text', async ({ page }) => {
    await page.setContent(`
      <div>Some div</div>
    `);
    expect(await generateMultiple(page, 'div')).toEqual([`internal:text="Some div"i`, `div`]);
  });

  it('should generate multiple: noId', async ({ page }) => {
    await page.setContent(`
      <div id=first><button>Click me</button></div>
      <div id=second><button>Click me</button></div>
    `);
    expect(await generateMultiple(page, '#second button')).toEqual([
      `#second >> internal:role=button[name="Click me"i]`,
      `#second >> internal:role=button`,
      `internal:role=button[name="Click me"i] >> nth=1`,
      `internal:role=button >> nth=1`,
    ]);
  });

  it('should generate multiple: noId noText', async ({ page }) => {
    await page.setContent(`
      <div id=first><span>Some span</span></div>
      <div id=second><span>Some span</span></div>
    `);
    expect(await generateMultiple(page, '#second span')).toEqual([
      `#second >> internal:text="Some span"i`,
      `#second span`,
      `internal:text="Some span"i >> nth=1`,
      `span >> nth=1`,
    ]);
  });

  it('should prefer role with hasText to css with hasText', async ({ page }) => {
    await page.setContent(`
      <ul>
        <li>
          <input aria-label="Toggle Todo" type="checkbox">
          buy flowers
        </li>
        <li>
          <input aria-label="Toggle Todo" type="checkbox">
          sell milk
        </li>
      </ul>
      `);
    expect(await generateMultiple(page, 'input')).toEqual([
      `internal:role=listitem >> internal:has-text=\"buy flowers\"i >> internal:label=\"Toggle Todo\"i`,
      `internal:label=\"Toggle Todo\"i >> nth=0`,
    ]);
  });

  it('should collect selector suggestions', async ({ page }) => {
    await page.setContent(`
      <div class="container">
        <button id="secondary-cancel" class="btn ghost" data-testid="cancel-secondary" title="Cancel order">Cancel</button>
        <button id="primary-submit" class="btn cta" data-testid="submit-primary" title="Submit order">Submit order</button>
        <button class="btn ghost" data-testid="cancel-tertiary" title="Cancel order">Cancel</button>
        <div class="btn ghost" data-testid="div-button-like" title="Div acts like button">Div button-ish</div>
      </div>
    `);

    await page.waitForFunction(() => !!(window as any).__injectedScript?.generateSelector);

    const result = await page.$eval('#primary-submit', () => {
      const injected = (window as any).__injectedScript;
      return injected.generateSelector(document.querySelector('#primary-submit')!, {
        multiple: true,
        testIdAttributeName: 'data-testid',
        collectSelectors: true,
      });
    });

    console.log(result);
    expect(result.selectors.length).toBeGreaterThanOrEqual(4);
    const selectorSet = new Set<string>(result.selectors);
    const pick = (needle: RegExp) => [...selectorSet].find(s => needle.test(s))!;
    const testIdSel = pick(/data-testid/);
    const roleSel = pick(/internal:role=button/);
    const textSel = pick(/Submit order/);
    const cssSel = pick(/primary-submit/);

    // Ensure selectors uniquely resolve to the intended button.
    await page.$eval('#primary-submit', (el, selectors) => {
      const injected = (window as any).__injectedScript;
      for (const sel of selectors) {
        const parsed = injected.parseSelector(sel);
        const matches = injected.querySelectorAll(parsed, document);
        if (!matches.includes(el))
          throw new Error(`Selector ${sel} did not match the target`);
        if (matches.length !== 1)
          throw new Error(`Selector ${sel} matched ${matches.length} elements`);
      }
    }, [testIdSel, roleSel, textSel, cssSel]);
  });

  it('collects only selectors that resolve to a nested touchspin button', async ({ page }) => {
    // Several identical cart lines: the "+" button has no cheap unique match, which
    // forces parent disambiguation - the path that used to leak ancestor-only
    // selectors (#cart, body, body >> internal:has-text=...) into the suggestions.
    const line = (index: number) => `
      <div class="cart-line" data-line="${index}">
        <p>en savoir plus Profitez de nos offres</p>
        <div class="qty d-flex align-items-center">
          <div class="input-group bootstrap-touchspin">
            <span class="input-group-btn input-group-prepend">
              <button tabindex="-1" class="btn js-touchspin bootstrap-touchspin-down" type="button">−</button>
            </span>
            <input class="input-quantity js-cart-line-product-quantity form-control"
                   type="number" value="1" name="product-quantity-spin" min="1" max="3">
            <span class="input-group-btn input-group-append">
              <button tabindex="-1" class="btn js-touchspin bootstrap-touchspin-up" type="button">+</button>
            </span>
          </div>
        </div>
      </div>`;
    await page.setContent(`<div id="cart">${[0, 1, 2].map(line).join('')}</div>`);

    await page.waitForFunction(() => !!(window as any).__injectedScript?.generateSelector);

    const targetSelector = '[data-line="1"] .bootstrap-touchspin-up';
    const result = await page.$eval(targetSelector, target => {
      const injected = (window as any).__injectedScript;
      return injected.generateSelector(target, {
        multiple: true,
        testIdAttributeName: 'data-testid',
        collectSelectors: true,
      });
    });

    // Every returned selector must uniquely resolve to that one "+" button.
    await page.$eval(targetSelector, (el, selectors) => {
      const injected = (window as any).__injectedScript;
      for (const sel of selectors) {
        const parsed = injected.parseSelector(sel);
        const matches = injected.querySelectorAll(parsed, document);
        if (!matches.includes(el))
          throw new Error(`Selector ${sel} did not match the target`);
        if (matches.length !== 1)
          throw new Error(`Selector ${sel} matched ${matches.length} elements`);
      }
    }, result.selectors);
  });

  // Qanary fork: the collected, scored set (zazu's docs/specs/weighted-locator-generation.md).
  // The suite above is this feature's real guard - it pins the primary selector for ~100 DOM
  // shapes, and collection is only safe because nothing it adds ever reaches selection.
  it.describe('collected selectors', () => {
    type Collected = { selector: string, selectors: string[], ranked: { selector: string, score: number }[] };

    async function collect(page: Page, target: string, maxSelectors?: number): Promise<Collected> {
      await page.waitForFunction(() => !!(window as any).__injectedScript?.generateSelector);
      return page.$eval(target, (element, maxSelectors) => {
        const result = (window as any).__injectedScript.generateSelector(element, {
          multiple: true,
          testIdAttributeName: 'data-testid',
          collectSelectors: true,
          maxSelectors,
        });
        return { selector: result.selector, selectors: result.selectors, ranked: result.rankedSelectors };
      }, maxSelectors);
    }

    async function assertAllResolve(page: Page, target: string, selectors: string[]) {
      const bad = await page.$eval(target, (element, selectors) => {
        const injected = (window as any).__injectedScript;
        return selectors.filter(selector => {
          const matches = injected.querySelectorAll(injected.parseSelector(selector), document);
          return matches.length !== 1 || matches[0] !== element;
        });
      }, selectors);
      expect(bad, 'every collected selector resolves to the target alone').toEqual([]);
    }

    // A repeated list: the shape where the engine emitted two text-derived selectors and
    // nothing else, because nth >= 6 is refused and unique candidates never chained.
    const cards = (count: number) => `<main>${[...Array(count).keys()].map(i => `
      <div class="card" data-idx="${i}">
        <div class="card__inner"><div class="card__body">
          <a class="card__link" href="/item/${i}">Open ${i}</a>
          <input class="card__input" id="qty-${i}" name="qty-${i}" placeholder="Quantity ${i}">
        </div></div>
      </div>`).join('')}</main>`;

    it('collects a scored set that resolves to the target and contains the legacy one', async ({ page }) => {
      await page.setContent(`
        <div class="container">
          <button id="primary-submit" class="btn cta" data-testid="submit-primary" title="Submit order">Submit order</button>
          <button class="btn ghost" data-testid="cancel-secondary">Cancel</button>
        </div>`);
      const { selector, selectors, ranked } = await collect(page, '#primary-submit');

      expect(ranked.length).toBeGreaterThan(selectors.length);
      expect(ranked.length).toBeLessThanOrEqual(10);
      // Superset: a consumer can switch to the scored list wholesale.
      const collected = ranked.map(entry => entry.selector);
      for (const legacy of [selector, ...selectors])
        expect(collected).toContain(legacy);
      // Sorted by score, lower is stronger - position carries no other meaning.
      expect(ranked.map(entry => entry.score)).toEqual([...ranked.map(entry => entry.score)].sort((a, b) => a - b));
      await assertAllResolve(page, '#primary-submit', collected);
    });

    it('refuses build-generated class names, and keeps hand-written ones', async ({ page }) => {
      // Same element twice: once named by classes a build tool emitted, once by classes a
      // person wrote. Only the shape of the name differs.
      await page.setContent(`
        <div class="sc-imWYAI jLBYtg">
          <section class="elementor-element elementor-element-1f1818a">
            <button class="sc-GTVdH hUyBqQ" data-testid="generated-button">Generated</button>
          </section>
        </div>
        <div class="product-card">
          <section class="card__body col-md-6 text-2xl">
            <button class="single_add_to_cart_button ecomGalleryMainSlide">Written</button>
          </section>
        </div>
        <div class="formkit7-form-control">
          <button class="espaceDeTravailDDC">Named</button>
        </div>`);

      const generated = (await collect(page, 'button.sc-GTVdH')).ranked.map(entry => entry.selector);
      for (const className of ['sc-imWYAI', 'jLBYtg', 'sc-GTVdH', 'hUyBqQ', 'elementor-element-1f1818a'])
        expect(generated.join(' '), `no locator may be anchored on .${className}`).not.toContain(className);
      // Refusing them costs the step nothing: the durable evidence is still collected.
      expect(generated.length).toBeGreaterThan(0);
      await assertAllResolve(page, 'button.sc-GTVdH', generated);

      // The refusal is about randomness, not about classes: descriptive names survive,
      // camelCase included.
      const written = (await collect(page, 'button.single_add_to_cart_button')).ranked.map(entry => entry.selector);
      expect(written.some(selector => selector.includes('single_add_to_cart_button'))).toBe(true);
      expect(written.some(selector => selector.includes('card__body') || selector.includes('product-card'))).toBe(true);
      await assertAllResolve(page, 'button.single_add_to_cart_button', written);

      // Two shapes that a looser rule mistakes for hashes, both common in the wild: a
      // plugin prefix carrying one version digit, and a camelCase name ending in an
      // acronym. Neither changes between builds, so neither may be refused.
      const named = (await collect(page, 'button.espaceDeTravailDDC')).ranked.map(entry => entry.selector);
      expect(named.some(selector => selector.includes('espaceDeTravailDDC'))).toBe(true);
      expect(named.some(selector => selector.includes('formkit7-form-control'))).toBe(true);
    });

    it('never empties a set to refuse a generated class', async ({ page }) => {
      // The refusal has a floor: an element the page names only by generated classes is
      // still addressable, because a locator that breaks at the next build beats none.
      await page.setContent(`<div class="sc-imWYAI"><span class="jLBYtg hUyBqQ"></span></div>`);
      const { ranked } = await collect(page, 'span.jLBYtg');
      const collected = ranked.map(entry => entry.selector);
      expect(collected.length).toBeGreaterThan(0);
      await assertAllResolve(page, 'span.jLBYtg', collected);
    });

    it('rescues a deep list item that had only its text', async ({ page }) => {
      await page.setContent(cards(30));
      const target = '[data-idx="28"] .card__link';
      const { selectors, ranked } = await collect(page, target);

      // Before: role-by-name and text, both reading the same string.
      expect(selectors).toHaveLength(2);
      const collected = ranked.map(entry => entry.selector);
      // After: at least one locator that survives that string changing.
      expect(collected.filter(selector => !selector.includes('Open 28')).length).toBeGreaterThan(0);
      // Including the scope the instance actually sits in.
      expect(collected.some(selector => selector.includes('data-idx="28"'))).toBe(true);
      // And a structural path, the one family that always exists.
      expect(collected.some(selector => selector.includes('card__body'))).toBe(true);
      await assertAllResolve(page, target, collected);
    });

    it('scores a chain below both of its halves', async ({ page }) => {
      await page.setContent(cards(30));
      const { ranked } = await collect(page, '[data-idx="28"] .card__input');
      const chains = ranked.filter(entry => entry.selector.includes(' >> ') || entry.selector.startsWith('div[data-idx'));
      expect(chains.length).toBeGreaterThan(0);
      for (const chain of chains) {
        for (const other of ranked) {
          if (other === chain || !chain.selector.endsWith(other.selector))
            continue;
          expect(chain.score, `${chain.selector} must score worse than its half ${other.selector}`).toBeGreaterThan(other.score);
        }
      }
    });

    it('never anchors a chain on a positional path, body or html', async ({ page }) => {
      await page.setContent(cards(30));
      for (const target of ['[data-idx="28"] .card__link', '[data-idx="3"] .card__input']) {
        const { ranked } = await collect(page, target);
        for (const { selector } of ranked) {
          if (!selector.includes('>>'))
            continue;
          const anchor = selector.split('>>')[0].trim();
          expect(anchor, 'anchors name a scope, never a position').not.toMatch(/nth-child|^(body|html)\b/);
        }
      }
    });

    it('never emits two spellings of the same evidence', async ({ page }) => {
      await page.setContent(`<div><button title="Submit order">Submit order</button></div>`);
      const { ranked } = await collect(page, 'button');
      // `[name="X"i]` and `[name="X"s]` match with different strictness but rot together.
      const evidence = ranked.map(entry => entry.selector.replace(/(["'])[is](?![\w-])/g, '$1'));
      expect(new Set(evidence).size, `one fact per slot: ${ranked.map(e => e.selector).join(' | ')}`).toBe(evidence.length);
    });

    it('orders structural paths by depth', async ({ page }) => {
      // The decoy span keeps the targets off `span >> nth=0`, which cssFallback returns
      // for the document's first span - a path one level deep is not a depth test.
      await page.setContent(`
        <main>
          <p><span>decoy</span></p>
          <div class="shallow"><span>alpha</span></div>
          <div class="wrap"><div><div><span>beta</span></div></div></div>
        </main>`);
      const structuralScore = async (target: string) => {
        const { ranked } = await collect(page, target);
        return ranked.find(entry => entry.score > 1000000)?.score;
      };
      const shallow = await structuralScore('.shallow span');
      const deep = await structuralScore('.wrap span');
      expect(shallow).toBeDefined();
      expect(deep).toBeDefined();
      expect(deep!, 'a deeper path is more fragile and must score worse').toBeGreaterThan(shallow!);
    });

    it('honours the budget and never pads a bare element', async ({ page }) => {
      await page.setContent(cards(30));
      for (const max of [3, 5, 10, 20]) {
        const { ranked } = await collect(page, '[data-idx="28"] .card__link', max);
        expect(ranked.length, `budget ${max}`).toBeLessThanOrEqual(max);
      }
      // A span with nothing of its own: a small honest set, not a padded one.
      await page.setContent(`<div><span></span><span></span><span></span></div>`);
      const { ranked } = await collect(page, 'span:nth-child(2)', 20);
      expect(ranked.length).toBeLessThan(5);
      await assertAllResolve(page, 'span:nth-child(2)', ranked.map(entry => entry.selector));
    });

    it('is deterministic on an unchanged DOM', async ({ page }) => {
      await page.setContent(cards(30));
      const first = await collect(page, '[data-idx="28"] .card__link');
      const second = await collect(page, '[data-idx="28"] .card__link');
      expect(second.ranked).toEqual(first.ranked);
    });

    it('generates within the performance budget', async ({ page }) => {
      await page.setContent(cards(300));
      await page.waitForFunction(() => !!(window as any).__injectedScript?.generateSelector);
      const median = await page.$eval('[data-idx="280"] .card__link', element => {
        const injected = (window as any).__injectedScript;
        const options = { multiple: true, testIdAttributeName: 'data-testid', collectSelectors: true };
        const samples: number[] = [];
        for (let i = 0; i < 11; i++) {
          const started = performance.now();
          injected.generateSelector(element, options);
          samples.push(performance.now() - started);
        }
        return samples.sort((a, b) => a - b)[5];
      });
      // Generation runs once per recorded action, on the user's interaction path, next to a
      // full-page aria snapshot that costs more. Loose enough for a busy CI machine, tight
      // enough that a quadratic mistake fails here.
      expect(median, `median in-page generation was ${median.toFixed(1)}ms`).toBeLessThan(150);
    });
  });

});
