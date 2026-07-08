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

import type { Recorder } from './recorder';
import type * as actions from '@recorder/actions';

type Point = { x: number, y: number };

// Qanary fork — hover inference engine (see zazu's docs/specs/hover-step-recording.md).
//
// Records a hover step only when it can be shown to have mattered:
//  1. Candidate — the pointer rests on an element (dwell), and/or
//  2. Reveal — while the pointer is over it, the page reveals new visible content
//     (menu mounts, tooltip appears, hidden/class/style toggles), and
//  3. Confirmation — the next committed action's target is inside the revealed
//     content (or the embedder asks to flush before an assertion).
// Only confirmed candidates are emitted — retroactively, immediately before the
// action that depends on them, as `hover` actions flagged `inferred: true`.
// Everything else is discarded silently.

const DWELL_MS = 300;
const DWELL_RADIUS_PX = 5;
const REVEAL_ATTRIBUTION_MS = 500;
// Safety cap for a single invisibility-seeding walk; beyond this the page is so
// large that missing a seed only costs a missed (optional) hover step.
const SEED_WALK_BUDGET = 15000;
// Fade-revealed menus settle after their transition/animation, long after the
// mutation batch. Re-evaluate elements whose reveal-capable properties finished
// transitioning; purely decorative transitions (colors, shadows) are ignored.
const REVEAL_TRANSITION_PROPS = new Set([
  'opacity', 'visibility', 'display', 'height', 'max-height', 'width', 'max-width',
  'transform', 'translate', 'scale', 'clip-path', 'clip', 'grid-template-rows',
]);
// Off-screen-positioned elements (`left: -9999px` menus) revealed by a pure-CSS
// :hover rule produce no mutation and no transition — they are polled from
// pointer events instead. The watch list holds strong references and is scanned
// per pointer entry, so it is capped; past the cap a missed (optional) hover
// step is the acceptable failure.
const OFFSCREEN_WATCH_LIMIT = 200;

type Candidate = {
  element: Element;
  // Captured at candidate creation: by confirmation time the DOM has changed
  // (menu open, aria-expanded flipped) and selectors could differ.
  selector: string;
  selectors?: string[];
  // Roots of content that became visible while the pointer was over `element`.
  // The mount parent is remembered so a root replaced wholesale (AJAX menus
  // swapping their loader for the rendered template) can fall back to its
  // container instead of costing the candidate — see _expireCandidates.
  revealed: { root: Element, parent: Element | null }[];
  hadReveal: boolean;
};

type EnteredEntry = { element: Element, at: number };

export class HoverInferenceEngine {
  private _recorder: Recorder;
  private _observer: MutationObserver;
  private _installed = false;
  private _seeded = false;
  private _reseededOnPointer = false;

  // Pointer state.
  private _lastTarget: Element | null = null;
  private _entered: EnteredEntry[] = [];
  private _dwellAnchor: Point | null = null;
  private _dwellTimer: number | undefined;

  // Candidate stack, oldest first (menu → submenu → …).
  private _candidates: Candidate[] = [];
  // Wall-clock time of the last committed action: reveals caused by a click
  // (click-to-open menus) must not be attributed to the hover that preceded it.
  private _lastActionAt = 0;

  // Elements known to be invisible (topmost of their invisible subtree), so an
  // attribute flip that makes one visible can be recognized as a reveal.
  private _invisible = new WeakSet<Element>();
  // Iterable subset of `_invisible`: elements hidden by off-screen positioning.
  // Their reveal fires no mutation and no transition (pure-CSS :hover moves
  // them on-screen), so pointer entries poll them via _scanOffscreenWatch().
  private _offscreenWatch = new Set<Element>();
  private _observedShadowRoots = new WeakSet<ShadowRoot>();

  // Mutation batching: collect per callback, evaluate visibility once per frame.
  private _pendingAdded = new Set<Element>();
  private _pendingAttributed = new Set<Element>();
  private _pendingClassFlipped = new Set<Element>();
  private _pendingRemoval = false;
  private _pendingReseed = false;
  private _rafScheduled = false;

  constructor(recorder: Recorder) {
    this._recorder = recorder;
    this._observer = new MutationObserver(mutations => this._onMutations(mutations));
  }

