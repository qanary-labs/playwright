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

import { renderTitleForCall } from '@isomorphic/protocolFormatter';
import { raceAgainstDeadline } from '@isomorphic/timeoutRunner';
import { monotonicTime } from '@isomorphic/time';
import { quoteCSSAttributeValue } from '@isomorphic/stringUtils';
import { Frame } from '../frames';

import type { CallMetadata } from '../instrumentation';
import type { Page } from '../page';
import type * as actions from '@recorder/actions';
import type { CallLog, CallLogStatus } from '@recorder/recorderTypes';
import type { Progress } from '@protocol/progress';

type RankedSelector = actions.RankedSelector;

// `kCSSFallbackScore` in the injected selector generator, restated here because server
// code cannot import from the injected bundle. Only the fallback below uses it.
const kUnverifiedFrameScore = 10000000;

export function buildFullSelector(framePath: string[], selector: string) {
  return [...framePath, selector].join(' >> internal:control=enter-frame >> ');
}

export function metadataToCallLog(metadata: CallMetadata, status: CallLogStatus): CallLog {
  const title = renderTitleForCall(metadata);
  if (metadata.error)
    status = 'error';
  const params = {
    url: metadata.params?.url,
    selector: metadata.params?.selector,
  };
  let duration = metadata.endTime ? metadata.endTime - metadata.startTime : undefined;
  if (typeof duration === 'number' && metadata.pauseStartTime && metadata.pauseEndTime) {
    duration -= (metadata.pauseEndTime - metadata.pauseStartTime);
    duration = Math.max(duration, 0);
  }
  const callLog: CallLog = {
    id: metadata.id,
    messages: metadata.log,
    title: title ?? '',
    status,
    error: metadata.error?.error?.message,
    params,
    duration,
  };
  return callLog;
}

export function mainFrameForAction(pageAliases: Map<Page, string>, actionInContext: actions.ActionInContext): Frame {
  const pageAlias = actionInContext.frame.pageAlias;
  const page = [...pageAliases.entries()].find(([, alias]) => pageAlias === alias)?.[0];
  if (!page)
    throw new Error(`Internal error: page ${pageAlias} not found in [${[...pageAliases.values()]}]`);
  return page.mainFrame();
}

export async function frameForAction(pageAliases: Map<Page, string>, actionInContext: actions.ActionInContext, action: actions.ActionWithSelector): Promise<Frame> {
  const pageAlias = actionInContext.frame.pageAlias;
  const page = [...pageAliases.entries()].find(([, alias]) => pageAlias === alias)?.[0];
  if (!page)
    throw new Error('Internal error: page not found');
  const fullSelector = buildFullSelector(actionInContext.frame.framePath, action.selector);
  const result = await page.mainFrame().selectors.resolveFrameForSelector(fullSelector);
  if (!result)
    throw new Error('Internal error: frame not found');
  return result.frame;
}

function isSameAction(a: actions.ActionInContext, b: actions.ActionInContext): boolean {
  return a.action.name === b.action.name && a.frame.pageAlias === b.frame.pageAlias && a.frame.framePath.join('|') === b.frame.framePath.join('|');
}

function isSameSelector(action: actions.ActionInContext, lastAction: actions.ActionInContext): boolean {
  return 'selector' in action.action && 'selector' in lastAction.action && action.action.selector === lastAction.action.selector;
}

function isShortlyAfter(action: actions.ActionInContext, lastAction: actions.ActionInContext): boolean {
  return action.startTime - lastAction.startTime < 500;
}

export function shouldMergeAction(action: actions.ActionInContext, lastAction: actions.ActionInContext | undefined): boolean {
  if (!lastAction)
    return false;
  switch (action.action.name) {
    case 'fill':
      return isSameAction(action, lastAction) && isSameSelector(action, lastAction);
    case 'navigate':
      return isSameAction(action, lastAction);
    case 'click':
      return isSameAction(action, lastAction) && isSameSelector(action, lastAction) && isShortlyAfter(action, lastAction) && action.action.clickCount > (lastAction.action as actions.ClickAction).clickCount;
  }
  return false;
}

export function collapseActions(actions: actions.ActionInContext[]): actions.ActionInContext[] {
  const result: actions.ActionInContext[] = [];
  for (const action of actions) {
    const lastAction = result[result.length - 1];
    const shouldMerge = shouldMergeAction(action, lastAction);
    if (!shouldMerge) {
      result.push(action);
      continue;
    }
    const startTime = result[result.length - 1].startTime;
    result[result.length - 1] = action;
    result[result.length - 1].startTime = startTime;
  }
  return result;
}

// Qanary fork: a frame hop carries the same scored candidates an element does
// (weighted-locator-generation spec) - one entry per iframe of the chain, outermost
// first, each entry the collected set for that iframe with the same score scale.
export async function generateFrameSelector(progress: Progress, frame: Frame, maxSelectors?: number): Promise<{ framePath: string[], frameSelectors: RankedSelector[][] }> {
  const selectorPromises: Promise<{ selector: string, rankedSelectors: RankedSelector[] }>[] = [];
  progress.setAllowConcurrentOrNestedRaces(true);
  while (frame) {
    const parent = frame.parentFrame();
    if (!parent)
      break;
    selectorPromises.push(generateFrameSelectorInParent(progress, parent, frame, maxSelectors));
    frame = parent;
  }
  const results = await Promise.all(selectorPromises);
  progress.setAllowConcurrentOrNestedRaces(false);
  results.reverse();
  return {
    framePath: results.map(r => r.selector),
    frameSelectors: results.map(r => r.rankedSelectors),
  };
}

async function generateFrameSelectorInParent(prgoress: Progress, parent: Frame, frame: Frame, maxSelectors?: number): Promise<{ selector: string, rankedSelectors: RankedSelector[] }> {
  const result = await raceAgainstDeadline(async () => {
    try {
      const frameElement = await frame.frameElement(prgoress);
      if (!frameElement || !parent)
        return;
      const utility = await parent.utilityContext();
      const injected = await utility.injectedScript();
      const generated = await injected.evaluate((injected, { element, maxSelectors }) => {
        const result = injected.generateSelector(element as Element, { testIdAttributeName: 'data-testid', multiple: true, collectSelectors: true, maxSelectors });
        return { selector: result.selector, rankedSelectors: result.rankedSelectors };
      }, { element: frameElement, maxSelectors });
      return generated;
    } catch (e) {
    }
  }, monotonicTime() + 2000);
  if (!result.timedOut && result.result)
    return result.result;

  // The engine never ran here - the race timed out, or the frame element was already
  // gone - so this string is reconstructed from the frame itself rather than inspected.
  // It is scored last-resort for exactly that reason: an unverified candidate must not
  // outrank evidence the engine actually verified, and a url-derived `src` is as likely
  // to carry a session token as it is to be stable.
  const fallback = frame.name()
    ? `iframe[name=${quoteCSSAttributeValue(frame.name())}]`
    : `iframe[src=${quoteCSSAttributeValue(frame.url())}]`;
  return { selector: fallback, rankedSelectors: [{ selector: fallback, score: kUnverifiedFrameScore }] };
}
