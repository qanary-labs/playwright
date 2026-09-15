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

import type { Point } from '@isomorphic/types';

// Where the recorded element is on the whole page (zazu's self-healing spec): the
// center of its bounding box in the document coordinates of its own frame — viewport
// position plus the frame's scroll offset, so the point survives scrolling. Read on
// the element the selectors were generated for (post-retarget), in the same tick as
// its rect, which is why the recorder computes it and not a consumer. Undefined for
// a box with no area (a `display: none` native input behind a custom control): there
// is nothing to measure, and the action records no point at all.
export function elementPoint(element: Element | undefined): Point | undefined {
  if (!element)
    return undefined;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0)
    return undefined;
  const view = element.ownerDocument.defaultView;
  if (!view)
    return undefined;
  return {
    x: rect.left + rect.width / 2 + view.scrollX,
    y: rect.top + rect.height / 2 + view.scrollY,
  };
}
