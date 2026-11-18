import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyLockClear} from '../locker-lock-clear.js';

const allOff = '0'.repeat(16);

test('a silent LC succeeds when every requested board reports zero outputs', async () => {
  const sent = [];
  await verifyLockClear(async (command, pattern) => {
    sent.push(command);
    if (command === 'LC') {
      assert.equal(pattern, null);
      return '';
    }
    const reply = command === 'LRS#A'
      ? `<A>Lock Word:${allOff}\n\r`
      : `<B>Lock Word:${allOff}~`;
    assert.match(reply, pattern);
    return reply;
  }, ['A', 'B']);
  assert.deepEqual(sent, ['LC', 'LRS#A', 'LRS#B']);
});

test('a board with any output still active blocks the test', async () => {
  await assert.rejects(
    verifyLockClear(async command => command === 'LC' ? '' : '<A>Lock Word:0000000000000001\n\r', ['A']),
    /Board A still reports an active lock output/
  );
});

test('a missing, truncated, unaddressed or wrong-board reply cannot verify lock-off', async () => {
  for (const reply of ['', '<A>Lock Word:0000\r', `Lock Word:${allOff}\r`, `<B>Lock Word:${allOff}\r`]) {
    await assert.rejects(
      verifyLockClear(async (command, pattern) => {
        if (command === 'LC') return '';
        assert.doesNotMatch(reply, pattern);
        throw new Error('No valid response to ' + command);
      }, ['A']),
      /No valid response to LRS#A/
    );
  }
});
