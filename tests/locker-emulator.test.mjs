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

test('cabinet presets add independent 80-bay groups on the existing serial bus', () => {
  const groups = ['ABCDE', 'FGHIJ', 'KLMNO', 'PQRST'];
  for (let count = 1; count <= 4; count++) {
    const locker = new Locker(undefined, undefined, count);
    assert.deepEqual(locker.cabinets, groups.slice(0, count));
    assert.equal(Object.keys(locker.boards).length, 5 * count);
    assert.match(locker.events[0].message, new RegExp('All ' + 80 * count + ' doors'));
    assert.match(locker.command('ISB'), /^<C>/);
    assert.equal(locker.command('ISB#Z'), '');
  }
  const locker = new Locker(undefined, undefined, 4);
  locker.command('LM0#T');
  assert.equal(locker.move('T', 0), true);
  assert.match(locker.command('ISB#T'), /00000001~/);
  assert.match(locker.command('ISB#A'), /00000000~/);
  for (const address of 'ABCD') locker.command('LM0#' + address);
  assert.equal(locker.powerOn, false);
  locker.restorePower();
  assert.equal(locker.activeLockCount, 0);
  assert.match(locker.command('ISB#T'), /00000001~/);
  assert.deepEqual(new Locker(undefined, undefined, 0).cabinets, ['ABCDE']);
});

test('cabinet monitors receive their own serial traffic and shared bus events', () => {
  let now = 0;
  const locker = new Locker(() => now, 'C', 4);
  const [first, second, third, fourth] = locker.cabinetEvents;
  locker.command('ISB');
  locker.command('CM!#T');
  locker.command('LA0#T');
  locker.move('T', 0);
  now = 3000;
  locker.tick();
  assert.deepEqual(first.map(event => event.kind), ['SYSTEM', 'TX', 'RX']);
  assert.deepEqual(second.map(event => event.kind), ['SYSTEM']);
  assert.deepEqual(third.map(event => event.kind), ['SYSTEM']);
  assert.ok(fourth.some(event => event.kind === 'TX' && event.message.includes('LA0#T')));
  assert.ok(fourth.some(event => event.kind === 'DOOR'));
  assert.ok(fourth.some(event => event.kind === 'RX' && event.message.includes('REMOTE_Lock Done')));
  locker.command('LC');
  for (const feed of locker.cabinetEvents) {
    assert.ok(feed.some(event => event.kind === 'TX' && event.message.startsWith('LC')));
  }
  const fourthCount = fourth.length;
  for (let index = 0; index < 180; index++) locker.command('ISB#A');
  assert.equal(first.length, 180);
  assert.equal(fourth.length, fourthCount);
});
