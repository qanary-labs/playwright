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
 * Qanary fork: collects the many selectors that resolve to a target element, rather
 * than the one-per-family shortlist `generateSelector` emits. Kept out of
 * `selectorGenerator.ts` so that file carries thin hooks only (rebase surface), and
 * because every policy decision here is ours, not upstream's.
 *
 * The hard rule this module exists to respect: **nothing collected here may reach a
 * `combineScores` comparison inside the generator**. Collection observes the
 * enumeration and adds candidates of its own; selection - which selector becomes the
 * primary, and therefore the legacy `selectors` list - behaves exactly as before.
 *
 * See zazu's `docs/specs/weighted-locator-generation.md`.
 */

import { quoteCSSAttributeValue } from '@isomorphic/stringUtils';

import type { InjectedScript } from './injectedScript';

// Structurally identical to selectorGenerator's SelectorToken. Declared here rather
// than imported so this module has no cycle with the file that hooks into it.
export type CollectorToken = { engine: string, selector: string, score: number };

// New score constants, on the engine's existing scale (lower is stronger). They sit
// between kCSSIdScore (500) and kNthScore (10000) so collected attribute and class
// candidates rank where they belong instead of in the kCSSFallbackScore bucket.
export const kCSSAttributeScore = 520;
export const kCSSClassScore = 600;

const kCSSFallbackScore = 10000000;
// Structural paths all score kCSSFallbackScore, which leaves a three-level path
// indistinguishable from an eight-level one. Emitted scores carry a depth term so
// shallow paths outrank deep ones; it is far below the gap to the next band, so it
// never reorders families.
const kStructuralDepthPenalty = 1000;

const kDefaultMaxSelectors = 10;
// How far up the ancestor chain to look for an anchor, and how many usable ones to take
// per candidate. Nearest-first, so a candidate anchors on the container that actually
// scopes it (the repeated card, the form) rather than on a page-level landmark it
// reaches later. Also bounds the extra work collection asks the generator to do.
export const kMaxAnchorAncestors = 6;
export const kMaxAnchorsPerCandidate = 2;
const kAttributeValueMaxLength = 80;
const kMaxClassTokens = 4;
// Above this, a mixed-case name is long enough to be spelling words rather than hashing.
const kMaxRandomSegmentLength = 12;
// Attributes worth locating by that the engine never builds candidates from. `href`
// is the useful one: a link's destination is independent evidence from its text.
const kStableAttributes = ['href', 'name', 'type', 'role', 'alt', 'title'];

type Family = 'testId' | 'role' | 'label' | 'attr' | 'text' | 'cssAttr' | 'cssId' | 'css' | 'structural' | 'nth';

type Entry = {
  selector: string;
  score: number;
  family: Family;
  order: number;
  // Chains carry the identity of both halves so the set can avoid holding the same
  // evidence twice (same anchor element + same target candidate).
  anchorKey?: number;
  targetKey?: string;
};

export type CollectedSelector = { selector: string, score: number };

export class SelectorCollector {
  private _entries = new Map<string, Entry>();
  private _chains: Entry[] = [];
  private _chainPairs = new Set<string>();
  private _anchorKeys = new WeakMap<Element, number>();
  private _lastAnchorKey = 0;
  private _order = 0;
  private _max: number;

  constructor(max: number | undefined, private _join: (tokens: CollectorToken[]) => string, private _combine: (tokens: CollectorToken[]) => number) {
    this._max = Math.max(1, max ?? kDefaultMaxSelectors);
  }

  max(): number {
    return this._max;
  }

  // A candidate the enumeration produced. Also called for candidates the generator
  // itself is comparing - observing them changes nothing about that comparison.
  add(tokens: CollectorToken[] | null) {
    if (tokens)
      this._store(tokens, undefined, undefined);
  }

