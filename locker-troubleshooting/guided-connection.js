// Connection proof belongs to this live session only. A port opening is not
// proof of a board reply, and a completed countdown is not proof of stability.
const activePhases = new Set(['waiting', 'watching', 'ready']);
const duration = (value, fallback, minimum = 0) =>
  Number.isFinite(value) && value >= minimum ? value : fallback;
const validMaster = value => typeof value === 'string' && /^[A-E]$/.test(value);

export function shouldProceed(snapshot, expectedMaster) {
  const matchesExpected = arguments.length < 2 || validMaster(expectedMaster) && snapshot?.masterBoard === expectedMaster;
  return snapshot?.phase === 'ready' && snapshot.connected === true
    && Number.isFinite(snapshot.verifiedAt)
    && (snapshot.masterBoard === undefined || validMaster(snapshot.masterBoard))
    && matchesExpected;
}

export class GuidedConnection {
  constructor({isConnected = () => false, getMaster = () => 'C', probe, onChange = () => {}, onEvent = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    connectionWaitMs = 60000, stabilityMs = 60000, pollMs = 3000} = {}) {
    if (typeof probe !== 'function') throw new TypeError('A master probe function is required.');
    if (typeof getMaster !== 'function') throw new TypeError('A master selection function is required.');
    this._isConnected = isConnected;
    this._getMaster = getMaster;
    this._masterBoard = this._readMaster();
    this._probe = probe;
    this._onChange = onChange;
    this._onEvent = onEvent;
    this._now = now;
    // Browser Window timer methods reject an unrelated class-instance receiver.
    // Invoke injected timer functions as plain functions instead of methods.
    this._setTimer = (callback, milliseconds) => setTimer(callback, milliseconds);
    this._clearTimer = timer => clearTimer(timer);
    this._connectionWaitMs = duration(connectionWaitMs, 60000);
    this._stabilityMs = duration(stabilityMs, 60000);
    this._pollMs = duration(pollMs, 3000, 1);
    this._phase = 'stopped';
    this._reason = '';
    this._connected = this._readConnection();
    this._verifiedAt = null;
    this._lastReplyAt = null;
    this._goodReplyCount = 0;
    this._generation = 0;
    this._timer = null;
    this._inFlight = null;
    this._waitDeadline = 0;
    this._stabilityDeadline = 0;
    this._nextProbeAt = Infinity;
    this._hasConnected = false;
  }

  snapshot() {
    const deadline = this._phase === 'waiting' ? this._waitDeadline
      : this._phase === 'watching' ? this._stabilityDeadline : 0;
    return {
      phase: this._phase,
      masterBoard: this._masterBoard,
      reason: this._reason,
      remainingSeconds: deadline ? Math.max(0, Math.ceil((deadline - this._now()) / 1000)) : 0,
      connected: this._connected,
      verifiedAt: this._verifiedAt,
      lastReplyAt: this._lastReplyAt,
      goodReplyCount: this._goodReplyCount,
    };
  }

  getSnapshot() { return this.snapshot(); }

  start() {
    this._generation++;
    this._cancelTimer();
    this._clearProof();
    this._phase = 'waiting';
    this._reason = '';
    this._masterBoard = this._readMaster();
    this._connected = this._readConnection();
    this._hasConnected = this._connected;
    this._waitDeadline = this._now() + this._connectionWaitMs;
    this._nextProbeAt = this._now();
    if (!this._masterBoard) {
      this._attention('layout', 'The locker layout and master have not been confirmed. Select the layout before checking the connection.', 'LAYOUT');
      return this.snapshot();
    }
    this._event('info', `Waiting for the USB connection and a valid reply from master ${this._masterBoard}.`);
    this._publish();
    this._tick();
    return this.snapshot();
  }

  retry() { return this.start(); }

  stop() {
    this._generation++;
    this._cancelTimer();
    this._phase = 'stopped';
    this._reason = '';
    this._clearProof();
    this._connected = this._readConnection();
    this._nextProbeAt = Infinity;
    // Keep the in-flight lock: restarting must wait for the previous physical
    // request to settle rather than stacking another request on the transport.
    this._publish();
    return this.snapshot();
  }

  notifyConnection(connected) {
    const wasConnected = this._connected;
    this._connected = connected === true;
    if (this._connected) this._hasConnected = true;
    if (activePhases.has(this._phase) && !this._checkMaster()) return;
    if (activePhases.has(this._phase) && !this._connected && (wasConnected || this._hasConnected)) {
      this._attention('disconnected', 'The USB connection was lost. Repeat the connection check.', 'DISCONNECTED');
      return;
    }
    this._publish();
    if (activePhases.has(this._phase)) this._tick(true);
  }

  _readConnection() {
    try { return this._isConnected() === true; }
    catch { return false; }
  }

  _readMaster() {
    try { const master = this._getMaster(); return validMaster(master) ? master : null; }
    catch { return null; }
  }

  _checkMaster() {
    const master = this._readMaster();
    if (!master) {
      this._attention('layout', 'The locker layout and master are no longer confirmed. Select the layout and repeat the connection check.', 'LAYOUT');
      return false;
    }
    if (master !== this._masterBoard) {
      this._attention('master-changed', `The selected master changed from ${this._masterBoard} to ${master}. Repeat the connection check for master ${master}.`, 'MASTER_CHANGED');
      return false;
    }
    return true;
  }

  _clearProof() {
    this._verifiedAt = null;
    this._lastReplyAt = null;
    this._goodReplyCount = 0;
    this._stabilityDeadline = 0;
  }

