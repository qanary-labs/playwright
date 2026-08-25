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

import { Recorder } from './recorder';
import { resolveAll } from './resolveAll';

import type { InjectedScript } from '../injectedScript';
import type { RecorderDelegate } from './recorder';
import type { ResolvePass } from './resolveAll';
import type * as actions from '@recorder/actions';
import type { ElementInfo, Mode, OverlayState, UIState } from '@recorder/recorderTypes';

interface Embedder {
  __pw_recorderPerformAction(action: actions.PerformOnRecordAction): Promise<void>;
  __pw_recorderRecordAction(action: actions.Action): Promise<void>;
  __pw_recorderState(): Promise<UIState>;
  __pw_recorderElementPicked(element: { selector: string, ariaSnapshot?: string }): Promise<void>;
  __pw_recorderSetMode(mode: Mode): Promise<void>;
  __pw_recorderSetOverlayState(state: OverlayState): Promise<void>;
  __pw_refreshOverlay(): void;
  // Set by PollingRecorder (like __pw_refreshOverlay) for the embedder to call:
  // records any pending inferred hover steps whose revealed content is still
  // showing — used before assertions, which bypass the recorder.
  __pw_recorderFlushInferredHovers(): Promise<void>;
  // Diagnostic: JSON-safe snapshot of the hover inference engine state.
  __pw_recorderHoverDebug(): unknown;
  // Set by PollingRecorder in every frame for the embedder to poll: one atomic
  // resolution pass over a step's selectors (see resolveAll.ts).
  __pw_resolveAll(selectors: string[], stableMs: number, token: string): ResolvePass | null;
}

export class PollingRecorder implements RecorderDelegate {
  private _recorder: Recorder;
  private _embedder: Embedder;
  private _pollRecorderModeTimer: number | undefined;
  private _lastStateJSON: string | undefined;

  constructor(injectedScript: InjectedScript, options?: { recorderMode?: 'default' | 'api', hideToolbar?: boolean, collectSelectors?: boolean, maxSelectors?: number }) {
    this._recorder = new Recorder(injectedScript, options);
    this._embedder = injectedScript.window as any;

    injectedScript.onGlobalListenersRemoved.add(() => this._recorder.installListeners());

    const refreshOverlay = () => {
      this._lastStateJSON = undefined;
      this._pollRecorderMode().catch(e => console.log(e)); // eslint-disable-line no-console
    };
    this._embedder.__pw_refreshOverlay = refreshOverlay;
    this._embedder.__pw_recorderFlushInferredHovers = () => this._recorder.flushInferredHovers();
    this._embedder.__pw_recorderHoverDebug = () => this._recorder.hoverInferenceDebugState();
    this._embedder.__pw_resolveAll = (selectors, stableMs, token) => resolveAll(injectedScript, selectors, stableMs, token);
    refreshOverlay();
  }

  private async _pollRecorderMode() {
    const pollPeriod = 1000;
    if (this._pollRecorderModeTimer)
      this._recorder.injectedScript.utils.builtins.clearTimeout(this._pollRecorderModeTimer);
    const state = await this._embedder.__pw_recorderState().catch(() => null);
    if (!state) {
      this._pollRecorderModeTimer = this._recorder.injectedScript.utils.builtins.setTimeout(() => this._pollRecorderMode(), pollPeriod);
      return;
    }

    const stringifiedState = JSON.stringify(state);
    if (this._lastStateJSON !== stringifiedState) {
      this._lastStateJSON = stringifiedState;
      const win = this._recorder.document.defaultView!;
      if (win.top !== win) {
        // Only show action point in the main frame, since it is relative to the page's viewport.
        // Otherwise we'll see multiple action points at different locations.
        state.actionPoint = undefined;
      }
      this._recorder.setUIState(state, this);
    }

    this._pollRecorderModeTimer = this._recorder.injectedScript.utils.builtins.setTimeout(() => this._pollRecorderMode(), pollPeriod);
  }

  async performAction(action: actions.PerformOnRecordAction) {
    await this._embedder.__pw_recorderPerformAction(action);
  }

  async recordAction(action: actions.Action): Promise<void> {
    await this._embedder.__pw_recorderRecordAction(action);
  }

  async elementPicked(elementInfo: ElementInfo): Promise<void> {
    await this._embedder.__pw_recorderElementPicked(elementInfo);
  }

  async setMode(mode: Mode): Promise<void> {
    await this._embedder.__pw_recorderSetMode(mode);
  }

  async setOverlayState(state: OverlayState): Promise<void> {
    await this._embedder.__pw_recorderSetOverlayState(state);
  }
}

export default PollingRecorder;