  // A chain (anchor >> target). Kept apart so the emitted set can interleave chains
  // from different target candidates instead of letting the best one take every anchor.
  addChain(anchorTokens: CollectorToken[], targetTokens: CollectorToken[], anchor: Element) {
    const targetKey = this._join(targetTokens);
    const anchorKey = this._anchorKey(anchor);
    const pair = `${anchorKey}|${targetKey}`;
    if (this._chainPairs.has(pair))
      return;
    this._chainPairs.add(pair);
    this._store([...anchorTokens, ...targetTokens], anchorKey, targetKey);
  }

  // Whether a chain through this anchor is still wanted. Bounds the ancestor walk the
  // generator does on our behalf, so collection cannot turn into a quadratic crawl.
  wantsChain(anchor: Element, targetTokens: CollectorToken[]): boolean {
    if (this._chains.length >= this._max * 2)
      return false;
    // `body` and `html` always exist, so a chain through them cannot fail differently
    // from its target half: it is the same evidence, one token longer.
    if (anchor.nodeName === 'BODY' || anchor.nodeName === 'HTML')
      return false;
    return !this._chainPairs.has(`${this._anchorKey(anchor)}|${this._join(targetTokens)}`);
  }

  // The anchor to build a chain from: the strongest of the parent's own best tokens and
  // the collect-only candidates the engine never builds for it - a stable attribute or a
  // unique class. This is what turns `div:nth-child(39) >> …` into
  // `[data-idx="38"] >> …`: the engine has no candidate for a non-testid `data-*`
  // attribute, so without it every anchor in a repeated list is positional.
  anchorTokensFor(injectedScript: InjectedScript, anchor: Element, parentTokens: CollectorToken[], root: Element | Document | undefined): CollectorToken[] | null {
    let best = parentTokens;
    let bestScore = this._combine(parentTokens);
    for (const token of collectOnlyTokens(injectedScript, anchor, root)) {
      const score = this._combine([token]);
      if (score < bestScore) {
        best = [token];
        bestScore = score;
      }
    }
    // What a chain insures against is the target half becoming *ambiguous* - a second
    // "Open 38" link appearing elsewhere - not the target's own properties changing. An
    // anchor that can only be named by its position is no scope at all: chaining through
    // it re-states the structural path already in the set, one token longer, and dies
    // with it. Refusing here is what keeps the tail from filling with near-copies.
    if (best.some(token => token.score === kCSSFallbackScore))
      return null;
    return best;
  }

  // Candidates the engine has no notion of, built from the target element alone.
  // Collect-only by construction: they are never handed back to the generator.
  addCollectOnlyCandidates(injectedScript: InjectedScript, element: Element, root: Element | Document | undefined) {
    for (const token of collectOnlyTokens(injectedScript, element, root))
      this.add([token]);
  }

