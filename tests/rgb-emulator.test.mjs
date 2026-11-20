import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../rgb-controller/index.html', import.meta.url), 'utf8');
const script = id => html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'))[1];
const context = { TextEncoder, TextDecoder, ReadableStream, WritableStream, EventTarget, setTimeout, clearTimeout };
const { RGBFirmware, VirtualSerial, pwmFor } = runInNewContext(script('emulator') + '\nRGBEmulator;', context);
const { Controller } = runInNewContext(script('controller') + '\nRGB;', context);
const { Bridge } = runInNewContext(script('rgb-pico-bridge') + '\nRGBPicoBridge;', {
  ...context, setTimeout: (callback, delay) => setTimeout(callback, delay / 100),
});
const encoder = new TextEncoder();

async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected serial state was not received');
}

test('virtual firmware follows the RGB1 line protocol and rejects invalid values without changing state', () => {
  const firmware = new RGBFirmware();
  const feed = text => firmware.feed(encoder.encode(text));
  assert.equal(firmware.ready(), 'READY RGB1 115200\nSTATE OFF 100 255,255,255\n');
  assert.equal(feed('SE'), '');
  assert.equal(feed('T 255,128,0\r\nBRIGHT 50\n'), 'STATE ON 100 255,128,0\nSTATE ON 50 255,128,0\n');
  assert.deepEqual([...pwmFor(firmware.state)], [512, 257, 0]);
  assert.equal(feed('SET 256,0,0\nBRIGHT 101\nSAVE 4\nLOAD 2\nget\nGET\n'),
    'ERR RGB_RANGE\nERR BRIGHT_RANGE\nERR SLOT_RANGE\nERR PRESET_EMPTY\nERR UNKNOWN_COMMAND\nSTATE ON 50 255,128,0\n');
});

test('firmware limits input to 63 bytes and keeps presets through reset', () => {
  const firmware = new RGBFirmware();
  const feed = text => firmware.feed(encoder.encode(text));
  assert.equal(feed('x'.repeat(63) + '\n' + 'x'.repeat(64)), 'ERR UNKNOWN_COMMAND\n');
  assert.equal(feed('\n1,2,3\nBRIGHT 0\nSAVE 3\n'),
    'ERR LINE_TOO_LONG\nSTATE ON 100 1,2,3\nSTATE ON 0 1,2,3\nSTATE ON 0 1,2,3\n');
  assert.deepEqual([...pwmFor(firmware.state)], [0, 0, 0]);
  assert.equal(firmware.reset(), 'READY RGB1 115200\nSTATE OFF 100 255,255,255\n');
  assert.equal(feed('LOAD 3\nOFF\nBRIGHT 90\nON\n'),
    'STATE ON 0 1,2,3\nSTATE OFF 0 1,2,3\nSTATE OFF 90 1,2,3\nSTATE ON 90 1,2,3\n');
});

test('the existing controller uses virtual serial for state, animation, reset and reconnect', async t => {
  const serial = new VirtualSerial();
  let state;
  const controller = new Controller(serial, (kind, value) => {
    if (kind === 'state') state = value;
  }, 0);
  t.after(() => controller.disconnect());

  await controller.connect();
  await until(() => state?.on === false);
  await controller.send('BRIGHT 35');
  controller.startAnimation('Blink', [0, 0, 255], 500);
  await until(() => state?.on && state.rgb[2] === 255 && state.rgb[0] === 0);
  controller.stopAnimation();
  assert.equal(state.brightness, 35);
  await controller.send('SAVE 0');
  serial.reset();
  await until(() => state?.on === false && state.brightness === 100);
  await controller.disconnect();
  await controller.connect();
  await controller.send('LOAD 0');
  await until(() => state?.on && state.brightness === 35);
  assert.deepEqual([...state.rgb], [0, 0, 255]);
});

function picoPort(greeting = 'MCI304-USB-1\r\n') {
  const writes = [];
  let reader;
  const push = text => reader.enqueue(encoder.encode(text));
  const port = {
    async open(options) { this.options = options; },
    async setSignals(signals) { this.signals = signals; },
    async close() { this.closed = true; },
    readable: new ReadableStream({ start(stream) { reader = stream; } }),
    writable: new WritableStream({
      write(bytes) {
        const text = new TextDecoder().decode(bytes);
        writes.push(text);
        if (text === '\n?\n' && greeting && writes.length === 1) {
          push(greeting.slice(0, 6));
          push(greeting.slice(6));
        }
      },
    }),
  };
  return { port, writes, push };
}

test('Pico transports Windows serial commands and streams ordered firmware replies', async t => {
  const { port, writes, push } = picoPort();
  const errors = [];
  const firmware = new RGBFirmware();
  const bridge = new Bridge(port, bytes => firmware.feed(bytes), error => errors.push(error));
  t.after(() => bridge.close());
  await bridge.open();

  assert.equal(port.options.baudRate, 115200);
  assert.equal(port.signals.dataTerminalReady, true);
  assert.deepEqual(writes, ['\n?\n']);

  const frame = text => '>' + Buffer.from(text).toString('hex') + '\r\n';
  const packet = frame('GE') + frame('T\r\nSET 0,255,0\nBRIGHT 40\nGET\n');
  push(packet.slice(0, 11));
  push(packet.slice(11));
  await until(() => writes.length === 3);
  const replies = writes.slice(1).map(line => Buffer.from(line.slice(1).trim(), 'hex').toString()).join('');
  assert.equal(replies, 'STATE OFF 100 255,255,255\nSTATE ON 100 0,255,0\nSTATE ON 40 0,255,0\nSTATE ON 40 0,255,0\n');
  assert.ok(writes.slice(1).every(line => line.trim().length <= 129));
  assert.deepEqual([...pwmFor(firmware.state)], [0, 409, 0]);

  push('!write\n');
  await until(() => errors.length === 1);
  assert.match(errors[0].message, /could not deliver a reply/);
  await bridge.close();
  assert.equal(port.closed, true);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
});

test('Pico rejects the other interface when it cannot complete the bridge handshake', async () => {
  const { port, writes } = picoPort('READY RGB1 115200\n');
  const bridge = new Bridge(port, () => assert.fail('Handshake data was passed to the RGB firmware'), () => {});
  await assert.rejects(bridge.open(), /No Pico bridge reply/);
  assert.equal(writes.length, 5);
  assert.equal(port.closed, true);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
});
