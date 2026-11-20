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

test('five open doors stay powered when each lock is released separately', () => {
  const locker = new Locker();
  for (const board of boards) {
    locker.command('LM0#' + board);
    assert.equal(locker.move(board, 0), true);
    assert.equal(locker.activeLockCount, 1);
    locker.command('LC');
  }
  assert.equal(locker.powerOn, true);
  assert.equal(locker.command('ISB#C'), '<C>Ex(BIN):00000000:00000001\n\r');
});

test('the fifth energised lock cuts coil power and silences serial until power is restored', () => {
  let now = 0;
  const locker = new Locker(() => now);
  locker.command('HB1');
  locker.command('CM!#E');
  for (const board of 'ABCD') locker.command('LM0#' + board);
  assert.equal(locker.move('A', 0), true);
  assert.equal(locker.move('B', 0), true);
  locker.command('LM0#D');
  assert.equal(locker.activeLockCount, 4);
  assert.equal(locker.powerOn, true);
  assert.equal(locker.command('LA0#E'), '');
  assert.equal(locker.powerOn, false);
  assert.equal(locker.tripCount, 5);
  assert.equal(locker.activeLockCount, 0);
  assert.equal(locker.coilActive('A', 0), false);
  assert.equal(locker.events.at(-1).kind, 'POWER');
  const eventCount = locker.events.length;
  now = 6000;
  assert.equal(locker.command('ISB#A'), '');
  assert.equal(locker.command('LC'), '');
  assert.equal(locker.tick(), '');
  assert.equal(locker.events.length, eventCount);
  assert.equal(locker.move('B', 0), true);
  assert.equal(locker.powerOn, false);
  locker.restorePower();
  assert.equal(locker.powerOn, true);
  assert.equal(locker.tick(), '');
  assert.equal(locker.command('LRS#A'), '<A>Lock Word:0000000000000000~\n\r');
  assert.equal(locker.command('ISB#A'), '<A>Ex(BIN):00000000:00000001~\n\r');
  assert.equal(locker.command('ISB#B'), '<B>Ex(BIN):00000000:00000000~\n\r');
  assert.equal(locker.command('LM1#E'), '');
  assert.deepEqual(locker.events.filter(event => event.kind === 'POWER').map(event => event.message), [
    'Power supplies off · 5 locks energised · serial offline', 'Power supplies restored · serial online',
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


test('cabinets on separate COM links can reuse A-E without sharing state', () => {
  let now = 0;
  const first = new Locker(() => now);
  const second = new Locker(() => now);
  for (const cabinet of [first, second]) {
    assert.deepEqual(Object.keys(cabinet.boards), [...'ABCDE']);
    assert.match(cabinet.command('GFV'), /^<C>/);
    assert.equal(cabinet.command('ISB#F'), '');
  }

  first.command('CM!#A');
  first.command('LA0#A');
  assert.equal(first.move('A', 0), true);
  assert.match(first.command('ISB#A'), /00000001~/);
  assert.match(second.command('ISB#A'), /00000000~/);
  now = 3000;
  assert.match(first.tick(), /REMOTE_Lock Done/);
  assert.equal(second.tick(), '');
  assert.ok(!second.events.some(event => event.message.includes('LA0#A')));

  for (const address of 'ABCDE') first.command('LM0#' + address);
  assert.equal(first.powerOn, false);
  assert.equal(second.powerOn, true);
  assert.match(second.command('ISB#A'), /^<A>/);
});

test('fault settings affect only the selected cabinet and door', () => {
  const normal = new Locker();
  const faulty = new Locker();
  faulty.setBoardOffline('AB', true);
  assert.equal(faulty.offlineBoards.size, 0);
  faulty.setBoardOffline('B', true);
  faulty.setBoardOffline('D', true);
  assert.equal(faulty.command('ISB#B'), '');
  assert.match(normal.command('ISB#B'), /^<B>/);
  assert.match(faulty.command('ISB#A'), /^<A>/);
  faulty.setStuckDoor('B', 2);
  faulty.setBoardOffline('B', false);
  assert.equal(faulty.command('ISB#D'), '');
  assert.match(normal.command('ISB#D'), /^<D>/);
  faulty.setBoardOffline('D', false);
  assert.match(faulty.command('ISB#D'), /^<D>/);
  assert.match(faulty.command('ISB#B'), /00000100~/);
  assert.equal(faulty.move('B', 2), false);
  assert.match(normal.command('ISB#B'), /00000000~/);
  faulty.setStuckDoor(null);
  assert.equal(faulty.move('B', 2), true);
  assert.match(faulty.command('ISB#B'), /00000000~/);
});

test('delayed replies remain ordered, and disabling a board drops its queued replies', () => {
  let now = 0;
  const locker = new Locker(() => now);
  locker.setReplyDelay(500);
  assert.equal(locker.command('ISB#A'), '');
  assert.equal(locker.command('ISB#B'), '');
  locker.setBoardOffline('A', true);
  now = 200;
  locker.setReplyDelay(0);
  assert.equal(locker.command('ISB#C'), '');
  now = 499;
  assert.equal(locker.tick(), '');
  now = 500;
  assert.equal(locker.tick(), '<B>Ex(BIN):00000000:00000000~\n\r<C>Ex(BIN):00000000:00000000\n\r');
  assert.equal(locker.tick(), '');
});

test('resetting master C restarts the online boards in only that cabinet', () => {
  let now = 0;
  const locker = new Locker(() => now);
  const otherCabinet = new Locker(() => now);
  locker.command('CM!#A');
  locker.command('DR3#A');
  locker.command('LM0#B');
  assert.equal(locker.move('B', 0), true);
  locker.command('CM)#D');
  locker.setBoardOffline('E', true);
  otherCabinet.command('LM0#A');

  assert.match(locker.command('RST#C'), /^<C>SYSTEM_Reset/);
  assert.match(locker.command('ISB#A'), /^<A>/);
  now = 1800;
  assert.equal(locker.tick(), '');
  for (const board of 'ABCD') assert.equal(locker.command('ISB#' + board), '');
  assert.equal(locker.activeLockCount, 0);
  assert.equal(otherCabinet.activeLockCount, 1);
  assert.match(otherCabinet.command('ISB#A'), /^<A>/);

  now = 4800;
  const startup = locker.tick();
  assert.match(startup, /^<C>Firmware/);
  assert.doesNotMatch(startup, /<[ABDE]>/);
  assert.match(locker.command('ISC#A'), /Responses: OFF/);
  assert.match(locker.command('ISC#A'), /Timer DRx: 05/);
  assert.match(locker.command('ISB#B'), /00000001~/);
  locker.command('LM0#D');
  assert.match(locker.command('LRS#D'), /0000000000000001/);
  assert.equal(locker.command('ISB#E'), '');
  assert.deepEqual(locker.events.filter(event => event.message.endsWith(' restarted')).map(event => event.message),
    ['Board A restarted', 'Board B restarted', 'Board C restarted', 'Board D restarted']);
});

test('an individual board reset leaves the other controllers running', () => {
  let now = 0;
  const locker = new Locker(() => now);
  locker.command('LM0#D');
  assert.match(locker.command('RST#B'), /^<B>REMOTE_Reset/);
  now = 1800;
  locker.tick();
  assert.equal(locker.command('ISB#B'), '');
  assert.match(locker.command('ISB#C'), /^<C>/);
  now = 4800;
  assert.match(locker.tick(), /<B>REMOTE_Reset Done~/);
  assert.match(locker.command('LRS#D'), /0000000000000001/);
});