  // `required` are the legacy `selectors`, which must survive the caps: the emitted set
  // is a superset of the old one, so a consumer can switch to it wholesale.
  build(verify: (selector: string) => boolean, required: string[]): CollectedSelector[] {
    const requiredSet = new Set(required);
    const byScore = [...this._entries.values()].sort(compareEntries);
    const picked: Entry[] = [];
    const seen = new Set<string>();
    const seenEvidence = new Set<string>();
    const familyCount = new Map<Family, number>();
    const anchorCount = new Map<number, number>();

    const take = (entry: Entry, ignoreCaps: boolean, admitGenerated = false) => {
      if (seen.has(entry.selector) || picked.length >= this._max)
        return;
      // A build-generated class is refused even when it is the legacy selector, which is
      // the one documented exception to the superset contract (see the spec's Contract
      // change): the contract exists so a consumer loses no coverage by switching to this
      // list, and an expression that is guaranteed to stop resolving at the target site's
      // next build is not coverage. The last-resort pass below keeps the floor - a step is
      // never left with nothing - so the exception can never empty a set.
      if (!admitGenerated && hasGeneratedClass(entry.selector))
        return;
      const evidence = evidenceKey(entry.selector);
      if (!ignoreCaps) {
        // `[name="Open 38"i]` and `[name="Open 38"s]` are one fact in two spellings -
        // they match with different strictness but rot together. Keeping both spends a
        // slot that a different failure mode should have.
        if (seenEvidence.has(evidence))
          return;
        if (!this._withinCaps(entry, familyCount))
          return;
        // No anchor may carry the set: chains through one ancestor all die with it.
        if (entry.anchorKey !== undefined && (anchorCount.get(entry.anchorKey) ?? 0) >= 2)
          return;
      }
      if (!verify(entry.selector))
        return;
      seen.add(entry.selector);
      seenEvidence.add(evidence);
      familyCount.set(entry.family, (familyCount.get(entry.family) ?? 0) + 1);
      if (entry.anchorKey !== undefined)
        anchorCount.set(entry.anchorKey, (anchorCount.get(entry.anchorKey) ?? 0) + 1);
      picked.push(entry);
    };

    for (const entry of byScore) {
      if (requiredSet.has(entry.selector))
        take(entry, true);
    }
    for (const entry of byScore) {
      if (!requiredSet.has(entry.selector))
        take(entry, false);
    }
    for (const entry of this._interleavedChains()) {
      if (picked.length >= this._max)
        break;
      take(entry, false);
    }
    // Last resort: an element the page names only by a generated class still has to be
    // addressable. Better a locator that breaks at the next build than no locator at all.
    if (!picked.length) {
      for (const entry of byScore)
        take(entry, requiredSet.has(entry.selector), true);
    }

    return picked
        .sort(compareEntries)
        .map(entry => ({ selector: entry.selector, score: entry.score }));
  }

  private _store(tokens: CollectorToken[], anchorKey: number | undefined, targetKey: string | undefined) {
    const selector = this._join(tokens);
    const score = emittedScore(tokens, this._combine(tokens));
    const existing = this._entries.get(selector);
    if (existing && existing.score <= score)
      return;
    const entry: Entry = { selector, score, family: classify(tokens), order: this._order++, anchorKey, targetKey };
    this._entries.set(selector, entry);
    if (targetKey !== undefined)
      this._chains.push(entry);
  }

  // Chains ordered so each target candidate contributes its best chain before any
  // candidate contributes its second: three chains that differ only in how far up the
  // ancestor chain they anchor are nearly the same locator, three that re-express
  // different primitives are not.
  private _interleavedChains(): Entry[] {
    const byTarget = new Map<string, Entry[]>();
    for (const entry of this._chains.sort(compareEntries)) {
      const bucket = byTarget.get(entry.targetKey!) ?? [];
      bucket.push(entry);
      byTarget.set(entry.targetKey!, bucket);
    }
    const rounds: Entry[] = [];
    for (let round = 0; ; round++) {
      const inRound = [...byTarget.values()].map(bucket => bucket[round]).filter(Boolean);
      if (!inRound.length)
        break;
      rounds.push(...inRound.sort(compareEntries));
    }
    return rounds;
  }

  // Family caps, as fractions or small constants, so they hold at any budget. They are
  // deliberately tight on the semantic families: a role selector by exact name, by
  // normalized name and by name+description are three spellings of one fact - the
  // accessible name - and they die together. Two is enough to keep the best spellings
  // without spending half a budget on evidence that cannot disagree with itself.
  private _withinCaps(entry: Entry, familyCount: Map<Family, number>): boolean {
    const count = familyCount.get(entry.family) ?? 0;
    if (entry.family === 'cssAttr')
      return count < 3;
    // Structural entries are correlated with each other by construction - they all read
    // the same ancestor chain - so a second one is nearly free of new information.
    return count < 2;
  }

  private _anchorKey(element: Element): number {
    let key = this._anchorKeys.get(element);
    if (key === undefined) {
      key = ++this._lastAnchorKey;
      this._anchorKeys.set(element, key);
    }
    return key;
  }
}

function compareEntries(a: Entry, b: Entry): number {
  return a.score - b.score || a.order - b.order;
}

