/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

let EventEmitter = require('events');
let helper = require('./helper');

class FrameManager extends EventEmitter {
  /**
   * @param {!Connection} client
   * @return {!FrameManager}
   */
  static async create(client) {
    let mainFramePayload = await client.send('Page.getResourceTree');
    return new FrameManager(client, mainFramePayload.frameTree);
  }

  /**
   * @param {!Connection} client
   * @param {!Object} frameTree
   */
  constructor(client, frameTree) {
    super();
    this._client = client;
    /** @type {!Map<string, !Frame>} */
    this._frames = new Map();
    this._mainFrame = this._addFramesRecursively(null, frameTree);

    /** @type {!Map<string, string>} */
    this._frameIdToExecutionContextId = new Map();

    this._client.on('Page.frameAttached', event => this._onFrameAttached(event.frameId, event.parentFrameId));
    this._client.on('Page.frameNavigated', event => this._onFrameNavigated(event.frame));
    this._client.on('Page.frameDetached', event => this._onFrameDetached(event.frameId));
    this._client.on('Runtime.executionContextCreated', event => this._onExecutionContextCreated(event.context));
    this._client.on('Runtime.executionContextDestroyed', event => this._onExecutionContextDestroyed(event.executionContextId));
  }

  /**
   * @return {!Frame}
   */
  mainFrame() {
    return this._mainFrame;
  }

  /**
   * @return {!Array<!Frame>}
   */
  frames() {
    return Array.from(this._frames.values());
  }

  /**
   * @param {string} frameId
   * @param {?string} parentFrameId
   * @return {?Frame}
   */
  _onFrameAttached(frameId, parentFrameId) {
    if (this._frames.has(frameId))
      return;

    if (!parentFrameId) {
      // Navigation to the new backend process.
      this._navigateFrame(this._mainFrame, frameId, null);
      return;
    }
    let parentFrame = this._frames.get(parentFrameId);
    let frame = new Frame(this, parentFrame, frameId, null);
    this._frames.set(frame._id, frame);
    this.emit(FrameManager.Events.FrameAttached, frame);
  }

  /**
   * @param {!Object} framePayload
   */
  _onFrameNavigated(framePayload) {
    let frame = this._frames.get(framePayload.id);
    if (!frame) {
      // Simulate missed "frameAttached" for a main frame navigation to the new backend process.
      console.assert(!framePayload.parentId, 'Main frame shouldn\'t have parent frame id.');
      frame = this._mainFrame;
    }
    this._navigateFrame(frame, framePayload.id, framePayload);
  }

  /**
   * @param {string} frameId
   */
  _onFrameDetached(frameId) {
    let frame = this._frames.get(frameId);
    if (frame)
      this._removeFramesRecursively(frame);
  }

  _onExecutionContextCreated(context) {
    if (context.auxData && context.auxData.isDefault && context.auxData.frameId)
      this._frameIdToExecutionContextId.set(context.auxData.frameId, context.id);
  }

  _onExecutionContextDestroyed(executionContextId) {
    this._frameIdToExecutionContextId.delete(executionContextId);
  }

  /**
   * @param {!Frame} frame
   * @param {string} newFrameId
   * @param {?Object} newFramePayload
   */
  _navigateFrame(frame, newFrameId, newFramePayload) {
    // Detach all child frames first.
    for (let child of frame.childFrames())
      this._removeFramesRecursively(child);
    this._frames.delete(frame._id, frame);
    frame._id = newFrameId;
    frame._adoptPayload(newFramePayload);
    this._frames.set(newFrameId, frame);
    this.emit(FrameManager.Events.FrameNavigated, frame);
  }

  /**
   * @param {?Frame} parentFrame
   * @param {!Object} frameTreePayload
   * @return {!Frame}
   */
  _addFramesRecursively(parentFrame, frameTreePayload) {
    let framePayload = frameTreePayload.frame;
    let frame = new Frame(this, parentFrame, framePayload.id, framePayload);
    this._frames.set(frame._id, frame);

    for (let i = 0; frameTreePayload.childFrames && i < frameTreePayload.childFrames.length; ++i)
      this._addFramesRecursively(frame, frameTreePayload.childFrames[i]);
    return frame;
  }

  /**
   * @param {!Frame} frame
   */
  _removeFramesRecursively(frame) {
    for (let child of frame.childFrames())
      this._removeFramesRecursively(child);
    frame._detach();
    this._frames.delete(frame._id);
    this.emit(FrameManager.Events.FrameDetached, frame);
  }

  /**
   * @param {!Frame} frame
   * @param {function()} fun
   * @param {!Array<*>} args
   * @return {!Promise<(!Object|undefined)>}
   */
  async _evaluateOnFrame(frame, fun, ...args) {
    let contextId = undefined;
    if (!frame.isMainFrame()) {
      contextId = this._frameIdToExecutionContextId.get(frame._id);
      console.assert(contextId, 'Frame does not have default context to evaluate in!');
    }
    let syncExpression = helper.evaluationString(fun, ...args);
    let expression = `Promise.resolve(${syncExpression})`;
    let { exceptionDetails, result: remoteObject }  = await this._client.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) {
      let message = await helper.getExceptionMessage(this._client, exceptionDetails);
      throw new Error('Evaluation failed: ' + message);
    }
    return remoteObject.value;
  }
}

/** @enum {string} */
FrameManager.Events = {
  FrameAttached: 'frameattached',
  FrameNavigated: 'framenavigated',
  FrameDetached: 'framedetached'
};

/**
 * @unrestricted
 */
class Frame {
  /**
   * @param {!FrameManager} frameManager
   * @param {?Frame} parentFrame
   * @param {string} frameId
   * @param {?Object} payload
   */
  constructor(frameManager, parentFrame, frameId, payload) {
    this._frameManager = frameManager;
    this._parentFrame = parentFrame;
    this._url = '';
    this._id = frameId;
    this._adoptPayload(payload);

    /** @type {!Set<!Frame>} */
    this._childFrames = new Set();
    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
  }

  /**
   * @param {function()} fun
   * @param {!Array<*>} args
   * @return {!Promise<(!Object|undefined)>}
   */
  async evaluate(fun, ...args) {
    return this._frameManager._evaluateOnFrame(this, fun, ...args);
  }

  /**
   * @return {string}
   */
  name() {
    return this._name || '';
  }

  /**
   * @return {string}
   */
  url() {
    return this._url;
  }

  /**
   * @return {string}
   */
  securityOrigin() {
    return this._securityOrigin;
  }

  /**
   * @return {?Frame}
   */
  parentFrame() {
    return this._parentFrame;
  }

  /**
   * @return {!Array.<!Frame>}
   */
  childFrames() {
    return Array.from(this._childFrames);
  }

  /**
   * @return {boolean}
   */
  isMainFrame() {
    return !this._detached && !this._parentFrame;
  }

  /**
   * @return {boolean}
   */
  isDetached() {
    return this._detached;
  }

  /**
   * @param {?Object} framePayload
   */
  _adoptPayload(framePayload) {
    framePayload = framePayload || {
      name: '',
      url: '',
      securityOrigin: '',
      mimeType: ''
    };
    this._name = framePayload.name;
    this._url = framePayload.url;
    this._securityOrigin = framePayload.securityOrigin;
    this._mimeType = framePayload.mimeType;
  }

  _detach() {
    this._detached = true;
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }
}

module.exports = FrameManager;