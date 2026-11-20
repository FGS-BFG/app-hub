import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../rgb-controller/index.html', import.meta.url), 'utf8');
const script = id => html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'))[1];
const context = { TextEncoder, TextDecoder, ReadableStream, WritableStream, EventTarget, setTimeout, clearTimeout };
const { RGBFirmware, VirtualSerial, pwmFor } = runInNewContext(script('emulator') + '\nRGBEmulator;', context);
const { Controller } = runInNewContext(script('controller') + '\nRGB;', context);
const encoder = new TextEncoder();

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

  async function until(predicate) {
    for (let i = 0; i < 40; i++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected serial state was not received');
  }

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
