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

/**
 * Qanary fork: what the recorded element is, in human terms (zazu's step-intent spec,
 * §The fingerprint), and whether it is one of several structural copies (§Repetition).
 * Read in the same tick as the element's selectors and point, on the same element.
 */

import { normalizeWhiteSpace } from '@isomorphic/stringUtils';

import { isElementVisible, parentElementOrShadowHost } from './domUtils';
import { getAriaRole, getElementAccessibleName } from './roleUtils';

import type { Fingerprint, FingerprintContext } from '@recorder/actions';

const kMaxTextLength = 100;
const kMaxContext = 3;
// Ancestors that say where the element is: landmarks, regions, the containers that
// scope a repeated item, and dialogs.
const kContextRoles = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
  'dialog', 'alertdialog', 'listitem', 'row', 'article', 'table', 'grid']);
// The repetition walk: how far up it looks, and how many nodes the structural comparisons
// may visit in all before it gives up (a wide tree of identical wrappers).
const kMaxRepeatHops = 15;
const kMaxRepeatVisits = 2000;

// One step of the path from the repeated item down to the target: the element's tag and
// role, and whether it sits in the shadow root of the element above it.
type Hop = { tag: string, role: string | null, shadow: boolean };

export type Repetition = {
  // The repeated ancestor (the spec's A).
  item: Element;
  // The siblings of `item` in which the target's path matches, `item` included, in
  // document order.
  copies: Element[];
  // From `item` (excluded) down to the target (included).
  path: Hop[];
};

export function elementFingerprint(element: Element, repetition: Repetition | undefined): Fingerprint {
  const fingerprint: Fingerprint = {
    role: getAriaRole(element) ?? '',
    name: cap(getElementAccessibleName(element, false)),
    tag: element.localName,
    context: elementContext(element),
  };
  const text = ownText(element);
  if (text)
    fingerprint.text = text;
  const label = controlLabel(element);
  if (label)
    fingerprint.label = label;
  if (repetition)
    fingerprint.repeat = { index: repetition.copies.indexOf(repetition.item), count: repetition.copies.length };
  return fingerprint;
}

// The first ancestor A whose parent holds another child of A's tag and role in which the
// target's path from A (tag and role of each hop) also matches. Structure, never text:
// the copies of a card differ in their text and agree in their structure.
export function findRepetition(target: Element): Repetition | undefined {
  const path: Hop[] = [hopOf(target)];
  let visits = 0;
  const matches = (element: Element, from: number): boolean => {
    if (from === path.length)
      return true;
    const hop = path[from];
    const children = hop.shadow ? element.shadowRoot?.children : element.children;
    for (const child of children ?? []) {
      if (++visits > kMaxRepeatVisits)
        return false;
      if (child.localName === hop.tag && getAriaRole(child) === hop.role && matches(child, from + 1))
        return true;
    }
    return false;
  };

  let item = parentOf(target);
  for (let hops = 0; item && hops < kMaxRepeatHops; hops++) {
    if (item.localName === 'body' || item.localName === 'html')
      return;
    const container = item.parentNode;
    if (!container)
      return;
    const role = getAriaRole(item);
    const copies = [...container.children].filter(sibling => sibling === item || (sibling.localName === item!.localName && getAriaRole(sibling) === role && matches(sibling, 0)));
    if (visits > kMaxRepeatVisits)
      return;
    if (copies.length >= 2)
      return { item, copies, path };
    path.unshift(hopOf(item));
    item = parentOf(item);
  }
}

function hopOf(element: Element): Hop {
  return { tag: element.localName, role: getAriaRole(element), shadow: element.parentNode instanceof ShadowRoot };
}

function parentOf(element: Element): Element | undefined {
  return parentElementOrShadowHost(element);
}

// Up to 3 entries, innermost first: the nearest meaningful ancestors, then the nearest
// heading before the element, which names the section it is in.
function elementContext(element: Element): FingerprintContext[] {
  const heading = precedingHeading(element);
  const max = heading ? kMaxContext - 1 : kMaxContext;
  const context: FingerprintContext[] = [];
  for (let ancestor = parentOf(element); ancestor && context.length < max; ancestor = parentOf(ancestor)) {
    const role = getAriaRole(ancestor);
    if (role && kContextRoles.has(role))
      context.push({ role, name: cap(getElementAccessibleName(ancestor, false)) });
  }
  if (heading)
    context.push(heading);
  return context;
}

// The last visible heading before the element in document order, its own section's
// title when it has one. One query over the element's tree; headings are few.
function precedingHeading(element: Element): FingerprintContext | undefined {
  const root = element.getRootNode() as Document | ShadowRoot;
  const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')];
  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i];
    if (heading === element || heading.contains(element))
      continue;
    if (!(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
      continue;
    if (!isElementVisible(heading))
      continue;
    const name = cap(getElementAccessibleName(heading, false));
    if (name)
      return { role: 'heading', name };
  }
}

// The element's visible text. Never a field's value: what was typed is not what the
// element is, and may be a secret.
function ownText(element: Element): string {
  if (isTextField(element) || !(element instanceof HTMLElement))
    return '';
  return cap(element.innerText ?? '');
}

function controlLabel(element: Element): string {
  if (!isTextField(element))
    return '';
  const labels = (element as HTMLInputElement).labels;
  const labelText = labels ? [...labels].map(label => label.innerText).join(' ') : '';
  return cap(labelText || element.getAttribute('placeholder') || '');
}

function isTextField(element: Element): boolean {
  return ['input', 'textarea', 'select'].includes(element.localName) || (element instanceof HTMLElement && element.isContentEditable);
}

function cap(text: string): string {
  const normalized = normalizeWhiteSpace(text);
  return normalized.length > kMaxTextLength ? normalized.substring(0, kMaxTextLength) : normalized;
}
