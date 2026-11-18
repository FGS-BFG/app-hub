import test from 'node:test';
import assert from 'node:assert/strict';
import{ALL_BOARDS,LAYOUTS,layoutForCapacity,boardsFor,masterFor}from'../../locker-troubleshooting/layouts.js';

test('confirmed 80-bay layout keeps A–E, master C and only the physical slave pairs',()=>{
  assert.deepEqual(ALL_BOARDS,['A','B','C','D','E']);
  const layout=layoutForCapacity('80');assert.equal(layout,LAYOUTS['80']);
  assert.deepEqual(layout.boards,ALL_BOARDS);assert.deepEqual(layout.doorBanks,ALL_BOARDS);
  assert.equal(layout.master,'C');assert.deepEqual(layout.adjacentSlavePairs,[['A','B'],['D','E']]);
});

test('confirmed 32-bay layout contains A and master B with no interchangeable slave neighbour',()=>{
  const layout=layoutForCapacity('32');
  assert.deepEqual(layout.boards,['A','B']);assert.deepEqual(layout.doorBanks,['A','B']);
  assert.equal(layout.master,'B');assert.deepEqual(layout.adjacentSlavePairs,[]);
  assert.deepEqual(boardsFor({details:{lockerCapacity:'32'}}),['A','B']);
  assert.equal(masterFor('32'),'B');assert.equal(masterFor({details:{lockerCapacity:'32'}}),'B');
});

test('confirmed 64-bay layout contains A–D, master C and only the A/B slave pair',()=>{
  const layout=layoutForCapacity('64');
  assert.deepEqual(layout.boards,['A','B','C','D']);assert.deepEqual(layout.doorBanks,['A','B','C','D']);
  assert.equal(layout.master,'C');assert.deepEqual(layout.adjacentSlavePairs,[['A','B']]);
  assert.deepEqual(boardsFor('64'),['A','B','C','D']);
});

test('layout records and their nested lists are immutable',()=>{
  assert.equal(Object.isFrozen(ALL_BOARDS),true);assert.equal(Object.isFrozen(LAYOUTS),true);
  for(const layout of Object.values(LAYOUTS)){
    assert.equal(Object.isFrozen(layout),true);assert.equal(Object.isFrozen(layout.boards),true);
    assert.equal(Object.isFrozen(layout.doorBanks),true);assert.equal(Object.isFrozen(layout.adjacentSlavePairs),true);
    for(const pair of layout.adjacentSlavePairs)assert.equal(Object.isFrozen(pair),true);
  }
  assert.throws(()=>LAYOUTS['32'].boards.push('A'),TypeError);
});

test('unconfirmed and invalid explicit capacities never receive a guessed layout',()=>{
  for(const capacity of ['48','80 bays',80,null,[]]){
    assert.equal(layoutForCapacity(capacity),null);
    assert.equal(masterFor(capacity),null);
    assert.deepEqual(boardsFor(capacity),[]);
    assert.deepEqual(boardsFor({details:{lockerCapacity:capacity}}),[]);
  }
});

test('only blank or missing legacy capacity retains the historical A–E interpretation',()=>{
  assert.equal(layoutForCapacity(''),null,'an empty value is not a newly confirmed map');
  for(const value of [undefined,'',{}, {details:{}},{details:{lockerCapacity:''}}]){assert.deepEqual(boardsFor(value),ALL_BOARDS);assert.equal(masterFor(value),'C');}
  assert.equal(masterFor('80'),'C');assert.equal(masterFor('64'),'C');
});
