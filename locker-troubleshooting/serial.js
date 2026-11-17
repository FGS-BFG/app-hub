// Read-only locker diagnostics. Only ISB#A–E and RST#C may reach the wire.
// This protocol has no transaction IDs: draining reduces, but cannot eliminate,
// the risk of a very late reply being mistaken for a later same-board request.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const delayOption = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
};

export class SerialError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SerialError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class SerialTransport {
  constructor(port, {onEvent, onState, timeout = 1500, startupDelay = 2000,
    charDelay = 10, quietDelay = 100, resetDelay = 6000} = {}) {
    this.port = port;
    this.connected = false;
    this.busy = false;
    this.timeout = delayOption(timeout, 1500);
    this.startupDelay = delayOption(startupDelay, 2000);
    this.charDelay = delayOption(charDelay, 10);
    this.quietDelay = delayOption(quietDelay, 100);
    this.resetDelay = delayOption(resetDelay, 6000);
    this.onEvent = onEvent;
    this.onState = onState;
    this._reader = null;
    this._writer = null;
    this._opened = false;
    this._opening = false;
    this._closing = false;
    this._shutdownPromise = null;
    this._active = null;
    this._buffer = '';
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
    this._lastDataAt = 0;
    this._notBefore = 0;
    this._lastError = null;
    this._onDisconnect = () => this._fail(new SerialError('DISCONNECTED', 'The USB serial device disconnected.'));
  }

  _event(type, values = {}) {
    try { this.onEvent?.({type, at: now(), ...values}); } catch {}
  }

  _state(error) {
    try {
      this.onState?.({connected: this.connected, busy: this.busy,
        ...(error ? {error: {code: error.code, message: error.message}} : {})});
    } catch {}
  }

