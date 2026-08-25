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

import type { InjectedScript } from '../injectedScript';

// One selector's resolution against the current DOM. `id` names the matched element
// when the selector matched exactly one — ids are per-pass ordinals, so two selectors
// carrying the same id matched the same node — and is null otherwise; `count` is how
// many elements the selector matched (a parse error counts as none).
export type ResolveMatch = { id: number | null, count: number };
export type ResolvePass = { matches: ResolveMatch[] };

type ResolveState = { token: string, signature: string, since: number };

// Consensus resolution (zazu's consensus-locator-resolution spec): resolve every
// selector in one synchronous pass, so all of them see the same DOM, and report which
// ones name the same element. Ranking is the caller's job; this is a read-only view
// over resolution that already exists.
//
// Meant to be polled (`waitForFunction`): the pass returns null until its signature —
// the partition of selector indices into same-element groups, deliberately not the
// nodes themselves, so a keyed re-render that replaces nodes but not the answer still
// settles — has held unchanged for `stableMs` and at least one selector resolves
// uniquely. The clock lives on `window` and is keyed by the caller's token, so a later
// caller can never inherit an earlier one's stability. `stableMs` of 0 returns the
// current pass unconditionally, which is how the caller decides at its ceiling.
export function resolveAll(injectedScript: InjectedScript, selectors: string[], stableMs: number, token: string): ResolvePass | null {
  const ids = new Map<Element, number>();
  const matches: ResolveMatch[] = selectors.map(selector => {
    let elements: Element[];
    try {
      elements = injectedScript.querySelectorAll(injectedScript.parseSelector(selector), injectedScript.document);
    } catch {
      elements = [];
    }
    if (elements.length !== 1)
      return { id: null, count: elements.length };
    let id = ids.get(elements[0]);
    if (id === undefined) {
      id = ids.size;
      ids.set(elements[0], id);
    }
    return { id, count: 1 };
  });

  const signature = matches.map(m => m.id === null ? '-' : String(m.id)).join(',');
  const now = injectedScript.utils.builtins.Date.now();
  const win = injectedScript.window as any;
  let state: ResolveState | undefined = win.__zazuResolve;
  if (!state || state.token !== token || state.signature !== signature) {
    state = { token, signature, since: now };
    win.__zazuResolve = state;
  }
  if (stableMs > 0 && (ids.size === 0 || now - state.since < stableMs))
    return null;
  return { matches };
}