  _cancelTimer() {
    if (this._timer !== null) this._clearTimer(this._timer);
    this._timer = null;
  }

  _publish() {
    try { this._onChange(this.snapshot()); } catch {}
  }

  _event(type, message, code) {
    try {
      this._onEvent({type, at: new Date(this._now()).toISOString(), message,
        ...(code ? {code} : {})});
    } catch {}
  }

  _attention(reason, message, code) {
    this._generation++;
    this._cancelTimer();
    this._phase = 'attention';
    this._reason = reason;
    this._clearProof();
    this._nextProbeAt = Infinity;
    this._event('warning', message, code);
    this._publish();
  }

  _tick(connectionAlreadyRead = false) {
    this._cancelTimer();
    if (!activePhases.has(this._phase)) return;
    if (!this._checkMaster()) return;
    if (!connectionAlreadyRead) {
      const connected = this._readConnection();
      if (!connected && this._hasConnected) {
        this._connected = false;
        this._attention('disconnected', 'The USB connection was lost. Repeat the connection check.', 'DISCONNECTED');
        return;
      }
      this._connected = connected;
      if (connected) this._hasConnected = true;
    }

    const current = this._now();
    if (this._phase === 'waiting' && current >= this._waitDeadline) {
      this._attention('connection-timeout', `No valid master ${this._masterBoard} reply was confirmed before the connection deadline. Check the connection and try again.`, 'CONNECTION_TIMEOUT');
      return;
    }

    const finalProbeDue = this._phase === 'watching' && current >= this._stabilityDeadline;
    if (this._connected && !this._inFlight && (finalProbeDue || current >= this._nextProbeAt)) this._launchProbe();
    this._publish();
    this._schedule();
  }

  _schedule() {
    if (!activePhases.has(this._phase)) return;
    const current = this._now();
    let next = current + 1000;
    if (this._phase === 'waiting') next = Math.min(next, this._waitDeadline);
    if (this._phase === 'watching' && current < this._stabilityDeadline) next = Math.min(next, this._stabilityDeadline);
    if (this._connected && !this._inFlight) next = Math.min(next, this._nextProbeAt);
    this._timer = this._setTimer(() => {
      this._timer = null;
      this._tick();
    }, Math.max(0, next - current));
  }

  _launchProbe() {
    if (this._inFlight || !activePhases.has(this._phase)) return;
    if (!this._checkMaster()) return;
    const request = {generation: this._generation, masterBoard: this._masterBoard, startedAt: this._now()};
    this._inFlight = request;
    // Capture synchronous exceptions as well as rejected probe promises. Every
    // asynchronous outcome is handled, including replies after stop or retry.
    Promise.resolve().then(() => {
      if (request.generation !== this._generation || !activePhases.has(this._phase)) return null;
      if (!this._checkMaster()) return null;
      return this._probe(request.masterBoard);
    }).then(
      reply => this._handleReply(request, reply),
      error => this._handleReply(request, {status: 'error', code: error?.code || 'PROBE', error: error?.message || String(error)}),
    ).catch(error => {
      if (request.generation === this._generation && activePhases.has(this._phase)) {
        this._attention('probe-error', `The master ${this._masterBoard} check could not be completed. Repeat the connection check.`, error?.code || 'PROBE');
      }
    }).finally(() => {
      if (this._inFlight === request) this._inFlight = null;
      if (activePhases.has(this._phase)) this._tick();
    });
  }

  _handleReply(request, reply) {
    if (request.generation !== this._generation || !activePhases.has(this._phase)) return;
    if (!this._checkMaster()) return;
    this._connected = this._readConnection();
    if (!this._connected) {
      this._attention('disconnected', `The USB connection was lost before the master ${this._masterBoard} check completed.`, 'DISCONNECTED');
      return;
    }
    const current = this._now();
    if (this._phase === 'waiting' && current >= this._waitDeadline) {
      this._attention('connection-timeout', `No valid master ${this._masterBoard} reply was confirmed before the connection deadline. Check the connection and try again.`, 'CONNECTION_TIMEOUT');
      return;
    }

    const valid = request.masterBoard === this._masterBoard && reply?.status === 'responded' && reply.board === request.masterBoard
      && typeof reply.bits === 'string' && /^[01]{16}$/.test(reply.bits);
    this._nextProbeAt = current + this._pollMs;
    if (!valid) {
      const code = reply?.status === 'responded' ? 'PROTOCOL'
        : reply?.code || (reply?.status === 'no-response' ? 'TIMEOUT' : 'PROBE');
      const reason = code === 'TIMEOUT' ? 'no-response' : String(code).toLowerCase();
      if (this._phase === 'waiting') {
        this._reason = reason;
        this._event('warning', `The master ${this._masterBoard} probe did not produce a valid addressed reply. Still waiting within the connection deadline.`, code);
        this._publish();
      } else {
        this._attention(reason, `The master ${this._masterBoard} check did not remain stable. Review the connection and repeat the check; no component fault has been identified.`, code);
      }
      return;
    }

    this._lastReplyAt = current;
    this._goodReplyCount++;
    this._reason = '';
    if (this._phase === 'waiting') {
      this._phase = 'watching';
      this._stabilityDeadline = current + this._stabilityMs;
      this._event('info', `Master ${this._masterBoard} replied correctly. Watching the connection before continuing.`);
    } else if (this._phase === 'watching' && request.startedAt >= this._stabilityDeadline) {
      this._phase = 'ready';
      this._verifiedAt = current;
      this._event('info', `Master ${this._masterBoard} replied throughout the observation period and passed a fresh final check. Ready to continue.`);
    }
    this._publish();
  }
}