  install() {
    if (this._installed)
      return;
    this._installed = true;
    const document = this._recorder.document;
    const start = () => {
      if (!this._installed)
        return;
      this._observe(document);
      // Fade-revealed menus reach their settled state only when the transition
      // or animation ends — a rAF after the triggering mutation still computes
      // opacity ≈ 0. Re-evaluate the settled element then.
      document.addEventListener('transitionend', this._onTransitionSettled, true);
      document.addEventListener('animationend', this._onTransitionSettled, true);
      document.addEventListener('load', this._onStylesheetLoad, true);
      this._seedInvisible(document.documentElement);
      this._seeded = true;
    };
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', start, { once: true });
    else
      start();
    // Async-loaded CSS (WP Rocket's media="print" flip and friends) can apply
    // after DOMContentLoaded with no DOM mutation: menus seeded "visible" on the
    // unstyled page silently become display:none, and their later reveal is then
    // invisible to the engine. Re-seed once everything has loaded (reconciling —
    // nothing is interacting yet), and once more on the first pointer move (by
    // then styling is stable and hover inference is about to matter; additive
    // only, since enter events have already fired and a reconcile would erase
    // the seed of a menu whose opening flip is still awaiting its rAF batch).
    const window = document.defaultView;
    if (window && document.readyState !== 'complete')
      window.addEventListener('load', () => this._reseed(true), { once: true });
  }

  private _reseed(reconcile: boolean) {
    if (!this._installed || !this._seeded)
      return;
    this._seedInvisible(this._recorder.document.documentElement, reconcile);
  }

  uninstall() {
    this._installed = false;
    this._observer.disconnect();
    // disconnect() also drops the shadow-root subscriptions — forget them so a
    // reinstall (recording paused and resumed) re-observes the roots it rediscovers.
    this._observedShadowRoots = new WeakSet();
    this._recorder.document.removeEventListener('transitionend', this._onTransitionSettled, true);
    this._recorder.document.removeEventListener('animationend', this._onTransitionSettled, true);
    this._recorder.document.removeEventListener('load', this._onStylesheetLoad, true);
    this._clearDwellTimer();
    this._candidates = [];
    this._entered = [];
    this._lastTarget = null;
    this._pendingAdded.clear();
    this._pendingAttributed.clear();
    this._pendingClassFlipped.clear();
    this._offscreenWatch.clear();
    this._pendingReseed = false;
  }

  // Async CSS can finish loading after every scheduled re-seed (WP Rocket on a
  // cold cache: DOMContentLoaded, window load and the first pointer move have
  // all passed): the hiding rules then apply without any DOM mutation, and the
  // menus they hide were seeded "visible" — every reveal path goes dead. Watch
  // stylesheet arrival itself and re-seed additively (safe mid-interaction).
  private _onStylesheetLoad = (event: Event) => {
    if (!this._installed || !this._seeded)
      return;
    const target = event.target as Element | null;
    if (!target || target.nodeType !== 1 /* ELEMENT_NODE */ || target.nodeName !== 'LINK')
      return;
    if (!(target as HTMLLinkElement).relList?.contains('stylesheet'))
      return;
    this._pendingReseed = true;
    this._scheduleProcess();
  };

  private _onTransitionSettled = (event: Event) => {
    if (!this._installed || !this._seeded)
      return;
    if ((event as TransitionEvent).propertyName && !REVEAL_TRANSITION_PROPS.has((event as TransitionEvent).propertyName))
      return;
    const target = event.target as Node;
    if (target.nodeType !== 1 /* ELEMENT_NODE */)
      return;
    if (!this._candidates.length && this._isTypingContext())
      return;
    this._pendingAttributed.add(target as Element);
    this._scheduleProcess();
  };

  onPointerMove(event: MouseEvent, target: Element) {
    if (!this._installed)
      return;
    if (!this._reseededOnPointer) {
      this._reseededOnPointer = true;
      this._reseed(false);
    }
    const now = this._builtins().Date.now();
    if (target !== this._lastTarget) {
      this._lastTarget = target;
      this._entered.push({ element: target, at: now });
      const cutoff = now - REVEAL_ATTRIBUTION_MS;
      this._entered = this._entered.filter((entry, index) => entry.at >= cutoff || index === this._entered.length - 1);
      this._observeShadowPath(event);
      this._scanOffscreenWatch();
    }
    const point = { x: event.clientX, y: event.clientY };
    if (!this._dwellAnchor || Math.hypot(point.x - this._dwellAnchor.x, point.y - this._dwellAnchor.y) > DWELL_RADIUS_PX) {
      this._dwellAnchor = point;
      this._clearDwellTimer();
      this._dwellTimer = this._builtins().setTimeout(() => this._onDwell(), DWELL_MS);
    }
  }

