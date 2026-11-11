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
 * Qanary fork: locators that name the collection a repeated target belongs to — the set of
 * copies, and the target inside one copy — beside the step's own locators, which name the
 * copy the user acted on. Built from the repetition the
 * fingerprint found, validated against every copy, never against one.
 */

import { quoteCSSAttributeValue } from '@isomorphic/stringUtils';

import { getAriaRole } from './roleUtils';
import { escapeClassName, escapeNodeName, isGeneratedClassName, isGuidLike, kCSSAttributeScore, kCSSClassScore, kStableAttributes } from './selectorCollector';

import type { Repetition } from './fingerprint';
import type { InjectedScript } from './injectedScript';
import type { Collection, RankedSelector } from '@recorder/actions';

const kMaxCollectionSelectors = 5;
const kRoleWithoutNameScore = 510;
const kFloorScore = 10000;
const kAttributeValueMaxLength = 80;
const kMaxClassTokens = 4;

// The element's scored selectors, relative to `root` when given.
export type GenerateRanked = (element: Element, root?: Element) => RankedSelector[];

export function elementCollection(injectedScript: InjectedScript, target: Element, repetition: Repetition, generate: GenerateRanked): Collection | undefined {
  const items = itemSelectors(injectedScript, repetition, generate);
  if (!items.length)
    return;
  const targetSelectors = targetSelectorsIn(injectedScript, target, repetition, generate);
  if (!targetSelectors.length)
    return;
  return { items, target: targetSelectors };
}

// Selectors matching every copy and nothing outside their parent, by what the copies
// share: their role, a stable attribute, a class, and their tag as the floor. A sibling
// without the target (an ad card in a product grid) may match too: the consumer keeps
// only the copies that contain the target.
function itemSelectors(injectedScript: InjectedScript, repetition: Repetition, generate: GenerateRanked): RankedSelector[] {
  const { item, copies } = repetition;
  const container = item.parentNode!;
  const tag = escapeNodeName(item);
  const candidates: RankedSelector[] = [];

  const role = getAriaRole(item);
  if (role && !['generic', 'none', 'presentation'].includes(role))
    candidates.push({ selector: `internal:role=${role}`, score: kRoleWithoutNameScore });
  for (const attribute of item.getAttributeNames()) {
    if (!kStableAttributes.includes(attribute) && !attribute.startsWith('data-'))
      continue;
    const value = item.getAttribute(attribute)!;
    if (!value || value.length > kAttributeValueMaxLength || isGuidLike(value))
      continue;
    if (copies.every(copy => copy.getAttribute(attribute) === value))
      candidates.push({ selector: `${tag}[${attribute}=${quoteCSSAttributeValue(value)}]`, score: kCSSAttributeScore });
  }
  const classes = [...item.classList].slice(0, kMaxClassTokens).map(escapeClassName).filter(name => name && !isGeneratedClassName(name));
  for (const className of classes) {
    if (copies.every(copy => copy.classList.contains(className)))
      candidates.push({ selector: `${tag}.${className}`, score: kCSSClassScore });
  }

  // The parent is named by anything but its text: its text is the copies' text, which is
  // what changes when the list does.
  const parent = container instanceof ShadowRoot ? container.host : container as Element;
  const parentSelector = generate(parent).find(candidate => !/internal:(has-)?text=/.test(candidate.selector))?.selector;
  const isValid = (selector: string) => {
    const matched = queryAll(injectedScript, selector, item.ownerDocument);
    return !!matched && copies.every(copy => matched.includes(copy)) && matched.every(element => element.parentNode === container);
  };
  const valid: RankedSelector[] = [];
  for (const candidate of candidates) {
    if (isValid(candidate.selector))
      valid.push(candidate);
    else if (parentSelector && isValid(`${parentSelector} >> ${candidate.selector}`))
      valid.push({ selector: `${parentSelector} >> ${candidate.selector}`, score: candidate.score });
  }
  const floor = parentSelector ? `${parentSelector} >> :scope > ${tag}` : undefined;
  return withFloor(valid, floor && isValid(floor) ? { selector: floor, score: kFloorScore } : undefined);
}

// The target's selectors relative to its copy, kept only if each also names exactly one
// element in every other copy: a target named by its own copy's text ("Buy 42") is not.
// The path from the copy down to the target, as a child chain, is the floor.
function targetSelectorsIn(injectedScript: InjectedScript, target: Element, repetition: Repetition, generate: GenerateRanked): RankedSelector[] {
  const { item, copies, path } = repetition;
  const isValid = (selector: string) => copies.every(copy => {
    const matched = queryAll(injectedScript, selector, copy);
    return !!matched && matched.length === 1 && (copy !== item || matched[0] === target);
  });
  const valid = generate(target, item).filter(candidate => isValid(candidate.selector));
  const floor = path.some(hop => hop.shadow) ? undefined : ':scope > ' + path.map(hop => hop.tag.replace(/[:\.]/g, char => '\\' + char)).join(' > ');
  return withFloor(valid, floor && isValid(floor) ? { selector: floor, score: kFloorScore } : undefined);
}

// The strongest first, at most 5, the floor last when there is one.
function withFloor(valid: RankedSelector[], floor: RankedSelector | undefined): RankedSelector[] {
  const sorted = valid.filter(candidate => candidate.selector !== floor?.selector).sort((a, b) => a.score - b.score);
  if (!floor)
    return sorted.slice(0, kMaxCollectionSelectors);
  return [...sorted.slice(0, kMaxCollectionSelectors - 1), floor];
}

function queryAll(injectedScript: InjectedScript, selector: string, root: Node): Element[] | undefined {
  try {
    return injectedScript.querySelectorAll(injectedScript.parseSelector(selector), root);
  } catch {
    return undefined;
  }
}
