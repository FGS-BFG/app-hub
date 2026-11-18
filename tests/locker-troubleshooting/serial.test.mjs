import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialTransport, SerialError, DEFAULT_DOOR_PULSE_MS, MIN_DOOR_PULSE_MS,
  MAX_DOOR_PULSE_MS } from '../../locker-troubleshooting/serial.js';

const encoder = new TextEncoder();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = (board, bits='0000000011111111') =>
  `<${board}>Ex(BIN):${bits.slice(0, 8)}:${bits.slice(8)}~\r\n`;
const isCode = code => error => error instanceof SerialError && error.code === code;

class MockPort extends EventTarget {
  constructor({onCommand, onWrite, openError, writeError}={}) {
    super();
    this.onCommand = onCommand;
    this.onWrite = onWrite;
    this.openError = openError;
    this.writeError = writeError;
    this.commands = [];
    this.writes = [];
    this.openCalls = [];
    this.signalCalls = [];
    this.closeCalls = 0;
    this.readCancelled = false;
    this.pendingText = '';
    this.waiters = [];
    this.readable = new ReadableStream({
      start: controller => { this.controller = controller; },
      cancel: () => { this.readCancelled = true; },
    });
    this.writable = new WritableStream({
      write: async bytes => {
        if (this.writeError) throw this.writeError;
        const text = new TextDecoder().decode(bytes);
        await this.onWrite?.(text, this);
        this.writes.push(text);
        this.pendingText += text;
        let ending;
        while ((ending=this.pendingText.indexOf('\r')) !== -1) {
          const command = this.pendingText.slice(0, ending+1);
          this.pendingText = this.pendingText.slice(ending+1);
          this.commands.push(command);
          for (const waiter of this.waiters.splice(0)) waiter(command);
          this.onCommand?.(command, this);
        }
      },
    });
  }
  async open(options) {
    this.openCalls.push(options);
    if (this.openError) throw this.openError;
  }
  async setSignals(signals) { this.signalCalls.push(signals); }
  async close() { this.closeCalls++; }
  send(text) { this.controller.enqueue(encoder.encode(text)); }
  endRead() { this.controller.close(); }
  failRead(error=new Error('USB read failed')) { this.controller.error(error); }
  disconnect() {
    this.dispatchEvent(new Event('disconnect'));
  }
  command() {
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

async function opened(t, portOptions={}, options={}) {
  const port = new MockPort(portOptions);
  const events = [], states = [];
  const transport = new SerialTransport(port, {
    timeout:40, startupDelay:0, resetDelay:0, charDelay:0, quietDelay:0,
    onEvent:event => events.push(event), onState:state => states.push(state),
    ...options,
  });
  t.after(async () => { await transport.close(); });
  await transport.open();
  return {port, transport, events, states};
}

test('opens the serial port with the MCI settings and releases it when closed', async t => {
  const {port, transport} = await opened(t);
  assert.equal(transport.connected, true);
  assert.equal(transport.busy, false);
  assert.equal(port.openCalls.length, 1);
  assert.equal(port.openCalls[0].baudRate, 9600);
  assert.equal(port.openCalls[0].dataBits, 8);
  assert.equal(port.openCalls[0].stopBits, 1);
  assert.equal(port.openCalls[0].parity, 'none');
  assert.equal(port.openCalls[0].flowControl, 'none');
  await transport.close();
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
  assert.equal(port.closeCalls, 1);
  assert.equal(port.readCancelled, true);
});

test('assembles an ISB response split at arbitrary byte boundaries', async t => {
  const {port, transport} = await opened(t, {onCommand(command, p) {
    assert.equal(command, 'ISB#A\r');
    for (const part of ['<', 'A>Ex(', 'BIN):000', '00000:', '11111', '111', '~', '\r', '\n']) {
      p.send(part);
    }
  }});
  const response = await transport.query('A');
  assert.equal(response.board, 'A');
  assert.equal(response.bits, '0000000011111111');
  assert.match(response.raw, /<A>Ex\(BIN\):00000000:11111111/);
  assert.equal(Number.isFinite(response.elapsedMs), true);
  assert.equal(Number.isNaN(Date.parse(response.at)), false);
  assert.equal(port.writes.join(''), 'ISB#A\r');
  assert.equal(transport.busy, false);
});

test('handles noise, echo, and several complete frames in one read while matching the requested board', async t => {
  const {transport} = await opened(t, {onCommand(command, p) {
    p.send(`startup message\r\n${command}\r\n${frame('B', '1111111111111111')}${frame('A')}${frame('E')}`);
  }});
  const response = await transport.query('A');
  assert.equal(response.board, 'A');
  assert.equal(response.bits, '0000000011111111');
});

test('a reply from the wrong board is a protocol problem, never success or an assumed board timeout', async t => {
  const {transport} = await opened(t, {onCommand(command, p) { p.send(frame('B')); }});
  await assert.rejects(transport.query('A'), error => {
    assert.equal(isCode('PROTOCOL')(error), true);
    assert.match(error.raw, /<B>Ex\(BIN\)/);
    return true;
  });
  assert.equal(transport.connected, true);
  assert.equal(transport.busy, false);
});

test('accepts all-zero and all-one words as communication replies without interpreting sensor health', async t => {
  for (const bits of ['0000000000000000', '1111111111111111']) {
    const {transport} = await opened(t, {onCommand(command, p) { p.send(frame('C', bits)); }});
    const response = await transport.query('C');
    assert.equal(response.bits, bits);
    assert.equal(response.board, 'C');
    assert.equal('healthy' in response, false);
    assert.equal('fault' in response, false);
    assert.equal('diagnosis' in response, false);
  }
});

test('malformed ISB data from the requested board is a protocol error, not a board timeout', async t => {
  const {transport} = await opened(t, {onCommand(command, p) {
    p.send('<A>Ex(BIN):00000002:11111111~\r\n');
  }});
  await assert.rejects(transport.query('A'), error => {
    assert.equal(isCode('PROTOCOL')(error), true);
    assert.match(error.raw, /00000002/);
    return true;
  });
  assert.equal(transport.connected, true);
});

test('an otherwise valid prefix cannot make an overlong or contaminated bit word a valid response', async t => {
  for (const payload of [
    '<A>Ex(BIN):00000000:1111111',
    '<A>Ex(BIN):00000000:111111111',
    '<A>Ex(BIN):00000000:111111112',
    '<A>Ex(BIN):00000000:11111111garbage',
  ]) {
    const {transport} = await opened(t, {onCommand(command, p) { p.send(payload+'~\r\n'); }});
    await assert.rejects(transport.query('A'), isCode('PROTOCOL'), payload);
  }
});

test('the response parser cannot combine an unterminated old frame with a new query', async t => {
  const {transport} = await opened(t, {onCommand(command, p) {
    if (command === 'ISB#A\r') p.send('<A>Ex(BIN):00000000:');
    if (command === 'ISB#B\r') p.send(frame('B', '1010101001010101'));
  }});
  await assert.rejects(transport.query('A'), isCode('PROTOCOL'));
  const response = await transport.query('B');
  assert.equal(response.board, 'B');
  assert.equal(response.bits, '1010101001010101');
});

test('a timed-out response is quarantined and cannot be mistaken for the next board', async t => {
  const {transport, port} = await opened(t, {onCommand(command, p) {
    if (command === 'ISB#B\r') p.send(frame('B'));
  }});
  await assert.rejects(transport.query('A'), isCode('TIMEOUT'));
  const pending = transport.query('B');
  port.send(frame('A', '1111111111111111'));
  const response = await pending;
  assert.equal(response.board, 'B');
  assert.equal(response.bits, '0000000011111111');
  assert.deepEqual(port.commands, ['ISB#A\r', 'ISB#B\r']);
});

test('quarantines a late reply even when the next query repeats the same board', async t => {
  let requests = 0;
  const {transport, port} = await opened(t, {onCommand(command, p) {
    if (++requests === 2) p.send(frame('A', '1010101001010101'));
  }});
  await assert.rejects(transport.query('A'), isCode('TIMEOUT'));
  const pending = transport.query('A');
  port.send(frame('A', '1111111111111111'));
  const response = await pending;
  assert.equal(response.board, 'A');
  assert.equal(response.bits, '1010101001010101');
  assert.deepEqual(port.commands, ['ISB#A\r', 'ISB#A\r']);
});

test('unsolicited replies received before a query are not reused as evidence for that query', async t => {
  const {transport, port} = await opened(t);
  port.send(frame('A'));
  await wait(0);
  await assert.rejects(transport.query('A'), isCode('TIMEOUT'));
  assert.deepEqual(port.commands, ['ISB#A\r']);
});

test('rejects overlapping board checks and resets without writing extra commands', async t => {
  const {transport, port} = await opened(t, {}, {timeout:200});
  const written = port.command();
  const pending = transport.query('A');
  assert.equal(await written, 'ISB#A\r');
  assert.equal(transport.busy, true);
  await assert.rejects(transport.query('B'), isCode('BUSY'));
  await assert.rejects(transport.resetMaster(), isCode('BUSY'));
  assert.deepEqual(port.commands, ['ISB#A\r']);
  port.send(frame('A'));
  await pending;
  assert.equal(transport.busy, false);
});

test('rejects invalid board addresses and injected commands without any serial writes', async t => {
  const {transport, port} = await opened(t);
  for (const board of ['', 'F', 'RST#A', 'A\rRST#C', '#A', null, undefined]) {
    await assert.rejects(transport.query(board), isCode('INVALID_COMMAND'));
  }
  assert.deepEqual(port.writes, []);
  assert.equal(transport.busy, false);
});

test('master reset writes only RST C and records that reset completion is unconfirmed', async t => {
  const {transport, port} = await opened(t);
  const result = await transport.resetMaster();
  assert.deepEqual(port.commands, ['RST#C\r']);
  assert.equal(result.confirmed, false);
  assert.equal(Number.isNaN(Date.parse(result.at)), false);
  assert.equal(transport.connected, true);
  assert.equal(transport.busy, false);
});

test('the master reset banner is an acknowledgement rather than proof the reset completed', async t => {
  const {transport, port} = await opened(t, {onCommand(command, p) {
    p.send('<C>SYSTEM_Reset in 5 seconds...\r\n');
  }});
  const result = await transport.resetMaster();
  assert.deepEqual(port.commands, ['RST#C\r']);
  assert.equal(result.acknowledged, true);
  assert.equal(result.confirmed, false);
});

test('a real response deadline expires as TIMEOUT while keeping a live transport usable', async t => {
  const {transport, port} = await opened(t);
  await assert.rejects(transport.query('A'), isCode('TIMEOUT'));
  assert.equal(transport.connected, true);
  port.onCommand = (command, p) => p.send(frame('C'));
  assert.equal((await transport.query('C')).board, 'C');
});

test('closing during a pending query rejects it as DISCONNECTED and releases both stream locks', async t => {
  const {transport, port} = await opened(t, {}, {timeout:500});
  const written = port.command();
  const rejection = assert.rejects(transport.query('A'), isCode('DISCONNECTED'));
  await written;
  await transport.close();
  await rejection;
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
});

test('a serial disconnect rejects a pending query as a transport failure instead of no board response', async t => {
  const {transport, port} = await opened(t, {}, {timeout:500});
  const written = port.command();
  const rejection = assert.rejects(transport.query('E'), isCode('DISCONNECTED'));
  await written;
  port.disconnect();
  await rejection;
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
  await assert.rejects(transport.query('C'), isCode('DISCONNECTED'));
});

test('the readable stream ending is a disconnect, including when a reply is only half received', async t => {
  const {transport, port} = await opened(t, {}, {timeout:500});
  const written = port.command();
  const rejection = assert.rejects(transport.query('D'), isCode('DISCONNECTED'));
  await written;
  port.send('<D>Ex(BIN):00000000:');
  port.endRead();
  await rejection;
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
});

test('a write failure is reported as WRITE and invalidates the transport', async t => {
  const {transport} = await opened(t, {writeError:new Error('USB write failed')});
  await assert.rejects(transport.query('A'), isCode('WRITE'));
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
});

test('a read error rejects the pending check as DISCONNECTED rather than a board timeout', async t => {
  const {transport, port} = await opened(t, {}, {timeout:500});
  const written = port.command();
  const rejection = assert.rejects(transport.query('A'), isCode('DISCONNECTED'));
  await written;
  port.failRead();
  await rejection;
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
});

test('an explicit controller error is distinct from a missing board response', async t => {
  const {transport} = await opened(t, {onCommand(command, p) {
    p.send('<A>Command Error:~\r');
  }});
  await assert.rejects(transport.query('A'), isCode('CONTROLLER'));
  assert.equal(transport.connected, true);
  assert.equal(transport.busy, false);
});

test('a port-open failure is PORT and never establishes a usable connection', async t => {
  const port = new MockPort({openError:new Error('COM port in use')});
  const transport = new SerialTransport(port, {startupDelay:0, quietDelay:0});
  t.after(async () => { await transport.close(); });
  await assert.rejects(transport.open(), isCode('PORT'));
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
  assert.deepEqual(port.writes, []);
});

test('door pulses preclear and finally clear only the addressed board, without claiming physical success', async t => {
  const {transport, port, events} = await opened(t);
  const result = await transport.pulseDoor('D', 11, {durationMs:100});
  assert.deepEqual(port.commands, ['LMX#D\r', 'LAA#D\r', 'ISB#D\r', 'LMX#D\r']);
  assert.deepEqual(events.filter(e => e.type === 'tx').map(e => e.command), ['LMX#D', 'LAA#D', 'ISB#D', 'LMX#D']);
  assert.equal(result.board, 'D');
  assert.equal(result.door, 11);
  assert.equal(result.openCommand, 'LAA#D');
  assert.equal(result.offCommand, 'LMX#D');
  assert.equal(result.durationMs, 100);
  assert.equal(result.preclearSent, true);
  assert.equal(result.openAttempted, true);
  assert.equal(result.openSent, true);
  assert.equal(result.offAttempted, true);
  assert.equal(result.offSent, true);
  assert.equal(result.offConfirmed, false);
  assert.equal(result.cancelled, false);
  assert.equal('opened' in result, false);
  assert.equal(Number.isNaN(Date.parse(result.at)), false);
  assert.ok(Date.parse(result.preclearAt) <= Date.parse(result.openAt));
  assert.ok(Date.parse(result.openAt) < Date.parse(result.offAt));
  assert.ok(Date.parse(result.offAt) <= Date.parse(result.at));
  assert.equal(result.samples.length,1);
  assert.equal(result.samples[0].status,'no-response');
  assert.equal(transport.busy, false);
  assert.equal(transport.connected, true);
});

test('door numbering maps exactly across both eight-output groups and hexadecimal boundaries', async t => {
  const {transport, port} = await opened(t);
  for (const [board, door, code] of [['A',1,'0'],['B',8,'7'],['C',9,'8'],['D',10,'9'],['E',16,'F']]) {
    const result = await transport.pulseDoor(board, door, {durationMs:100});
    assert.equal(result.openCommand, `LA${code}#${board}`);
    assert.deepEqual(port.commands.slice(-4), [`LMX#${board}\r`, `LA${code}#${board}\r`, `ISB#${board}\r`, `LMX#${board}\r`]);
  }
});

test('the default pulse is 500ms and exported duration limits remain narrow', async t => {
  assert.equal(DEFAULT_DOOR_PULSE_MS, 500);
  assert.equal(MIN_DOOR_PULSE_MS, 100);
  assert.equal(MAX_DOOR_PULSE_MS, 2000);
  const {transport} = await opened(t);
  const result = await transport.pulseDoor('C', 1);
  assert.equal(result.durationMs, 500);
});

test('invalid door requests cannot write or broaden the diagnostic command allowlist', async t => {
  const {transport, port} = await opened(t);
  for (const [board, door, options] of [
    ['',1],['F',1],['a',1],['A\rLC',1],[null,1],['A',0],['A',17],['A',1.1],['A','1'],['A',NaN],
    ['A',1,{durationMs:99}],['A',1,{durationMs:2001}],['A',1,{durationMs:100.5}],['A',1,{durationMs:'500'}],
    ['A',1,{durationMs:Infinity}],['A',1,null],['A',1,[]],['A',1,{command:'LM0#B'}],['A',1,{offCommand:'LC'}],
  ]) await assert.rejects(transport.pulseDoor(board, door, options), isCode('INVALID_COMMAND'));
  for (const command of ['LM0#A', 'LA0#A', 'LMX#A', 'LC', 'DR1#C']) {
    assert.throws(() => transport._begin(command, 'query', 'A'), isCode('INVALID_COMMAND'));
  }
  assert.deepEqual(port.writes, []);
  assert.equal(transport.busy, false);
});

test('door pulses exclude queries, resets and other pulses until the final scoped OFF', async t => {
  const {transport, port} = await opened(t);
  const written = port.command();
  const pending = transport.pulseDoor('A', 1, {durationMs:100});
  assert.equal(await written, 'LMX#A\r');
  await assert.rejects(transport.query('B'), isCode('BUSY'));
  await assert.rejects(transport.resetMaster(), isCode('BUSY'));
  await assert.rejects(transport.pulseDoor('E', 16, {durationMs:100}), isCode('BUSY'));
  await pending;
  assert.deepEqual(port.commands, ['LMX#A\r', 'LA0#A\r', 'ISB#A\r', 'LMX#A\r']);
});

test('a failed initial scoped clear forbids ON and blocks further activations', async t => {
  const {transport, port} = await opened(t, {writeError:new Error('Initial clear write failed')});
  await assert.rejects(transport.pulseDoor('B', 8, {durationMs:100}), error => {
    assert.equal(error.code, 'LOCK_OFF');
    assert.equal(error.evidence.preclearAttempted, true);
    assert.equal(error.evidence.preclearSent, false);
    assert.equal(error.evidence.openAttempted, false);
    assert.equal(error.evidence.openSent, false);
    return true;
  });
  assert.deepEqual(port.commands, []);
  assert.equal(transport.activationBlocked, true);
  await assert.rejects(transport.pulseDoor('B', 8), isCode('ACTIVATION_BLOCKED'));
});

test('an ambiguous rejected ON write still attempts OFF, never retries ON, and preserves evidence', async t => {
  const {transport, port, events} = await opened(t, {onCommand(command) {
    if (command === 'LA8#E\r') throw new Error('Write rejected after bytes may have reached the controller');
  }});
  await assert.rejects(transport.pulseDoor('E', 9, {durationMs:100}), error => {
    assert.equal(error.code, 'LOCK_OFF');
    assert.equal(error.evidence.openAttempted, true);
    assert.equal(error.evidence.openSent, false);
    assert.equal(error.evidence.offAttempted, true);
    assert.equal(error.evidence.offSent, false);
    assert.equal(error.evidence.offConfirmed, false);
    return true;
  });
  assert.deepEqual(port.commands, ['LMX#E\r', 'LA8#E\r']);
  assert.deepEqual(events.filter(e => e.type === 'tx').map(e => e.command), ['LMX#E', 'LA8#E', 'LMX#E']);
  assert.equal(transport.activationBlocked, true);
  assert.equal(transport.connected, false);
  assert.equal(transport.busy, false);
});

test('failed final OFF blocks activation on this transport even if later diagnostic state changes', async t => {
  let clears = 0;
  const {transport, port} = await opened(t, {onCommand(command) {
    if (command === 'LMX#C\r' && ++clears === 2) throw new Error('Final OFF failed');
  }});
  await assert.rejects(transport.pulseDoor('C',16,{durationMs:100}), error => {
    assert.equal(error.code, 'LOCK_OFF');
    assert.equal(error.evidence.openSent, true);
    assert.equal(error.evidence.offAttempted, true);
    assert.equal(error.evidence.offSent, false);
    return true;
  });
  assert.deepEqual(port.commands, ['LMX#C\r', 'LAF#C\r', 'ISB#C\r', 'LMX#C\r']);
  assert.equal(transport.activationBlocked, true);
  assert.match(transport.activationBlockReason, /unknown/);
  transport.connected = true; // Neither a status flag nor an idle port releases this latch.
  await assert.rejects(transport.pulseDoor('C',1), isCode('ACTIVATION_BLOCKED'));
  transport.connected = false;
});

test('an addressed controller rejection after ON still sends the scoped OFF', async t => {
  const {transport, port} = await opened(t, {onCommand(command,p) {
    if (command === 'LA0#A\r') p.send('<A>Lock Events Deactivated~\r');
  }});
  await assert.rejects(transport.pulseDoor('A',1,{durationMs:100}), error => {
    assert.equal(error.code, 'CONTROLLER');
    assert.equal(error.evidence.openSent, true);
    assert.equal(error.evidence.offSent, true);
    return true;
  });
  assert.deepEqual(port.commands, ['LMX#A\r', 'LA0#A\r', 'LMX#A\r']);
  assert.equal(transport.busy, false);
});

test('a delayed controller rejection of preclear forbids ON and blocks activation', async t => {
  const {transport,port} = await opened(t, {onCommand(command,p) {
    if(command === 'LMX#B\r') setTimeout(() => p.send('<B>Command Error:~\r'), 5);
  }});
  await assert.rejects(transport.pulseDoor('B',2,{durationMs:100}), error => {
    assert.equal(error.code,'LOCK_OFF');
    assert.equal(error.evidence.preclearSent,true);
    assert.equal(error.evidence.openAttempted,false);
    return true;
  });
  assert.deepEqual(port.commands,['LMX#B\r']);
  assert.equal(transport.activationBlocked,true);
});

test('a delayed controller rejection of final OFF is distinct from successful transmission', async t => {
  let clears = 0;
  const {transport} = await opened(t, {onCommand(command,p) {
    if(command === 'LMX#C\r' && ++clears === 2) setTimeout(() => p.send('<C>Command Error:~\r'), 5);
  }});
  await assert.rejects(transport.pulseDoor('C',2,{durationMs:100}), error => {
    assert.equal(error.code,'LOCK_OFF');
    assert.equal(error.evidence.openSent,true);
    assert.equal(error.evidence.offSent,true);
    assert.equal(error.evidence.offConfirmed,false);
    return true;
  });
  assert.equal(transport.activationBlocked,true);
});

test('voluntary cancellation skips dwell and resolves final evidence after scoped OFF', async t => {
  let openedDoor;
  const on = new Promise(resolve => { openedDoor = resolve; });
  const {transport, port} = await opened(t, {onCommand(command) { if(command === 'LA0#D\r') openedDoor(); }});
  const rejection = assert.rejects(transport.pulseDoor('D',1,{durationMs:2000}), error => {
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.evidence.cancelled, true);
    assert.equal(error.evidence.offSent, true);
    return true;
  });
  await on;
  const evidence = await transport.cancelDoorPulse();
  await rejection;
  assert.equal(evidence.cancelled, true);
  assert.equal(evidence.offSent, true);
  assert.deepEqual(port.commands, ['LMX#D\r', 'LA0#D\r', 'LMX#D\r']);
  assert.equal(transport.connected, true);
  assert.equal(transport.busy, false);
});

test('cancellation before the first frame cannot activate a door', async t => {
  const {transport,port} = await opened(t);
  const rejection = assert.rejects(transport.pulseDoor('A',1), isCode('CANCELLED'));
  const evidence = await transport.cancelDoorPulse();
  await rejection;
  assert.equal(evidence.openAttempted, false);
  assert.equal(evidence.openSent, false);
  assert.deepEqual(port.commands, []);
});

test('close waits for scoped OFF before aborting the writer or releasing either stream', async t => {
  let openedDoor;
  const on = new Promise(resolve => { openedDoor = resolve; });
  const {transport,port} = await opened(t, {onCommand(command) { if(command === 'LA7#B\r') openedDoor(); }});
  const rejection = assert.rejects(transport.pulseDoor('B',8,{durationMs:2000}), isCode('CANCELLED'));
  await on;
  await transport.close();
  await rejection;
  assert.deepEqual(port.commands, ['LMX#B\r', 'LA7#B\r', 'LMX#B\r']);
  assert.equal(transport.connected,false);
  assert.equal(transport.busy,false);
  assert.equal(port.readable.locked,false);
  assert.equal(port.writable.locked,false);
});

test('a physical disconnect after ON reports uncertainty and attempts OFF before releasing the port', async t => {
  const {transport,port,events} = await opened(t, {onCommand(command,p) {
    if(command === 'LA0#E\r') p.disconnect();
  }});
  await assert.rejects(transport.pulseDoor('E',1,{durationMs:100}), error => {
    assert.equal(error.code,'DISCONNECTED');
    assert.equal(error.evidence.openSent,true);
    assert.equal(error.evidence.offAttempted,true);
    assert.equal(error.evidence.offConfirmed,false);
    return true;
  });
  assert.deepEqual(events.filter(e => e.type === 'tx').map(e => e.command), ['LMX#E','LA0#E','LMX#E']);
  assert.equal(transport.connected,false);
  assert.equal(transport.activationBlocked,true);
  assert.equal(port.readable.locked,false);
  assert.equal(port.writable.locked,false);
});

test('a stalled USB write has a deadline, attempts OFF, and cannot hang or reopen the failed transport', async t => {
  const {transport,events} = await opened(t, {onWrite(text,p) {
    if(p.commands.length === 1 && p.pendingText === '') return new Promise(() => {});
  }});
  const started = Date.now();
  await assert.rejects(transport.pulseDoor('A',1,{durationMs:100}), error => {
    assert.equal(error.code,'LOCK_OFF');
    assert.equal(error.evidence.openAttempted,true);
    assert.equal(error.evidence.openSent,false);
    assert.equal(error.evidence.offAttempted,true);
    assert.equal(error.evidence.offSent,false);
    return true;
  });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(events.filter(e => e.type === 'tx').map(e => e.command), ['LMX#A','LA0#A','LMX#A']);
  assert.equal(transport.activationBlocked,true);
  assert.equal(transport.connected,false);
  assert.equal(transport.busy,false);
  assert.equal(transport._closing,true);
  await assert.rejects(transport.open(), isCode('BUSY'));
});

test('captures one addressed input sample during energization before the final OFF', async t => {
  const {transport,port} = await opened(t, {onCommand(command,p) {
    if(command === 'ISB#A\r') {
      p.send(frame('B','1111111111111111'));
      p.send(frame('A','1000000000000001'));
    }
  }});
  const evidence = await transport.pulseDoor('A',1,{durationMs:100});
  assert.deepEqual(port.commands,['LMX#A\r','LA0#A\r','ISB#A\r','LMX#A\r']);
  assert.equal(evidence.samples.length,1);
  assert.equal(evidence.samples[0].board,'A');
  assert.equal(evidence.samples[0].status,'responded');
  assert.equal(evidence.samples[0].bits,'1000000000000001');
  assert.ok(Date.parse(evidence.openAt) <= Date.parse(evidence.samples[0].at));
  assert.ok(Date.parse(evidence.samples[0].at) < Date.parse(evidence.offAt));
  assert.match(evidence.samples[0].raw,/<A>Ex\(BIN\)/);
  assert.equal(evidence.offConfirmed,false);
});

test('an absent status reply cannot extend the original ON dwell to the query timeout', async t => {
  let onAt,offAt,clears=0;
  const {transport} = await opened(t, {onCommand(command) {
    if(command === 'LA0#A\r') onAt=Date.now();
    if(command === 'LMX#A\r' && ++clears === 2) offAt=Date.now();
  }}, {timeout:1500});
  const evidence = await transport.pulseDoor('A',1,{durationMs:100});
  assert.equal(evidence.samples[0].status,'no-response');
  assert.equal(evidence.samples[0].code,'TIMEOUT');
  assert.equal('bits' in evidence.samples[0],false);
  assert.ok(offAt-onAt < 300, `OFF followed ON after ${offAt-onAt}ms`);
});

test('malformed during-pulse input is preserved as protocol evidence without suppressing OFF', async t => {
  const {transport,port} = await opened(t, {onCommand(command,p) {
    if(command === 'ISB#D\r') p.send('<D>Ex(BIN):00000000:11111112~\r');
  }});
  const evidence = await transport.pulseDoor('D',1,{durationMs:100});
  assert.equal(evidence.samples[0].status,'error');
  assert.equal(evidence.samples[0].code,'PROTOCOL');
  assert.match(evidence.samples[0].raw,/11111112/);
  assert.equal(evidence.offSent,true);
  assert.equal(port.commands.at(-1),'LMX#D\r');
});

test('a disconnect during the internal status query preserves failed sample evidence and attempts OFF', async t => {
  const {transport,events} = await opened(t, {onCommand(command,p) {
    if(command === 'ISB#E\r') p.disconnect();
  }});
  await assert.rejects(transport.pulseDoor('E',1,{durationMs:100}), error => {
    assert.equal(error.code,'DISCONNECTED');
    assert.equal(error.evidence.samples.length,1);
    assert.equal(error.evidence.samples[0].status,'error');
    assert.equal(error.evidence.samples[0].code,'DISCONNECTED');
    assert.equal(error.evidence.offAttempted,true);
    return true;
  });
  assert.deepEqual(events.filter(e => e.type === 'tx').map(e => e.command),['LMX#E','LA0#E','ISB#E','LMX#E']);
  assert.equal(transport.activationBlocked,true);
});
