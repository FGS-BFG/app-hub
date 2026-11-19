import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Locker, SerialFrames, boards} from '../locker-emulator/model.js';
import {verifyLockClear} from '../locker-lock-clear.js';

test('all five boards pass the existing Locker Control startup and keep their addresses', async () => {
  const locker = new Locker();
  await verifyLockClear(async command => locker.command(command), boards);
  for (const address of boards) {
    const marker = address === 'C' ? '' : '~';
    assert.equal(locker.command('ISB#' + address), '<' + address + '>Ex(BIN):00000000:00000000' + marker + '\n\r');
  }
  assert.equal(locker.command('GFV'), '<C>Firmware : MCi_304-Fw1.5.9fs\n\r');
  assert.equal(locker.command('ISB#Z'), '');
});

test('a bay opens only with its coil active, closes after LC, and preserves other banks', () => {
  const locker = new Locker();
  assert.equal(locker.move('A', 8), false);
  assert.equal(locker.command('LM8#A'), '');
  assert.equal(locker.move('A', 8), true);
  assert.equal(locker.command('ISB#A'), '<A>Ex(BIN):00000001:00000000~\n\r');
  assert.equal(locker.command('ISB#B'), '<B>Ex(BIN):00000000:00000000~\n\r');
  locker.command('LC');
  assert.equal(locker.move('A', 8), true);
  assert.equal(locker.command('ISB#A'), '<A>Ex(BIN):00000000:00000000~\n\r');
});

test('the fifth open door cuts cabinet-wide coil power until the count returns to four', () => {
  const locker = new Locker();
  for (const [index, board] of [...boards].entries()) {
    assert.equal(locker.command('LM0#' + board), '');
    assert.equal(locker.move(board, 0), true);
    assert.equal(locker.openCount, index + 1);
    assert.equal(locker.powerOn, index < 4);
  }
  assert.equal(locker.command('ISB#C'), '<C>Ex(BIN):00000000:00000001\n\r');
  locker.command('LM1#A');
  assert.equal(locker.command('LRS#A'), '<A>Lock Word:0000000000000011~\n\r');
  assert.equal(locker.coilActive('A', 1), false);
  assert.equal(locker.move('A', 1), false);
  assert.equal(locker.openCount, 5);
  assert.equal(locker.move('E', 0), true);
  assert.equal(locker.openCount, 4);
  assert.equal(locker.powerOn, true);
  assert.equal(locker.coilActive('A', 1), true);
  assert.deepEqual(locker.events.filter(event => event.kind === 'POWER').map(event => event.message), [
    'Power supplies off · 5 doors open', 'Power supplies restored · 4 doors open',
  ]);
});

test('serial framing keeps partial ASCII and literal raw I/O bytes', () => {
  const frames = new SerialFrames();
  assert.deepEqual(frames.feed('L'), []);
  assert.deepEqual(frames.feed('C\r\nW#\x00#D\rW\x01\n#D\r'), ['LC', 'W#\x00#D', 'W\x01\n#D']);
  assert.deepEqual(frames.feed('X'.repeat(33) + '\rISB\r'), ['ISB']);
  const locker = new Locker();
  locker.command('W#\x00#D');
  assert.equal(locker.command('ROW#D'), '<D>RoW:\x13\x00~\n\r');
});

test('global clear, paired commands, timer expiry and reset responses follow the desktop model', () => {
  let now = 0;
  const locker = new Locker(() => now);
  locker.command('CM!#B');
  assert.match(locker.command('AA14#B'), /0001000000000010/);
  now = 2999;
  assert.equal(locker.tick(), '');
  now = 3000;
  assert.equal(locker.tick(), '<B>REMOTE_Lock Done~\n\r');
  assert.equal(locker.command('LRS#B'), '<B>Lock Word:0000000000000000~\n\r');
  assert.equal(locker.command('RST'), '<C>SYSTEM_Reset in 5 seconds...\n\r');
  now = 7800;
  assert.match(locker.tick(), /<C>Firmware : MCi_304-Fw1\.5\.9fs\n\r<C>Board  ID : 43/);
});
