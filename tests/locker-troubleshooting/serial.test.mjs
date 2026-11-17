import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialTransport, SerialError } from '../../locker-troubleshooting/serial.js';

const encoder = new TextEncoder();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = (board, bits='0000000011111111') =>
  `<${board}>Ex(BIN):${bits.slice(0, 8)}:${bits.slice(8)}~\r\n`;
const isCode = code => error => error instanceof SerialError && error.code === code;

class MockPort extends EventTarget {
  constructor({onCommand, openError, writeError}={}) {
    super();
    this.onCommand = onCommand;
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
      write: bytes => {
        if (this.writeError) throw this.writeError;
        const text = new TextDecoder().decode(bytes);
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
