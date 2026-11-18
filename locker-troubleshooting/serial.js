// Locker diagnostics plus one explicitly requested, bounded door pulse.
// Door activation is constructed separately; diagnostic commands stay restricted.
// This protocol has no transaction IDs: draining reduces, but cannot eliminate,
// the risk of a very late reply being mistaken for a later same-board request.
export const DEFAULT_DOOR_PULSE_MS = 500;
export const MIN_DOOR_PULSE_MS = 100;
export const MAX_DOOR_PULSE_MS = 2000;
// Quiet-mode commands need no ACK. Briefly collect a controller rejection instead
// of treating the absence of an optional response as failure or physical proof.
const DOOR_COMMAND_SETTLE_MS = 60;
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
    charDelay = 10, quietDelay = 100, resetDelay = 6000, masterBoard = 'C'} = {}) {
    if (typeof masterBoard !== 'string' || !/^[A-E]$/.test(masterBoard)) {
      throw new SerialError('INVALID_COMMAND', 'Choose one master board letter from A to E.');
    }
    Object.defineProperty(this, 'masterBoard', {value: masterBoard, enumerable: true});
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
    this.activationBlocked = false;
    this.activationBlockReason = '';
    this._onDisconnect = () => this._fail(new SerialError('DISCONNECTED', 'The USB serial device disconnected.'));
  }

  _event(type, values = {}) {
    try { this.onEvent?.({type, at: now(), ...values}); } catch {}
  }

  _state(error) {
    try {
      this.onState?.({connected: this.connected, busy: this.busy,
        activationBlocked: this.activationBlocked, activationBlockReason: this.activationBlockReason,
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
    // Keep the writer available until an active pulse has attempted its scoped OFF.
    await this.cancelDoorPulse();
    const error = new SerialError('DISCONNECTED', 'The serial connection was closed.');
    if (this.activationBlocked) await this._settlePulseShutdown(error);
    else await this._shutdown(error);
  }

  cancelDoorPulse() {
    const active = this._active;
    if (active?.kind !== 'pulse') return Promise.resolve(null);
    active.cancelled = true;
    active.stop.resolve();
    return active.finished.promise;
  }

  async _settlePulseShutdown(error) {
    // An underlying USB write can remain pending even after its deadline. In that
    // case WritableStream.abort() can also wait forever. Leave _closing latched,
    // retain the activation block, and report failure without hanging the guide.
    let timer;
    try {
      const released = await Promise.race([
        this._shutdown(error).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 250); }),
      ]);
      if (!released) this._event('warning', {code: 'PORT', message: 'The USB stream has not released. Output state is unknown; reconnect the device before using a fresh connection.'});
    } finally { clearTimeout(timer); }
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
    // A failed read/disconnect must not release the writer ahead of pulse cleanup.
    // A disconnected device may reject OFF; the attempt and uncertainty are recorded.
    if (this._active?.kind === 'pulse') {
      this.connected = false;
      this._active.failure = error;
      this._active.abort.reject(error);
      this._state(error);
      return;
    }
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
      if (active.kind === 'pulse' && active.sample?.accepting) {
        active.sample.sawData = true;
        active.sample.raw = (active.sample.raw + text).slice(-1024);
      }
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
      } else if (active.kind === 'pulse' && active.sample?.accepting && board === active.board) {
        active.sample.response.resolve({board, status: 'responded', bits: reply[2] + reply[3], raw: reply[0], elapsedMs: Date.now() - active.sample.started, at: now()});
      } else if (active.kind === 'query') {
        this._event('warning', {code: 'PROTOCOL', raw, message: `Ignored a reply from board ${board} while waiting for ${active.board}.`});
      }
    }
    for (const addressed of raw.matchAll(/<([A-E])>([^<]*)/gi)) {
      const board = addressed[1].toUpperCase();
      if (board !== active.board) continue;
      if (/\bSYSTEM_Reset\s+in\s+5\s+seconds/i.test(addressed[2])) active.acknowledged = true;
      if (/command\s*error|unknown[^\r\n]*command|\bbusy\b|^\s*error\b/i.test(addressed[2]) ||
          (active.kind === 'pulse' && /parameter\s*error|lock events deactivated/i.test(addressed[2]))) {
        const error = new SerialError('CONTROLLER', `Board ${board} returned an error: ${addressed[2].trim()}`);
        error.raw = raw;
        if (active.kind === 'pulse') {
          if (active.phase === 'off') active.offError = error;
          else active.failure = error;
        }
        active.response.reject(error);
        active.abort.reject(error);
        return;
      }
    }
    if (!valid && /Ex\(BIN\)/i.test(raw)) this._event('warning', {code: 'PROTOCOL', raw, message: 'Received a malformed input-status frame; still waiting for a valid reply.'});
  }

  _begin(command, kind, board) {
    if (typeof command !== 'string' || (!/^ISB#[A-E]$/.test(command) && command !== 'RST#' + this.masterBoard)) {
      throw new SerialError('INVALID_COMMAND', `Only ISB#A–E and RST#${this.masterBoard} are permitted.`);
    }
    return this._reserve(command, kind, board);
  }

  _reserve(command, kind, board, extra = {}) {
    if (!this.connected || this._closing) throw new SerialError('DISCONNECTED', 'Connect the USB serial port before sending a command.');
    if (this.busy) throw new SerialError('BUSY', 'Wait for the current serial transaction to finish.');
    const active = {command, kind, board, raw: '', sawData: false, accepting: false,
      acknowledged: false, abort: deferred(), response: deferred(), started: 0, ...extra};
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

  _pulseCheck(active) {
    if (active.failure) throw active.failure;
    if (active.cancelled) throw new SerialError('CANCELLED', 'The door test was stopped; scoped lock-off was attempted.');
  }

  async _writePulseCommand(active, command, cleanup = false, notAfter = Infinity) {
    // 304 firmware: LA0–LAF set one output and arm the configured firmware timer.
    // LMX clears both output latches on ONLY the addressed board (no mandatory ACK).
    // Source: mci_304_app_device.c OPXba_Command and USB/SERIAL Lxx dispatch.
    if (command !== active.openCommand && command !== active.offCommand &&
        !(active.phase === 'sample' && command === 'ISB#' + active.board)) {
      throw new SerialError('INVALID_COMMAND', 'Only this door test and its scoped lock-off are permitted.');
    }
    const bytes = this._encoder.encode(command + '\r');
    const deadline = Math.min(Date.now() + Math.max(250, this.timeout), notAfter);
    this._event('tx', {command, raw: command + '\r'});
    try {
      for (let i = 0; i < bytes.length; i++) {
        if (!cleanup && active.failure) throw active.failure;
        if (Date.now() >= deadline) throw new SerialError('WRITE', 'The USB command write did not finish before its deadline.');
        if (!this._opened || !this._writer) throw new SerialError('DISCONNECTED', 'The USB serial connection closed while writing.');
        let timer;
        try {
          await Promise.race([
            this._writer.write(bytes.subarray(i, i + 1)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new SerialError('WRITE', 'The USB command write did not finish before its deadline.')), Math.max(0, deadline - Date.now())); }),
          ]);
        } finally { clearTimeout(timer); }
        // Do not truncate a frame merely because the operator cancelled midway.
        // Complete it when possible, then send OFF without the remaining dwell.
        if (this.charDelay && i < bytes.length - 1) await sleep(Math.min(this.charDelay, Math.max(0, deadline - Date.now())));
      }
    } catch (cause) {
      if (cause instanceof SerialError) throw cause;
      throw new SerialError('WRITE', 'The door command could not be written to the USB serial port.', cause);
    }
  }

  async _sampleDuringPulse(active, evidence) {
    const sample = {response: deferred(), raw: '', sawData: false, accepting: true, started: Date.now()};
    active.sample = sample;
    active.phase = 'sample';
    this._buffer = '';
    const sampleDeadline = Math.min(active.pulseDeadline, sample.started + this.timeout);
    let timer;
    try {
      this._pulseCheck(active);
      await this._writePulseCommand(active, 'ISB#' + active.board, false, active.pulseDeadline);
      this._pulseCheck(active);
      const response = await Promise.race([
        sample.response.promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, sampleDeadline - Date.now())); }),
        active.stop.promise.then(() => { this._pulseCheck(active); }),
        active.abort.promise,
        this._life.promise,
      ]);
      this._pulseCheck(active);
      if (response) evidence.samples.push(response);
      else evidence.samples.push({board: active.board, status: sample.sawData ? 'error' : 'no-response',
        code: sample.sawData ? 'PROTOCOL' : 'TIMEOUT',
        error: sample.sawData ? 'No valid addressed input-status reply arrived during the pulse.' : 'No input-status reply arrived before the pulse deadline.',
        raw: sample.raw, at: now(), elapsedMs: Date.now() - sample.started});
      return response;
    } catch (error) {
      evidence.samples.push({board: active.board, status: 'error', code: error.code || 'WRITE',
        error: error.message, raw: sample.raw, at: now(), elapsedMs: Date.now() - sample.started});
      throw error;
    } finally {
      clearTimeout(timer);
      sample.accepting = false;
      active.phase = 'open';
    }
  }

  async pulseDoor(board, door, options = {}) {
    if (typeof board !== 'string' || !/^[A-E]$/.test(board) || !Number.isInteger(door) || door < 1 || door > 16) {
      throw new SerialError('INVALID_COMMAND', 'Choose board A–E and a door number from 1 to 16.');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['durationMs','untilOpen','onProgress'].includes(key))) {
      throw new SerialError('INVALID_COMMAND', 'The door test accepts its duration and selected-sensor release mode only.');
    }
    if(options.untilOpen!==undefined&&typeof options.untilOpen!=='boolean')throw new SerialError('INVALID_COMMAND','Selected-sensor release mode must be true or false.');
    if(options.onProgress!==undefined&&typeof options.onProgress!=='function')throw new SerialError('INVALID_COMMAND','Release progress must be a callback.');
    const untilOpen=options.untilOpen===true;
    const progress=(phase,sample)=>{try{options.onProgress?.({phase,...(sample?{sample}:{}),at:now()});}catch{}};
    const maximum=untilOpen?15000:MAX_DOOR_PULSE_MS;
    const durationMs = options.durationMs === undefined ? DEFAULT_DOOR_PULSE_MS : options.durationMs;
    if (!Number.isInteger(durationMs) || durationMs < MIN_DOOR_PULSE_MS || durationMs > maximum) {
      throw new SerialError('INVALID_COMMAND', `The pulse duration must be ${MIN_DOOR_PULSE_MS}–${maximum} milliseconds.`);
    }
    if (this.activationBlocked) throw new SerialError('ACTIVATION_BLOCKED', this.activationBlockReason);
    const openCommand = (untilOpen?'LM':'LA') + (door - 1).toString(16).toUpperCase() + '#' + board;
    const offCommand = 'LMX#' + board;
    const active = this._reserve(openCommand, 'pulse', board, {
      openCommand, offCommand, stop: deferred(), finished: deferred(), cancelled: false,
      phase: 'preclear', failure: null, offError: null,
    });
    const evidence = {board, door, openCommand, offCommand, durationMs, preclearAttempted: false, preclearSent: false,
      openAttempted: false, openSent: false, offAttempted: false, offSent: false,
      offConfirmed: false, cancelled: false, ...(untilOpen?{releaseMode:'selected-input',sensorInput:door,openValue:'1',relockReason:''}:{}), at: now(), raw: '', samples: []};
    const snapshot = () => ({...evidence, samples: evidence.samples.map(sample => ({...sample}))});
    let error;
    try {
      await this._prepare(active);
      this._pulseCheck(active);
      // Legacy LA adds to existing latch bits. Clear this board before opening.
      evidence.preclearAttempted = true;
      await this._writePulseCommand(active, offCommand);
      evidence.preclearSent = true;
      evidence.preclearAt = now();
      await Promise.race([sleep(DOOR_COMMAND_SETTLE_MS), active.stop.promise, active.abort.promise, this._life.promise]);
      this._pulseCheck(active);
      active.phase = 'open';
      evidence.openAttempted = true; // A rejected write can still have reached hardware.
      await this._writePulseCommand(active, openCommand);
      evidence.openSent = true;
      evidence.openAt = now();
      if(untilOpen)progress('released');
      active.pulseDeadline = Date.now() + durationMs;
      this._pulseCheck(active);
      // Query only this board while ON. A missing reply never extends the dwell.
      if(untilOpen){
        evidence.relockReason='timeout';
        while(Date.now()<active.pulseDeadline){
          const response=await this._sampleDuringPulse(active,evidence);
          if(response)progress(response.bits[16-door]==='1'?'door-open':'released',response);
          if(response?.status==='responded'&&response.bits[16-door]==='1'){evidence.relockReason='door-open';break;}
          if(!response){if(Date.now()>=active.pulseDeadline)break;throw new SerialError('INPUT_STATUS','The selected door sensor could not be read. Relocking early.');}
          await Promise.race([sleep(Math.min(150,Math.max(0,active.pulseDeadline-Date.now()))),active.stop.promise,active.abort.promise,this._life.promise]);
          this._pulseCheck(active);
        }
      }else{
        await this._sampleDuringPulse(active, evidence);
        await Promise.race([sleep(Math.max(0, active.pulseDeadline - Date.now())), active.stop.promise, active.abort.promise, this._life.promise]);
      }
      this._pulseCheck(active);
    } catch (cause) {
      error = cause instanceof SerialError ? cause : new SerialError('WRITE', 'The door test could not finish.', cause);
      if(untilOpen)evidence.relockReason=error.code==='CANCELLED'?'cancelled':'input-or-USB-error';
      if (active.phase === 'preclear' && evidence.preclearAttempted && error.code !== 'CANCELLED') {
        error = new SerialError('LOCK_OFF', 'The initial scoped lock-off failed. No door-open command was sent; recover the controller and use a fresh connection before another door test.', error);
        this.activationBlocked = true;
        this.activationBlockReason = error.message;
      }
    } finally {
      if (evidence.openAttempted) {
        active.phase = 'off';
        evidence.offAttempted = true;
        try {
          // Attempt even after an ambiguous ON write, cancellation or input failure.
          // The controller shifts its last command bytes; do not terminate a partial
          // ON prefix separately, which could execute it as an unaddressed command.
          await this._writePulseCommand(active, offCommand, true);
          evidence.offSent = true;
          evidence.offAt = now();
          await sleep(DOOR_COMMAND_SETTLE_MS);
          if (active.offError) throw active.offError;
          if(untilOpen)progress('off');
        } catch (cause) {
          const offError = new SerialError('LOCK_OFF', 'Scoped lock-off did not complete successfully. Output state is unknown; recover the controller and use a fresh connection before another door test.', cause);
          if (error) offError.openError = {code: error.code, message: error.message};
          error = offError;
          this.activationBlocked = true;
          this.activationBlockReason = offError.message;
          if(untilOpen)progress('uncertain');
        }
      }
      evidence.cancelled = active.cancelled;
      evidence.raw = active.raw;
      evidence.at = now();
      if (error?.code === 'DISCONNECTED' && evidence.openAttempted) {
        this.activationBlocked = true;
        this.activationBlockReason = 'The connection failed during a door test. Recover the controller and use a fresh connection before another door test.';
      }
      if (error) {
        error.evidence = snapshot();
        this._event('error', {code: error.code, command: active.command, raw: active.raw, message: error.message, evidence: snapshot()});
      }
      // Write/transport failures invalidate the connection after OFF had its chance.
      if (error && (['WRITE', 'LOCK_OFF', 'DISCONNECTED'].includes(error.code) || this._lastError)) {
        await this._settlePulseShutdown(error);
      }
      this._finish(active);
      active.finished.resolve(snapshot());
    }
    if (error) throw error;
    return snapshot();
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
    const active = this._begin('RST#' + this.masterBoard, 'reset', this.masterBoard);
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