  onScroll() {
    // Scroll changes the element under a stationary cursor without any pointer
    // movement — restart dwell tracking; stale candidates expire through the
    // usual reveal-visibility pruning.
    this._dwellAnchor = null;
    this._clearDwellTimer();
  }

  // Called with the target of the action that is about to be recorded. Returns
  // the hover actions to record immediately before it (oldest trigger first)
  // and flushes the candidate stack.
  confirmedHoversFor(target: Element): actions.HoverAction[] {
    this._lastActionAt = this._builtins().Date.now();
    const chain: Candidate[] = [];
    let anchor: Element = target;
    for (let i = this._candidates.length - 1; i >= 0; i--) {
      const candidate = this._candidates[i];
      // Never hover the action target itself; keep walking so an older
      // candidate that revealed it can still confirm.
      if (candidate.element === anchor)
        continue;
      if (candidate.revealed.some(({ root }) => root.isConnected && this._composedContains(root, anchor))) {
        chain.unshift(candidate);
        anchor = candidate.element;
      }
    }
    this._candidates = [];
    this._entered = [];
    return chain.map(candidate => this._hoverAction(candidate));
  }

  // Pre-assert flush: the currently showing candidates (their revealed content
  // is still visible) are what the assertion may depend on — tooltip checks.
  flushVisibleHovers(): actions.HoverAction[] {
    this._lastActionAt = this._builtins().Date.now();
    const alive = this._candidates.filter(candidate => candidate.revealed.some(({ root }) => root.isConnected && this._isVisible(root)));
    this._candidates = [];
    this._entered = [];
    return alive.map(candidate => this._hoverAction(candidate));
  }

  // Diagnostic snapshot for the __pw_recorderHoverDebug embedder global — hover
  // inference is timing-sensitive and effectively a black box in production;
  // this is the cheap way to see why a hover was (not) recorded on a live page.
  debugState() {
    return {
      entered: this._entered.map(entry => ({ desc: this._describe(entry.element), at: entry.at })),
      lastActionAt: this._lastActionAt,
      candidates: this._candidates.map(candidate => ({
        selector: candidate.selector,
        hadReveal: candidate.hadReveal,
        revealed: candidate.revealed.map(({ root }) => ({
          desc: this._describe(root),
          connected: root.isConnected,
          visible: root.isConnected && this._isVisible(root),
        })),
      })),
    };
  }

  private _describe(element: Element): string {
    const cls = element.classList ? [...element.classList].slice(0, 3).join('.') : '';
    return `${element.tagName?.toLowerCase()}${element.id ? '#' + element.id : ''}${cls ? '.' + cls : ''}`;
  }

  private _hoverAction(candidate: Candidate): actions.HoverAction {
    return {
      name: 'hover',
      selector: candidate.selector,
      selectors: candidate.selectors,
      signals: [],
      inferred: true,
    };
  }

  private _builtins() {
    return this._recorder.injectedScript.utils.builtins;
  }