// Identity of what a selector *reads*, ignoring how strictly it matches it: the engine
// emits both a normalized (`"text"i`) and an exact (`"text"s`) spelling of the same
// string, and a set holding both is a set holding one piece of evidence twice.
function evidenceKey(selector: string): string {
  return selector.replace(/(["'])[is](?![\w-])/g, '$1');
}

// Whether any css part of a selector names an element by a build-generated class. Only
// css parts are read: a `.` inside `internal:text="…"` is punctuation in a sentence, not
// a class.
function hasGeneratedClass(selector: string): boolean {
  return selector.split('>>').some(part => {
    const token = part.trim();
    if (token.startsWith('internal:') || token.startsWith('nth='))
      return false;
    return (token.match(/\.([A-Za-z_-][\w-]*)/g) ?? [])
        .some(className => isGeneratedClassName(className.slice(1)));
  });
}

// Emitted score = the engine's combined score, plus a depth term for structural paths
// (see kStructuralDepthPenalty). Selection never sees this number.
function emittedScore(tokens: CollectorToken[], combined: number): number {
  const structural = tokens.find(token => token.score === kCSSFallbackScore);
  if (!structural)
    return combined;
  const depth = structural.selector.split('>').length;
  return combined + depth * kStructuralDepthPenalty;
}

function classify(tokens: CollectorToken[]): Family {
  if (tokens.some(token => token.engine === 'nth'))
    return 'nth';
  if (tokens.some(token => token.score === kCSSFallbackScore))
    return 'structural';
  const engines = tokens.map(token => token.engine);
  if (engines.includes('internal:testid') || tokens.some(token => token.engine === 'css' && token.selector.startsWith('[data-test')))
    return 'testId';
  if (engines.includes('internal:role'))
    return 'role';
  if (engines.includes('internal:label'))
    return 'label';
  if (engines.includes('internal:attr'))
    return 'attr';
  if (engines.includes('internal:text') || engines.includes('internal:has-text'))
    return 'text';
  if (tokens.some(token => token.engine === 'css' && (token.selector.startsWith('#') || token.selector.startsWith('[id='))))
    return 'cssId';
  if (tokens.some(token => token.engine === 'css' && token.selector.includes('[')))
    return 'cssAttr';
  return 'css';
}

function buildAttributeTokens(element: Element): CollectorToken[] {
  const tokens: CollectorToken[] = [];
  const attributes = new Set(kStableAttributes);
  for (const attribute of element.getAttributeNames()) {
    if (attribute.startsWith('data-') && !attribute.startsWith('data-test'))
      attributes.add(attribute);
  }
  for (const attribute of attributes) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > kAttributeValueMaxLength || isGuidLike(value))
      continue;
    // A URL carrying a query string or a fragment is a session artifact wearing a
    // locator's clothes; the attribute selector would match it literally.
    if (attribute === 'href' && /[?#]/.test(value))
      continue;
    tokens.push({ engine: 'css', selector: `${escapeNodeName(element)}[${attribute}=${quoteCSSAttributeValue(value)}]`, score: kCSSAttributeScore });
  }
  return tokens;
}

// Candidates the enumeration never builds, for any element: stable attributes the
// engine ignores (notably non-testid `data-*` and `href`) and a unique class. Verified
// here rather than at build time because anchors are chosen from these before the
// emitted set exists.
function collectOnlyTokens(injectedScript: InjectedScript, element: Element, root: Element | Document | undefined): CollectorToken[] {
  const tokens: CollectorToken[] = [];
  const scope: Node = root ?? element.ownerDocument;
  const resolvesAlone = (selector: string) => {
    try {
      const matches = injectedScript.querySelectorAll(injectedScript.parseSelector(selector), scope);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };
  for (const token of buildAttributeTokens(element)) {
    if (resolvesAlone(token.selector))
      tokens.push(token);
  }
  const classToken = uniqueClassToken(injectedScript, element, root);
  if (classToken)
    tokens.push(classToken);
  return tokens;
}

// Shortest class combination that resolves to this element alone, or null.
function uniqueClassToken(injectedScript: InjectedScript, element: Element, root: Element | Document | undefined): CollectorToken | null {
  const classes = [...element.classList].slice(0, kMaxClassTokens)
      .map(escapeClassName).filter(name => name && !isGeneratedClassName(name));
  const scope: Node = root ?? element.ownerDocument;
  for (let i = 0; i < classes.length; ++i) {
    const selector = '.' + classes.slice(0, i + 1).join('.');
    const matches = injectedScript.querySelectorAll(injectedScript.parseSelector(selector), scope);
    if (matches.length === 1 && matches[0] === element)
      return { engine: 'css', selector, score: kCSSClassScore };
  }
  return null;
}

// Local copies of two selectorGenerator helpers: importing them would create a cycle
// with the file that imports this module, and both are three lines.
function escapeNodeName(node: Node): string {
  return node.nodeName.toLocaleLowerCase().replace(/[:\.]/g, char => '\\' + char);
}

function escapeClassName(className: string): string {
  return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(className) ? className : '';
}

// A class token no human named: CSS-in-JS runtime names (`sc-imWYAI`, `css-1a2b3c`),
// CSS-module suffixes (`Button_root__2xY9z`), page-builder element ids
// (`elementor-element-1f1818a`). They are stable for the lifetime of one build of the
// target site and change at the next one, so a locator anchored on them resolves the
// moment it is recorded and fails in production - strictly worse than not collecting it,
// because it occupies a slot a durable candidate would have had.
//
// Recognised by shape, never by framework: a build tool is the only thing that produces
// a name segment which is random rather than descriptive. Hand-written names stay:
// `card__body`, `single_add_to_cart_button`, `col-md-6`, `text-2xl` and camelCase like
// `ecomGalleryMainSlide` all read as words, and none of the rules below fire on words.
function isGeneratedClassName(className: string): boolean {
  return className.split(/[-_]/).some(isRandomSegment);
}

function isRandomSegment(segment: string): boolean {
  if (segment.length < 5)
    return false;
  // A run of three or more capitals inside a short mixed-case token: `imWYAI`, `GTVdH`.
  // Length matters: a written name long enough to spell words may legitimately end in an
  // acronym (`espaceDeTravailDDC`), while a runtime name is a handful of characters.
  if (segment.length <= kMaxRandomSegmentLength && /[a-z]/.test(segment) && /[A-Z]{3,}/.test(segment))
    return true;
  // Two or more digits interleaved with letters: `1f1818a`, `2xY9z`, `d06785f`. One digit
  // is how people version and number things - `wpcf7-form-control`, `h2`, `col-md-6` are
  // names, not hashes - so a single digit is never enough on its own.
  if ((segment.match(/[0-9]/g) ?? []).length >= 2 && /[a-zA-Z]/.test(segment))
    return true;
  // Case alternating faster than any word does: `hUyBqQ`, the second class CSS-in-JS
  // runtimes emit beside `sc-…`. Upstream's own test for a generated `id`, reused.
  return isGuidLike(segment);
}

function isGuidLike(value: string): boolean {
  let lastCharacterType: 'lower' | 'upper' | 'digit' | 'other' | undefined;
  let transitionCount = 0;
  for (let i = 0; i < value.length; ++i) {
    const c = value[i];
    let characterType: 'lower' | 'upper' | 'digit' | 'other';
    if (c === '-' || c === '_')
      continue;
    if (c >= 'a' && c <= 'z')
      characterType = 'lower';
    else if (c >= 'A' && c <= 'Z')
      characterType = 'upper';
    else if (c >= '0' && c <= '9')
      characterType = 'digit';
    else
      characterType = 'other';
    if (characterType === 'lower' && lastCharacterType === 'upper') {
      lastCharacterType = characterType;
      continue;
    }
    if (lastCharacterType && lastCharacterType !== characterType)
      ++transitionCount;
    lastCharacterType = characterType;
  }
  return transitionCount >= value.length / 4;
}
