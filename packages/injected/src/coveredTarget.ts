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

// Covered-target click fallback: decides whether the element intercepting a click can
// stand in for the target it covers. It can, and only can, when both declare the same
// destination — the recorded intent ("reach this URL") is then satisfied by clicking
// what the user's own click would have hit.
//
// The pattern this exists for: interactive tiles stacking several sibling anchors that
// all navigate to the same URL, where a hover-revealed cover swaps in above the static
// link. Moving the mouse onto the target is what reveals the cover, so the click
// defeats itself and no amount of retrying converges.
//
// Every guard below refuses by returning null, and refusal means the caller reports the
// original interception failure. That keeps the fallback unreachable from any path that
// passes today.

// SVG <a> elements share the 'a' local name but expose href as an SVGAnimatedString
// rather than a URL string; comparing destinations across the two is meaningless.
// Duck-typing the href avoids instanceof, which would break across realms.
function asHtmlAnchor(element: Element | null | undefined): HTMLAnchorElement | null {
  if (!element || element.localName !== 'a')
    return null;
  const anchor = element as HTMLAnchorElement;
  return typeof anchor.href === 'string' ? anchor : null;
}

// A destination worth comparing: an href that actually leads somewhere. A bare '#' and a
// script pseudo-URL are the two idioms for "this anchor is really a button" — sharing one
// says nothing about where a click leads, so it cannot make two elements the same action.
// A real fragment ('#reviews') does navigate and is compared like any other URL.
function navigationalAnchor(element: Element | null | undefined): HTMLAnchorElement | null {
  const anchor = asHtmlAnchor(element);
  if (!anchor)
    return null;
  const href = anchor.getAttribute('href')?.trim();
  if (!href || href === '#' || href.toLowerCase().startsWith('javascript:'))
    return null;
  return anchor;
}

// Walks the composed tree, the path a click event is actually dispatched along. Note
// this deliberately differs from Element.closest(), which stops at a shadow boundary and
// would miss an anchor wrapping the target from outside its shadow root.
function enclosingAnchor(element: Element | undefined): HTMLAnchorElement | null {
  for (let current: Element | undefined = element; current; current = current.assignedSlot ?? parentElementOrShadowHost(current)) {
    const anchor = navigationalAnchor(current);
    if (anchor)
      return anchor;
  }
  return null;
}

// `hitChain` is the composed-tree chain from InjectedScript.hitTargetChain: the element
// on top at the click point first, its ancestors after. 'done' means nothing intercepts
// inside this frame. Returns the shared absolute URL when the interceptor may be clicked
// in the target's stead, null on any refusal.
export function coveredTargetHref(targetElement: Element, hitChain: 'done' | Element[]): string | null {
  // Guard 1: the target declares a destination. Buttons and other controls have nothing
  // to compare, so a cover over them is never provably equivalent.
  const targetAnchor = enclosingAnchor(targetElement);
  if (!targetAnchor)
    return null;

  // Guard 3: something else really is on top, in this frame. 'done' means the hit test
  // now lands on the target, so the interception came from an ancestor document and the
  // element receiving the click is one this chain cannot inspect.
  if (hitChain === 'done')
    return null;
  const interceptor = hitChain[0];
  if (!interceptor)
    return null;

  // Guard 4: the interceptor leads where the target leads. The topmost element is rarely
  // the anchor itself (typically an image inside one), so what matters is the anchor its
  // click would bubble to.
  const hitAnchor = enclosingAnchor(interceptor);
  if (!hitAnchor || hitAnchor.href !== targetAnchor.href)
    return null;

  // Guard 5: same navigation context. A cover opening a new tab is a different action,
  // whatever its href says.
  if ((hitAnchor.getAttribute('target') ?? '') !== (targetAnchor.getAttribute('target') ?? ''))
    return null;

  return targetAnchor.href;
}
