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

import { parentElementOrShadowHost } from './domUtils';

// Empty-label click fallback (zazu's empty-label-click-fallback spec): decides whether a
// click aimed at a label with no box may land where its control is instead.
//
// The pattern this exists for: switches and custom checkboxes drawn entirely by CSS on an
// empty label (Bootstrap's custom-switch). The label has no content, its ::before/::after
// draw the control, and the real checkbox sits underneath at opacity 0. Pseudo-elements do
// not count towards a box, so the label is "not visible" to the click path, and the
// checkbox is hidden too, so no element of the control can be clicked. A user's click lands
// on the drawn switch, which hit-tests as the label.
//
// Every guard below refuses by returning undefined/false, and refusal means the caller
// reports the original "not visible" failure. That keeps the fallback unreachable from any
// path that passes today.

// Guards 1 and 2: the label's control, when the label is one this fallback is for.
export function emptyLabelControl(node: Node): Element | undefined {
  if (node.nodeType !== 1 /* Node.ELEMENT_NODE */ || (node as Element).localName !== 'label')
    return;
  const label = node as HTMLLabelElement;
  // A box is what the click path needs; a label that has one fails for another reason.
  const rect = label.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0)
    return;
  // Hidden with its subtree (display: none, visibility: hidden): its pseudo-elements are
  // hidden with it, so nothing is drawn where a click could land.
  if (!label.checkVisibility({ visibilityProperty: true }))
    return;
  // Inside a link or a button, a click means more than toggling the control, and a link is
  // the covered-target fallback's territory: never compete with it.
  for (let element = parentElementOrShadowHost(label); element; element = parentElementOrShadowHost(element)) {
    if (element.localName === 'a' || element.localName === 'button')
      return;
  }
  const control = label.control;
  if (!control || (control as HTMLInputElement).disabled)
    return;
  return control;
}

// Guard 4: whether the browser's hit at the control's center is the label (its
// pseudo-elements hit-test as the label) or the control. `chain` is the hit chain
// hitTargetChain resolved against the label: 'done' when the hit is the label or inside it.
export function emptyLabelHit(chain: 'done' | Element[], control: Element): boolean {
  return chain === 'done' || chain.includes(control);
}