  async open() {
    if (this.connected) return;
    if (this._opening || this._closing) throw new SerialError('BUSY', 'The serial connection is changing.');
    if (!this.port?.open) throw new SerialError('PORT', 'A USB serial port has not been selected.');
    this._opening = true;
    this._lastError = null;
    this._life = deferred();
    try {
      await this.port.open({baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'});
      this._opened = true;
      if (!this.port.readable || !this.port.writable) throw new SerialError('PORT', 'The selected port has no readable and writable serial streams.');
      if (typeof this.port.setSignals === 'function') {
        try { await this.port.setSignals({dataTerminalReady: false, requestToSend: false}); }
        catch (error) { this._event('warning', {code: 'PORT', message: 'The port could not set DTR and RTS low.', raw: String(error?.message || error)}); }
      }
      this._reader = this.port.readable.getReader();
      this._writer = this.port.writable.getWriter();
      this._decoder = new TextDecoder();
      this._buffer = '';
      this._lastDataAt = Date.now();
      this.port.addEventListener?.('disconnect', this._onDisconnect);
      this._readTask = this._readLoop();
      await Promise.race([sleep(this.startupDelay), this._life.promise]);
      if (!this._opened || this._lastError) throw this._lastError || new SerialError('DISCONNECTED', 'The serial connection closed during startup.');
      this.connected = true;
      this._state();
    } catch (cause) {
      const error = cause instanceof SerialError ? cause : new SerialError('PORT', 'The USB serial port could not be opened.', cause);
      if (this._lastError !== error) this._event('error', {code: error.code, message: error.message});
      await this._shutdown(error);
      throw error;
    } finally {
      this._opening = false;
    }
  }

  async close() {
    await this._shutdown(new SerialError('DISCONNECTED', 'The serial connection was closed.'));
  }

  async _shutdown(error) {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._closing = true;
    this.connected = false;
    this._opened = false;
    this._life?.reject(error);
    const active = this._active;
    active?.abort.reject(error);
    active?.response.reject(error);
    this._active = null;
    this.busy = false;
    this._state(error);
    const reader = this._reader, writer = this._writer;
    this._reader = null;
    this._writer = null;
    this.port?.removeEventListener?.('disconnect', this._onDisconnect);
    this._shutdownPromise = (async () => {
      try { await reader?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      try { await writer?.abort(error); } catch {}
      try { writer?.releaseLock(); } catch {}
      try { await this.port?.close?.(); } catch (cause) {
        this._event('warning', {code: 'PORT', message: 'The serial port reported an error while closing.', raw: String(cause?.message || cause)});
      }
      this._buffer = '';
      this._closing = false;
    })();
    try { await this._shutdownPromise; }
    finally { this._shutdownPromise = null; }
  }

  _fail(error) {
    if (this._closing || (!this._opened && !this._opening)) return;
    this._lastError = error;
    this._event('error', {code: error.code, message: error.message});
    this._shutdown(error).catch(() => {});
  }

  async _readLoop() {
    const reader = this._reader;
    try {
      while (this._opened && !this._closing) {
        const {value, done} = await reader.read();
        if (done) {
          if (!this._closing) this._fail(new SerialError('DISCONNECTED', 'The USB serial input stream closed.'));
          break;
        }
        if (value?.length) this._ingest(this._decoder.decode(value, {stream: true}));
      }
    } catch (cause) {
      if (!this._closing) this._fail(new SerialError('DISCONNECTED', 'The USB serial input stream failed.', cause));
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  _ingest(text) {
    if (!text) return;
    this._lastDataAt = Date.now();
    this._event('rx', {raw: text});
    const active = this._active;
    if (active?.accepting) {
      active.sawData = true;
      active.raw = (active.raw + text).slice(-65536);
    }
    this._buffer += text;
    if (this._buffer.length > 8192) {
      this._event('warning', {code: 'PROTOCOL', message: 'Discarded an overlong serial frame.', raw: this._buffer.slice(0, 256)});
      this._buffer = this._buffer.slice(-4096);
    }
    let end;
    while ((end = this._buffer.search(/[\r\n~]/)) !== -1) {
      const frame = this._buffer.slice(0, end).trim();
      this._buffer = this._buffer.slice(end + 1);
      if (frame) this._frame(frame);
    }
  }

  _frame(raw) {
    const active = this._active;
    if (!active?.accepting) return;
    let valid = false;
    const replies = raw.matchAll(/<([A-E])>\s*Ex\(BIN\)\s*:\s*([01]{8})\s*:\s*([01]{8})(?=\s*(?:<[A-E]>|$))/gi);
    for (const reply of replies) {
      valid = true;
      const board = reply[1].toUpperCase();
      if (active.kind === 'query' && board === active.board) {
        active.response.resolve({board, bits: reply[2] + reply[3], raw: reply[0], elapsedMs: Date.now() - active.started, at: now()});
      } else if (active.kind === 'query') {
        this._event('warning', {code: 'PROTOCOL', raw, message: `Ignored a reply from board ${board} while waiting for ${active.board}.`});
      }
    }
    for (const addressed of raw.matchAll(/<([A-E])>([^<]*)/gi)) {
      const board = addressed[1].toUpperCase();
      if (board !== active.board) continue;
      if (/\bSYSTEM_Reset\s+in\s+5\s+seconds/i.test(addressed[2])) active.acknowledged = true;
      if (/command\s*error|unknown[^\r\n]*command|\bbusy\b|^\s*error\b/i.test(addressed[2])) {
        const error = new SerialError('CONTROLLER', `Board ${board} returned an error: ${addressed[2].trim()}`);
        error.raw = raw;
        active.response.reject(error);
        active.abort.reject(error);
        return;
      }
    }
    if (!valid && /Ex\(BIN\)/i.test(raw)) this._event('warning', {code: 'PROTOCOL', raw, message: 'Received a malformed input-status frame; still waiting for a valid reply.'});
  }

  _begin(command, kind, board) {
    if (!/^(ISB#[A-E]|RST#C)$/.test(command)) throw new SerialError('INVALID_COMMAND', 'Only ISB#A–E and RST#C are permitted.');
    if (!this.connected || this._closing) throw new SerialError('DISCONNECTED', 'Connect the USB serial port before sending a command.');
    if (this.busy) throw new SerialError('BUSY', 'Wait for the current serial transaction to finish.');
    const active = {command, kind, board, raw: '', sawData: false, accepting: false,
      acknowledged: false, abort: deferred(), response: deferred(), started: 0};
    this._active = active;
    this.busy = true;
    this._state();
    return active;
  }

  async _pause(ms, active) {
    await Promise.race([sleep(ms), active.abort.promise, this._life.promise]);
  }

  async _prepare(active) {
    this._buffer = '';
    const deadline = Date.now() + Math.max(1000, this.timeout * 2, this.quietDelay * 5);
    for (;;) {
      const remaining = Math.max(this._notBefore, this._lastDataAt + this.quietDelay) - Date.now();
      if (remaining <= 0) break;
      if (Date.now() > deadline) throw new SerialError('PROTOCOL', 'Serial input did not become quiet before the command could be sent.');
      await this._pause(Math.min(remaining, 25), active);
    }
    // Discard partial/late frames collected while waiting for the quiet boundary.
    this._buffer = '';
    this._decoder = new TextDecoder();
    active.started = Date.now();
    active.accepting = true;
  }

  async _write(active) {
    const bytes = this._encoder.encode(active.command + '\r');
    this._event('tx', {command: active.command, raw: active.command + '\r'});
    try {
      for (let i = 0; i < bytes.length; i++) {
        if (!this._opened || !this._writer) throw new SerialError('DISCONNECTED', 'The USB serial connection closed while writing.');
        await Promise.race([this._writer.write(bytes.subarray(i, i + 1)), active.abort.promise, this._life.promise]);
        if (this.charDelay && i < bytes.length - 1) await this._pause(this.charDelay, active);
      }
    } catch (cause) {
      if (cause instanceof SerialError) throw cause;
      const error = new SerialError('WRITE', 'The command could not be written to the USB serial port.', cause);
      this._fail(error);
      throw error;
    }
  }

  _finish(active) {
    active.accepting = false;
    if (this._active !== active) return;
    this._active = null;
    this.busy = false;
    this._state();
  }

  async query(board) {
    if (typeof board !== 'string' || !/^[A-E]$/.test(board)) throw new SerialError('INVALID_COMMAND', 'Choose a board letter from A to E.');
    const active = this._begin('ISB#' + board, 'query', board);
    let timer;
    try {
      await this._prepare(active);
      await this._write(active);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const code = active.sawData ? 'PROTOCOL' : 'TIMEOUT';
          const error = new SerialError(code, active.sawData
            ? `Serial data arrived, but no valid input-status reply from board ${board} was received.`
            : `No serial reply was received for board ${board}.`);
          error.raw = active.raw;
          reject(error);
        }, this.timeout);
      });
      return await Promise.race([active.response.promise, timeout, active.abort.promise]);
    } catch (error) {
      if (error.code === 'TIMEOUT' || error.code === 'PROTOCOL') {
        this._notBefore = Date.now() + 150;
        this._event('warning', {code: error.code, raw: active.raw,
          message: 'Draining late input for at least 150 ms. This protocol has no transaction IDs, so a very late same-board reply cannot be matched with certainty.'});
      }
      this._event('error', {code: error.code, command: active.command, raw: error.raw || active.raw, message: error.message});
      throw error;
    } finally {
      clearTimeout(timer);
      this._finish(active);
    }
  }

  async resetMaster() {
    const active = this._begin('RST#C', 'reset', 'C');
    try {
      await this._prepare(active);
      await this._write(active);
      await this._pause(this.resetDelay, active);
      return {raw: active.raw, at: now(), acknowledged: active.acknowledged, confirmed: false};
    } catch (error) {
      this._event('error', {code: error.code, command: active.command, raw: error.raw || active.raw, message: error.message});
      throw error;
    } finally {
      this._finish(active);
    }
  }
}