  // Playwright's visibility deliberately ignores opacity, but fade menus hide
  // with `opacity: 0` (+ pointer-events: none) at full layout size — for reveal
  // purposes an opacity-0 element is invisible to the user. Same for off-screen
  // positioning (`left: -9999px`): displayed and opaque, yet unseeable. And
  // zero-size containers with visible overflow (Elementor sticky headers are
  // 1440×0) still render their children, so they count as visible when a child is.
  private _isVisible(element: Element): boolean {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style)
      return true;
    if (this._recorder.injectedScript.utils.isElementVisible(element))
      return +style.opacity > 0.01 && !this._isOffscreen(element);
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity <= 0.01)
      return false;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0)
      return false;
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible')
      return false;
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      if (this._isVisible(child))
        return true;
    }
    return false;
  }

  private _clearDwellTimer() {
    if (this._dwellTimer !== undefined) {
      this._builtins().clearTimeout(this._dwellTimer);
      this._dwellTimer = undefined;
    }
  }

  private _onDwell() {
    this._dwellTimer = undefined;
    // Stray events over dead space (headed browsers reconciling the OS cursor)
    // can leave _lastTarget on <body>; fall back to the last real element.
    const target = this._lastTarget && this._lastTarget.isConnected && !this._isPageRoot(this._lastTarget)
      ? this._lastTarget
      : this._lastMeaningfulTarget();
    if (target)
      this._getOrCreateCandidate(target);
    // A resting pointer is when pure-CSS :hover reveals (Suckerfish
    // `li:hover > ul { display: block }` — zero mutations) are showing.
    // Enqueue the document root: _process routes it through the recent-entry
    // check into _scanRevealedDescendants, sweeping for seeded-invisible
    // elements that are visible now.
    const root = this._recorder.document.documentElement;
    if (root) {
      this._pendingAttributed.add(root);
      this._scheduleProcess();
    }
  }

  // Pure-CSS :hover reveals of off-screen-positioned content leave no other
  // signal — poll the (small) watch list whenever the pointer enters a new
  // element. _process notices the invisible→visible flip, and re-registers
  // elements it finds back off-screen.
  private _scanOffscreenWatch() {
    for (const element of this._offscreenWatch) {
      if (!element.isConnected) {
        this._offscreenWatch.delete(element);
        continue;
      }
      this._pendingAttributed.add(element);
    }
    if (this._pendingAttributed.size)
      this._scheduleProcess();
  }

  private _watchOffscreen(element: Element) {
    if (this._offscreenWatch.size < OFFSCREEN_WATCH_LIMIT)
      this._offscreenWatch.add(element);
  }

  // The accessible-hiding idiom (WordPress menus: `.sub-menu { left: -9999px }`):
  // a full-size, CSS-visible box positioned entirely at negative document
  // coordinates, which no amount of scrolling can reach. Client rects are
  // viewport-relative, so translate by the scroll offset — content merely
  // scrolled out of view sits at positive document coordinates and stays visible.
  private _isOffscreen(element: Element): boolean {
    const window = element.ownerDocument.defaultView;
    if (!window)
      return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0)
      return false;
    return rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0;
  }

  private _getOrCreateCandidate(element: Element): Candidate | null {
    if (this._isPageRoot(element))
      return null;
    const existing = this._candidates.find(candidate => candidate.element === element);
    if (existing)
      return existing;
    const generated = this._recorder.generateSelector(element, { testIdAttributeName: this._recorder.state.testIdAttributeName });
    if (!generated.selector)
      return null;
    const candidate: Candidate = { element, selector: generated.selector, selectors: generated.selectors, revealed: [], hadReveal: false };
    this._candidates.push(candidate);
    return candidate;
  }

  private _observe(target: Node) {
    // 'media' is watched for WP Rocket's async-CSS delivery: <link media="print">
    // flipped to media="all" once fetched — the flip is when the CSS applies.
    this._observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'media'] });
  }

  // A document-level observer does not see into shadow trees; observe every open
  // shadow root the pointer travels through (and any found while seeding).
  private _observeShadowPath(event: Event) {
    for (const node of event.composedPath()) {
      if ((node as Node).nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && (node as ShadowRoot).host)
        this._observeShadowRoot(node as ShadowRoot);
    }
  }

  private _observeShadowRoot(root: ShadowRoot) {
    if (this._observedShadowRoots.has(root))
      return;
    this._observedShadowRoots.add(root);
    this._observe(root);
  }

  // Walk `root`, registering the topmost invisible element of each invisible
  // subtree (their descendants are skipped — a reveal must flip the boundary
  // element itself to change what the user sees). With `reconcile`, visible
  // elements are also removed from the set: styling may have changed since a
  // previous walk (async-loaded CSS), and a stale entry would turn a later
  // class flip on a visible element into a false reveal. Reconciling is only
  // safe while nothing is interacting — a menu that just opened still has its
  // flip pending in the rAF batch, and deleting its seed would erase the
  // reveal evidence. Uses the native checkVisibility fast path where available
  // to avoid getComputedStyle per node.
  private _seedInvisible(root: Element | null, reconcile = false) {
    if (!root)
      return;
    const stack: Element[] = [root];
    let budget = SEED_WALK_BUDGET;
    while (stack.length && budget-- > 0) {
      const element = stack.pop()!;
      if (element.nodeName.toLowerCase().startsWith('x-pw-'))
        continue;
      if (!this._isVisibleForSeeding(element)) {
        this._invisible.add(element);
        if (this._isOffscreen(element))
          this._watchOffscreen(element);
        continue;
      }
      if (reconcile && !this._pendingAttributed.has(element) && !this._pendingAdded.has(element))
        this._invisible.delete(element);
      if (element.shadowRoot) {
        this._observeShadowRoot(element.shadowRoot);
        for (let child = element.shadowRoot.firstElementChild; child; child = child.nextElementSibling)
          stack.push(child);
      }
      for (let child = element.firstElementChild; child; child = child.nextElementSibling)
        stack.push(child);
    }
  }

  // Decides whether the seed walk treats `element` as an invisible boundary
  // (returns false: added to the set, subtree skipped). Zero-size elements only
  // hide their subtree when they also clip it — with visible overflow the
  // children still render (zero-height sticky headers), so the walk descends.
  private _isVisibleForSeeding(element: Element): boolean {
    const checkVisibility = (element as HTMLElement).checkVisibility;
    if (typeof checkVisibility === 'function') {
      // Both option spellings: checkOpacity/checkVisibilityCSS are the legacy
      // names, opacityProperty/visibilityProperty the current spec's.
      if (!checkVisibility.call(element, { checkVisibilityCSS: true, visibilityProperty: true, checkOpacity: true, opacityProperty: true } as any)) {
        // display: contents has no box, so checkVisibility reports it hidden —
        // but its children render. Seeding it as an invisible boundary would
        // disagree with _isVisible (which judges it by its children) and turn
        // it into a false reveal on the next re-evaluation; descend instead.
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        return !!style && style.display === 'contents';
      }
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        return !this._isOffscreen(element);
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return !style || (style.overflowX === 'visible' && style.overflowY === 'visible');
    }
    return this._isVisible(element);
  }

  private _onMutations(mutations: MutationRecord[]) {
    if (!this._installed || !this._seeded)
      return;
    if (this._recorder.document.hidden)
      return;
    // Typing storms mutate the DOM constantly; with focus in an editable and no
    // candidate alive there is no hover in flight to attribute reveals to.
    if (!this._candidates.length && this._isTypingContext())
      return;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 /* ELEMENT_NODE */)
            this._pendingAdded.add(node as Element);
        }
        if (mutation.removedNodes.length)
          this._pendingRemoval = true;
      } else if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
        const element = mutation.target as Element;
        if (mutation.attributeName === 'media' && (element.nodeName === 'LINK' || element.nodeName === 'STYLE')) {
          this._pendingReseed = true;
        } else {
          this._pendingAttributed.add(element);
          if (mutation.attributeName === 'class')
            this._pendingClassFlipped.add(element);
        }
      }
    }
    this._scheduleProcess();
  }

  private _isTypingContext(): boolean {
    let active = this._recorder.document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement)
      active = active.shadowRoot.activeElement;
    if (!active)
      return false;
    return ['INPUT', 'TEXTAREA'].includes(active.nodeName) || (active as HTMLElement).isContentEditable;
  }

  private _scheduleProcess() {
    if (this._rafScheduled)
      return;
    this._rafScheduled = true;
    // Visibility is evaluated one frame after the mutation batch: a class flip
    // that opens a menu via transition can still compute as hidden at mutation time.
    this._builtins().requestAnimationFrame(() => {
      this._rafScheduled = false;
      this._process();
    });
  }

  private _process() {
    if (!this._installed)
      return;
    const added = [...this._pendingAdded];
    const attributed = [...this._pendingAttributed];
    const classFlipped = this._pendingClassFlipped;
    const hadRemoval = this._pendingRemoval;
    this._pendingAdded.clear();
    this._pendingAttributed.clear();
    this._pendingClassFlipped = new Set();
    this._pendingRemoval = false;

    // Late-arriving CSS (link load, media flip, or an injected <style> — WP
    // Rocket's Remove Unused CSS) can hide menus that were seeded "visible";
    // re-seed additively before evaluating the batch.
    let reseed = this._pendingReseed;
    this._pendingReseed = false;
    for (const element of added) {
      if (element.nodeName === 'STYLE' || (element.nodeName === 'LINK' && (element as HTMLLinkElement).relList?.contains('stylesheet')))
        reseed = true;
    }
    if (reseed)
      this._seedInvisible(this._recorder.document.documentElement);

    const reveals: Element[] = [];

    // Added nodes: evaluate topmost roots only — children of a newly visible
    // root are visible with it.
    const addedSet = new Set(added);
    for (const element of added) {
      if (!element.isConnected || this._isRecorderElement(element))
        continue;
      let topmost = true;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (addedSet.has(parent)) {
          topmost = false;
          break;
        }
      }
      if (!topmost)
        continue;
      // Growth inside an already-revealed region is not a new reveal, but its
      // hidden parts (submenus) must still be seeded for later attribute flips.
      const insideRevealed = this._candidates.some(candidate => candidate.revealed.some(({ root }) => root.isConnected && this._composedContains(root, element)));
      if (!insideRevealed && this._isVisible(element))
        reveals.push(element);
      this._seedInvisible(element);
    }

    // Attribute flips: a reveal is an element previously known invisible that is
    // visible now. This intentionally also fires inside revealed regions —
    // nested submenus toggle within their parent menu.
    for (const element of attributed) {
      if (!element.isConnected || this._isRecorderElement(element))
        continue;
      const visible = this._isVisible(element);
      if (visible && this._invisible.has(element)) {
        this._invisible.delete(element);
        reveals.push(element);
        this._seedInvisible(element);
      } else if (!visible) {
        this._invisible.add(element);
        if (this._isOffscreen(element))
          this._watchOffscreen(element);
      } else {
        if (this._containsRecentEntry(element)) {
          // A class/style flip on a visible element can reveal hidden descendants
          // purely via CSS (Beaver Builder navs: JS toggles a state class on the
          // trigger <li>, and `li.focus > ul.sub-menu { display: block }` does the
          // showing — the submenu element itself never mutates). Only hover-caused
          // flips matter, so scan only elements on the pointer's entered chain.
          this._scanRevealedDescendants(element, reveals);
        }
        // The same kind of flip can also HIDE descendants purely via CSS
        // (JetMenu closing: the `--hover` class leaves the <li> and the panel —
        // which never mutates itself — re-hides). Re-register them, or the next
        // reveal of the same menu has nothing to flip. Class flips only: style
        // mutations arrive per animation frame, and animated hiding sets style
        // on the hidden element itself, which self-registers above.
        if (classFlipped.has(element))
          this._seedInvisible(element);
      }
    }

    for (const reveal of reveals)
      this._attributeReveal(reveal);

    if (hadRemoval || attributed.length)
      this._expireCandidates();
  }

  // <body> and <html> can never be meaningful hover triggers (replaying a body
  // hover does nothing), yet the pointer regularly parks on them — over dead
  // space while waiting for slow menu content, or via stray OS-cursor events in
  // headed browsers. They must not anchor dwell or reveal attribution.
  private _isPageRoot(element: Element): boolean {
    return element === element.ownerDocument.body || element === element.ownerDocument.documentElement;
  }

  // The most recent entered element that could actually be hovered on replay.
  private _lastMeaningfulTarget(): Element | null {
    for (let i = this._entered.length - 1; i >= 0; i--) {
      const element = this._entered[i].element;
      if (element.isConnected && !this._isPageRoot(element))
        return element;
    }
    return null;
  }

  // Attribute a reveal to the innermost element the pointer entered within the
  // grace window (hover-intent libraries and animations mount content well after
  // the pointer entered the trigger, possibly after it moved on).
  private _attributeReveal(reveal: Element) {
    const now = this._builtins().Date.now();
    const lastMeaningful = this._lastMeaningfulTarget();
    for (let i = this._entered.length - 1; i >= 0; i--) {
      const entry = this._entered[i];
      // Reveals caused by a committed action (click-to-open menus) are that
      // action's doing, not the hover that happened to precede it.
      if (entry.at <= this._lastActionAt)
        break;
      // Skipped before the window check: a fresh body entry must not shadow the
      // (possibly older) trigger the pointer actually came from.
      if (this._isPageRoot(entry.element))
        continue;
      const inWindow = entry.at >= now - REVEAL_ATTRIBUTION_MS || entry.element === this._lastTarget || entry.element === lastMeaningful;
      if (!inWindow)
        break;
      if (!entry.element.isConnected)
        continue;
      // The pointer may already be inside the content that just appeared under
      // it — never attribute a reveal to an element it contains.
      if (reveal === entry.element || this._composedContains(reveal, entry.element))
        continue;
      const candidate = this._getOrCreateCandidate(entry.element);
      if (candidate) {
        candidate.revealed.push({ root: reveal, parent: reveal.parentElement });
        candidate.hadReveal = true;
      }
      return;
    }
    // Slow fades settle after the entered window has moved on (the pointer may
    // already be traveling through the fading menu). Dwell candidates are the
    // durable anchors — and the whole stack flushes on every committed action,
    // so this cannot resurrect a click-opened menu's trigger.
    for (let i = this._candidates.length - 1; i >= 0; i--) {
      const candidate = this._candidates[i];
      if (!candidate.element.isConnected)
        continue;
      if (reveal === candidate.element || this._composedContains(reveal, candidate.element))
        continue;
      candidate.revealed.push({ root: reveal, parent: reveal.parentElement });
      candidate.hadReveal = true;
      return;
    }
  }

  // True when the element is (an ancestor of) something the pointer entered
  // recently — the same eligibility attribution uses.
  private _containsRecentEntry(element: Element): boolean {
    const now = this._builtins().Date.now();
    for (let i = this._entered.length - 1; i >= 0; i--) {
      const entry = this._entered[i];
      if (entry.at <= this._lastActionAt)
        break;
      if (entry.at < now - REVEAL_ATTRIBUTION_MS && entry.element !== this._lastTarget)
        continue;
      if (element === entry.element || this._composedContains(element, entry.element))
        return true;
    }
    return false;
  }

  // Finds seeded-invisible descendants of `root` that are visible now (revealed
  // as a CSS side effect of a state flip on `root`). Walks only the visible
  // portion of the subtree; still-hidden boundaries are skipped whole.
  private _scanRevealedDescendants(root: Element, reveals: Element[]) {
    const stack: Element[] = [];
    for (let child = root.firstElementChild; child; child = child.nextElementSibling)
      stack.push(child);
    let budget = SEED_WALK_BUDGET;
    while (stack.length && budget-- > 0) {
      const element = stack.pop()!;
      if (element.nodeName.toLowerCase().startsWith('x-pw-'))
        continue;
      if (this._invisible.has(element)) {
        if (this._isVisible(element)) {
          this._invisible.delete(element);
          reveals.push(element);
          this._seedInvisible(element);
        }
        continue;
      }
      if (element.shadowRoot) {
        for (let child = element.shadowRoot.firstElementChild; child; child = child.nextElementSibling)
          stack.push(child);
      }
      for (let child = element.firstElementChild; child; child = child.nextElementSibling)
        stack.push(child);
    }
  }

  // Candidates expire when their revealed content leaves the DOM. Visibility is
  // deliberately NOT checked here: animated menus dip through hidden states
  // mid-interaction (fades, JetMenu panels while the pointer crosses the gap),
  // and one rAF batch catching such a dip must not erase the candidate. The
  // confirm step needs no visibility guard anyway — hidden content cannot be
  // clicked, so a committed action inside the root proves the reveal still
  // mattered; the pre-assert flush checks visibility itself at flush time.
  // A disconnected root falls back to its mount parent first: AJAX menus
  // (JetMenu Elementor templates) replace their first-mounted loader with the
  // rendered content, and losing the root must not cost the trigger candidate.
  // Body-level parents stay dropped — a portal's parent spans the whole page
  // and would let any later click confirm a stale hover.
  private _expireCandidates() {
    for (const candidate of this._candidates) {
      candidate.revealed = candidate.revealed.flatMap(entry => {
        if (entry.root.isConnected)
          return [entry];
        const parent = entry.parent;
        if (!parent || !parent.isConnected)
          return [];
        const document = parent.ownerDocument;
        if (parent === document.body || parent === document.documentElement)
          return [];
        return [{ root: parent, parent: parent.parentElement }];
      });
    }
    this._candidates = this._candidates.filter(candidate => !candidate.hadReveal || candidate.revealed.length);
  }

  private _composedContains(root: Element, descendant: Element): boolean {
    let node: Node | null = descendant;
    while (node) {
      if (node === root)
        return true;
      node = node.parentNode || ((node as ShadowRoot).host ?? null);
    }
    return false;
  }

  // The recorder's own overlay (x-pw-glass and friends) mounts and mutates
  // around user interactions. It is not page content: counting it as a reveal
  // both pollutes attribution and — being permanently connected — keeps
  // candidates alive that should have expired.
  private _isRecorderElement(element: Element): boolean {
    for (let node: Node | null = element; node; node = node.parentNode || ((node as ShadowRoot).host ?? null)) {
      if (node.nodeType === 1 /* ELEMENT_NODE */ && (node as Element).nodeName.toLowerCase().startsWith('x-pw-'))
        return true;
    }
    return false;
  }
}
