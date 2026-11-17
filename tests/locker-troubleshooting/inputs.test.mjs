import test from 'node:test';
import assert from 'node:assert/strict';
import {changedInputs} from '../../locker-troubleshooting/usb-ui.js';

const zero='0000000000000000';
const one='1111111111111111';

test('input 1 is the rightmost bit and input 16 is the leftmost bit', () => {
  assert.deepEqual(changedInputs(zero, '0000000000000001'), [1]);
  assert.deepEqual(changedInputs(zero, '1000000000000000'), [16]);
});

test('reports each changed input once in input-number order across both eight-bit banks', () => {
  assert.deepEqual(changedInputs(zero, '1000000110000101'), [1,3,8,9,16]);
  assert.deepEqual(changedInputs('1000000110000101', '0000000010000100'), [1,9,16]);
});

test('the first read and an invalid baseline do not manufacture sensor changes', () => {
  for(const previous of [undefined,null,'','00000000',zero+'0','000000000000000X',
    '00000000:0000000',Array(16).fill('0'),{length:16}]) {
    assert.deepEqual(changedInputs(previous, one), [], String(previous));
  }
});

test('invalid current reads do not manufacture changes from a valid baseline', () => {
  for(const bits of [undefined,null,'','11111111',one+'1','1111111111111112',
    '11111111:1111111',Array(16).fill('1'),{length:16}]) {
    assert.deepEqual(changedInputs(zero, bits), [], String(bits));
  }
});

test('both electrical transition directions use the same input numbers without assuming open/closed polarity', () => {
  const high='0000000000000001';
  assert.deepEqual(changedInputs(zero, high), [1]);
  assert.deepEqual(changedInputs(high, zero), [1]);
  assert.deepEqual(changedInputs(zero, zero), []);
  assert.deepEqual(changedInputs(one, one), []);
});

test('all-zero and all-one words are valid measurements and a transition lists all 16 inputs', () => {
  const everyInput=Array.from({length:16},(_,i)=>i+1);
  assert.deepEqual(changedInputs(zero, one), everyInput);
  assert.deepEqual(changedInputs(one, zero), everyInput);
});
