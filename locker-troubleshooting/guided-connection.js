// Connection proof belongs to this live session only. A port opening is not
// proof of a board reply, and a completed countdown is not proof of stability.
const activePhases = new Set(['waiting', 'watching', 'ready']);
const duration = (value, fallback, minimum = 0) =>
  Number.isFinite(value) && value >= minimum ? value : fallback;
const validMaster = value => typeof value === 'string' && /^[A-E]$/.test(value);
const boardLetters = ['A', 'B', 'C', 'D', 'E'];
const validInputReply = value => value?.status === 'responded' && validMaster(value.board)
  && typeof value.bits === 'string' && /^[01]{16}$/.test(value.bits);
const cloneResults = value => {
  try { return structuredClone(value); }
  catch { return []; }
};

export function shouldProceed(snapshot, expectedMaster) {
  const matchesExpected = arguments.length < 2 || validMaster(expectedMaster) && snapshot?.masterBoard === expectedMaster;
  return snapshot?.phase === 'ready' && snapshot.connected === true
    && Number.isFinite(snapshot.verifiedAt)
    && (snapshot.masterBoard === undefined || validMaster(snapshot.masterBoard))
    && matchesExpected;
}

export class GuidedConnection {
  constructor({isConnected = () => false, getMaster = () => 'C', probe, discover, onStopDiscovery = () => {}, onChange = () => {}, onEvent = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    connectionWaitMs = 60000, stabilityMs = 60000, pollMs = 3000} = {}) {
    if (typeof probe !== 'function') throw new TypeError('A master probe function is required.');
    if (typeof getMaster !== 'function') throw new TypeError('A master selection function is required.');
    if (discover !== undefined && typeof discover !== 'function') throw new TypeError('Board discovery must be a function.');
    if (typeof onStopDiscovery !== 'function') throw new TypeError('Stopping board discovery must be a function.');
    this._isConnected = isConnected;
    this._getMaster = getMaster;
    this._masterBoard = this._readMaster();
    this._probe = probe;
    this._discover = discover;
    this._onStopDiscovery = onStopDiscovery;
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
    this._discoveryAttempted = false;
    this._discoveryPending = false;
    this._discoveryRunning = false;
    this._discoveredBoards = [];
    this._discoveryResults = [];
    this._discoveryAt = '';
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
      discoveredBoards: [...this._discoveredBoards],
      discoveryResults: cloneResults(this._discoveryResults),
      discoveryAt: this._discoveryAt,
      discoveryRunning: this._discoveryRunning,
    };
  }

  getSnapshot() { return this.snapshot(); }

  start() {
    this._generation++;
    this._cancelTimer();
    this._stopDiscovery();
    this._clearProof();
    this._discoveryAttempted = false;
    this._discoveredBoards = [];
    this._discoveryResults = [];
    this._discoveryAt = '';
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
    this._stopDiscovery();
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
    if (this._phase === 'attention' && this._reason === 'different-board' && !this._connected) {
      // An address observed on the old port is historical evidence, not a
      // decision that a newly opened port can inherit without another check.
      this._attention('disconnected', 'The USB connection was lost after the board address check. Reconnect and check the addresses again before choosing a board.', 'DISCONNECTED');
      return;
    }
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

  _stopDiscovery() {
    this._discoveryPending = false;
    if (!this._discoveryRunning) return;
    this._discoveryRunning = false;
    // Cancellation asks the adapter to stop after its current physical read.
    // The shared in-flight lock stays held until that promise actually settles.
    try { Promise.resolve(this._onStopDiscovery()).catch(() => {}); } catch {}
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
    this._stopDiscovery();
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
    if (this._connected && !this._inFlight) {
      if (this._discoveryPending) this._launchDiscovery();
      else if (finalProbeDue || current >= this._nextProbeAt) this._launchProbe();
    }
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

  _launchDiscovery() {
    if (this._inFlight || this._phase !== 'waiting' || !this._discoveryPending || !this._discover) return;
    if (!this._checkMaster()) return;
    const request = {kind: 'discovery', generation: this._generation, masterBoard: this._masterBoard};
    this._inFlight = request;
    this._discoveryPending = false;
    this._discoveryRunning = true;
    this._event('info', 'No valid reply was received from the expected master. Checking board addresses without changing any outputs.');
    this._publish();
    Promise.resolve().then(() => {
      if (request.generation !== this._generation || this._phase !== 'waiting') return null;
      if (!this._checkMaster()) return null;
      return this._discover();
    }).then(
      results => this._handleDiscovery(request, results),
      error => this._handleDiscovery(request, [{status: 'error', code: error?.code || 'DISCOVERY', error: error?.message || String(error)}]),
    ).catch(error => {
      if (request.generation === this._generation && activePhases.has(this._phase)) {
        this._attention('discovery-error', 'The board address check could not be completed. Repeat the connection check.', error?.code || 'DISCOVERY');
      }
    }).finally(() => {
      if (this._inFlight === request) this._inFlight = null;
      if (activePhases.has(this._phase)) this._tick();
    });
  }

  _handleDiscovery(request, results) {
    if (request.generation !== this._generation || this._phase !== 'waiting') return;
    if (!this._checkMaster()) return;
    this._connected = this._readConnection();
    if (!this._connected) {
      this._attention('disconnected', 'The USB connection was lost during the board address check. Repeat the connection check.', 'DISCONNECTED');
      return;
    }
    const current = this._now();
    if (current >= this._waitDeadline) {
      this._attention('connection-timeout', `No valid master ${this._masterBoard} reply was confirmed before the connection deadline. Check the connection and try again.`, 'CONNECTION_TIMEOUT');
      return;
    }
    this._discoveryRunning = false;
    this._discoveryResults = cloneResults(Array.isArray(results) ? results : []);
    this._discoveryAt = new Date(current).toISOString();
    const validBoards = new Set(this._discoveryResults.filter(validInputReply).map(reply => reply.board));
    this._discoveredBoards = boardLetters.filter(board => validBoards.has(board));
    if (validBoards.has(request.masterBoard)) {
      // Discovery identifies an address; it never contributes stability proof.
      // A new expected-master request must start the normal observation period.
      this._nextProbeAt = current;
      this._event('info', `Master ${request.masterBoard} replied during the address check. Requesting a fresh reply before checking connection stability.`);
    } else if (this._discoveredBoards.length) {
      this._attention('different-board', `Board${this._discoveredBoards.length === 1 ? '' : 's'} ${this._discoveredBoards.join(', ')} replied, but expected master ${request.masterBoard} did not. Review the installed board labels before continuing.`, 'DIFFERENT_BOARD');
      return;
    } else {
      this._nextProbeAt = current + this._pollMs;
      this._event('warning', 'The address check did not receive a valid board reply. Still waiting for the expected master within the connection deadline.', 'NO_BOARD_REPLY');
    }
    this._publish();
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

    const valid = request.masterBoard === this._masterBoard && validInputReply(reply) && reply.board === request.masterBoard;
    this._nextProbeAt = current + this._pollMs;
    if (!valid) {
      const code = reply?.status === 'responded' ? 'PROTOCOL'
        : reply?.code || (reply?.status === 'no-response' ? 'TIMEOUT' : 'PROBE');
      const reason = code === 'TIMEOUT' ? 'no-response' : String(code).toLowerCase();
      if (this._phase === 'waiting') {
        this._reason = reason;
        if (this._discover && !this._discoveryAttempted && ['TIMEOUT', 'PROTOCOL'].includes(code)) {
          this._discoveryAttempted = true;
          this._discoveryPending = true;
        }
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
