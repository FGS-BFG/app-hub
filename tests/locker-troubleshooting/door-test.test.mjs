import test from 'node:test';
import assert from 'node:assert/strict';
import{freshDoorTests,freshBankDoorTest,getDoorTargets,getDoorMaster,validateDoorTests,doorTestsComplete,changedDoorInputs,doorTestSummary,formatDoorTests,hasDoorTestData}from'../../locker-troubleshooting/door-test.js';

const banks=['A','B','C','D','E'];
const at='2026-11-18T11:00:00.000Z',end='2026-11-18T11:00:20.000Z';
const bits=(...inputs)=>Array.from({length:16},(_,index)=>inputs.includes(16-index)?'1':'0').join('');
const sample=(board,inputs=[],extra={})=>({board,status:'responded',bits:bits(...inputs),at,elapsedMs:23,...extra});
function skipped(){const value=freshDoorTests();for(const bank of banks)Object.assign(value.banks[bank],{status:'skipped',skipReason:'USB unavailable; no door command attempted.',completedAt:end});return value;}
function attempted(){const value=skipped();value.setup.connections='original';value.banks.A={...freshBankDoorTest(),status:'tested',door:9,startedAt:at,completedAt:end,command:{open:{status:'sent',at,raw:'LM9#A\r'},lockOff:{status:'sent',at:end}},operator:{opened:'yes',closed:'yes'}};return value;}

test('new door tests contain five independent blank attempts and no assumed commands or observations',()=>{
  const one=freshDoorTests(),two=freshDoorTests();
  assert.equal(one.version,1);assert.deepEqual(one.setup,{connections:'not-confirmed',note:''});
  assert.deepEqual(Object.keys(one.banks),banks);assert.doesNotThrow(()=>validateDoorTests(one));
  for(const bank of banks){assert.deepEqual(one.banks[bank],freshBankDoorTest());assert.equal(one.banks[bank].door,null);}
  one.banks.A.snapshots.closed.A=sample('A');one.banks.A.samples.push({...sample('A'),phase:'open'});
  assert.deepEqual(two.banks.A.snapshots.closed,{});assert.deepEqual(one.banks.B.samples,[]);
  assert.equal(doorTestsComplete(two),false);assert.equal(hasDoorTestData(two),false);
});

test('an older missing door section remains valid evidence but cannot complete the new door stage',()=>{
  assert.equal(validateDoorTests(undefined),undefined);
  assert.equal(doorTestsComplete(undefined),false);
  assert.throws(()=>validateDoorTests(undefined,{allowMissing:false}),TypeError);
  assert.match(formatDoorTests(undefined),/Not recorded in this older session/);
  assert.match(formatDoorTests(undefined),/No door operation is inferred/);
});

test('each bank requires either a recorded attempt or an explicit dated skip reason',()=>{
  const value=skipped();assert.equal(doorTestsComplete(value),true);
  assert.equal(doorTestSummary(value).skipped,5);assert.equal(doorTestSummary(value).tested,0);
  for(const bank of banks)assert.deepEqual(doorTestSummary(value).banks[bank].commandIssues,[],'an unattempted skip is not a command failure');
  value.banks.E.status='pending';assert.equal(doorTestsComplete(value),false);
  value.banks.E.status='skipped';value.banks.E.skipReason=' ';
  assert.throws(()=>validateDoorTests(value),/skip/);assert.equal(doorTestsComplete(value),false);
  value.banks.E.skipReason='Could not connect';value.banks.E.completedAt='';
  assert.throws(()=>validateDoorTests(value),/skip/);
});

test('tested means an attempted command and explicit operator answers, including negative or uncertain observations',()=>{
  const value=attempted();value.banks.A.command.open={status:'error',at,code:'WRITE',error:'Transmission failed; execution unknown.'};
  value.banks.A.operator={opened:'no',closed:'uncertain'};
  assert.equal(doorTestsComplete(value),true);
  const finding=doorTestSummary(value);
  assert.equal(finding.tested,1);assert.equal(finding.banks.A.operatorOpened,'no');
  assert.equal(finding.banks.A.operatorClosed,'uncertain');
  assert.match(finding.banks.A.commandIssues.join('\n'),/Open command: error WRITE/);
  assert.equal(Object.hasOwn(finding,'passed'),false);assert.equal(Object.hasOwn(finding.banks.A,'passed'),false);
  assert.match(formatDoorTests(value),/not a door-function pass/);
});

test('an attempted command alone, or input words alone, cannot mark a bank tested',()=>{
  for(const change of [entry=>entry.operator.closed='',entry=>entry.operator.opened='',entry=>entry.command.open=null,
    entry=>entry.startedAt='',entry=>entry.completedAt='',entry=>entry.door=null]){
    const value=attempted();change(value.banks.A);
    value.banks.A.snapshots.open.A=sample('A',banks.map((_,i)=>i+1));
    assert.throws(()=>validateDoorTests(value),/tested status/);assert.equal(doorTestsComplete(value),false);
  }
});

test('routine test reports allow unconfirmed setup and changed connections require a note',()=>{
  const value=attempted();value.setup.connections='not-confirmed';
  assert.doesNotThrow(()=>validateDoorTests(value));
  assert.equal(doorTestsComplete(value),true);
  value.setup.connections='changed';assert.throws(()=>validateDoorTests(value),/setup note/);
  value.setup.note='Connections still swapped between A and B.';
  assert.equal(doorTestsComplete(value),true);
  const pending=freshDoorTests();pending.setup.connections='changed';
  assert.doesNotThrow(()=>validateDoorTests(pending),'an incomplete draft can still be retained');
  assert.equal(doorTestsComplete(skipped()),true);
});

test('lock-off errors and missing lock-off evidence stay prominent without pretending the physical door closed',()=>{
  const value=attempted();value.banks.A.operator.closed='no';
  value.banks.A.command.lockOff={status:'error',at:end,code:'DISCONNECTED',error:'USB disconnected before lock-off.'};
  assert.equal(doorTestsComplete(value),true);
  const text=formatDoorTests(value);
  assert.match(text,/Lock-off command: error at .*DISCONNECTED/);
  assert.match(text,/Operator observed physically closed: no/);
  assert.match(text,/Lock-off is not a claim that the door physically closed/);
  value.banks.A.command.lockOff=null;
  assert.match(doorTestSummary(value).banks.A.commandIssues.join('\n'),/Lock-off command not recorded/);
});

test('raw input numbering and transition comparison do not assume sensor polarity or a door map',()=>{
  assert.deepEqual(changedDoorInputs(bits(),bits(1,8,9,16)),[1,8,9,16]);
  assert.deepEqual(changedDoorInputs(bits(1,16),bits()),[1,16]);
  assert.deepEqual(changedDoorInputs('0'.repeat(16),'1'.repeat(16)),Array.from({length:16},(_,i)=>i+1));
  for(const value of [undefined,'',bits()+'0','x'.repeat(16),Array(16).fill('0')])assert.deepEqual(changedDoorInputs(value,bits(1)),[]);
});

test('transient polling changes are retained even when final snapshots return to baseline',()=>{
  const value=attempted(),entry=value.banks.A;
  entry.snapshots.baseline={A:sample('A'),B:sample('B')};
  entry.snapshots.open={A:sample('A'),B:sample('B')};entry.snapshots.closed={A:sample('A')};
  entry.samples=[{phase:'open',...sample('A',[1])},{phase:'open',...sample('A')},
    {phase:'open',...sample('B',[9])},{phase:'closed',...sample('A',[16])},{phase:'closed',...sample('A')}];
  const finding=doorTestSummary(value).banks.A;
  assert.deepEqual(finding.changes.A,[1,16]);assert.deepEqual(finding.changes.B,[9]);
  assert.deepEqual(finding.changes.C,[]);
  assert.match(formatDoorTests(value),/union of snapshots and polling samples/);
});

test('a missing or failed baseline cannot produce inferred input changes',()=>{
  const value=attempted(),entry=value.banks.A;
  entry.snapshots.baseline.A={board:'A',status:'no-response',at,code:'TIMEOUT'};
  entry.snapshots.open.A=sample('A',[1,2,3]);
  entry.samples=[{phase:'open',...sample('D',[16])}];
  const finding=doorTestSummary(value).banks.A;
  assert.deepEqual(finding.changes.A,[]);assert.deepEqual(finding.changes.D,[]);
  assert.deepEqual(finding.baselineMissing,['A','D']);
  assert.match(formatDoorTests(value),/No valid baseline for observed bank\(s\): A, D/);
});

test('malformed versions, door addresses, samples and oversized evidence are rejected',()=>{
  const changes=[
    value=>value.version=2,value=>value.banks.F=freshBankDoorTest(),value=>value.banks.A.door=0,
    value=>value.banks.A.door=17,value=>value.banks.A.operator.opened='passed',
    value=>value.banks.A.completedAt='2026-11-18T10:59:59.000Z',
    value=>value.banks.A.snapshots.baseline.A=sample('B'),
    value=>value.banks.A.snapshots.open.A=sample('A',[],{bits:'1'.repeat(17)}),
    value=>value.banks.A.snapshots.open.A={board:'A',status:'no-response',bits:bits(),at},
    value=>value.banks.A.samples=[{phase:'baseline',...sample('A')}],
    value=>value.banks.A.samples=[{phase:'open',...sample('A',[],{at:'not a date'})}],
    value=>value.banks.A.samples=[{phase:'open',...sample('A',[],{elapsedMs:-1})}],
    value=>value.banks.A.samples=Array.from({length:201},()=>({phase:'open',...sample('A')})),
    value=>value.banks.A.samples=Array(1),value=>value.banks.A.command.open.raw='x'.repeat(4097),
    value=>value.setup.note='x'.repeat(1001),value=>value.banks.B.skipReason='x'.repeat(1001),
  ];
  for(const change of changes){const value=attempted();change(value);assert.throws(()=>validateDoorTests(value),TypeError);assert.equal(doorTestsComplete(value),false);}
});

test('formatting retains independent raw evidence and does not mutate an attempt',()=>{
  const value=attempted(),entry=value.banks.A;
  entry.snapshots.baseline.A=sample('A',[],{raw:'<A>Ex(BIN):00000000:00000000~\r\n'});
  entry.samples=[{phase:'open',...sample('A',[1])}];
  const before=structuredClone(value),text=formatDoorTests(value);
  assert.match(text,/selected door 9/);assert.match(text,/LM9#A\\r/);
  assert.ok(text.includes(JSON.stringify(entry.snapshots.baseline.A.raw)));
  assert.match(text,/open A .*\(BIN\) 0000000000000001 23 ms/);
  assert.match(text,/A: 1/);assert.deepEqual(value,before);
});

test('door selections, setup notes and captured evidence are meaningful while initialized containers are blank',()=>{
  assert.equal(hasDoorTestData(freshDoorTests()),false);
  for(const change of [value=>value.banks.C.door=4,value=>value.setup.note='Could not inspect the hub.',
    value=>value.banks.E.snapshots.baseline.E=sample('E'),value=>value.banks.A.skipReason='Not attempted']){
    const value=freshDoorTests();change(value);assert.equal(hasDoorTestData(value),true);
  }
  assert.equal(hasDoorTestData({version:99}),true,'malformed evidence is never silently treated as an empty draft');
});

test('two-column tests retain independent blank inactive banks and copy their stored target list',()=>{
  const targets=['B','C'],value=freshDoorTests(targets);
  targets.push('A');
  assert.deepEqual(getDoorTargets(value),['B','C']);
  assert.deepEqual(Object.keys(value.banks),banks);
  for(const bank of ['A','D','E'])assert.deepEqual(value.banks[bank],freshBankDoorTest());
  const returned=getDoorTargets(value);returned.push('E');
  assert.deepEqual(value.targets,['B','C']);
  assert.doesNotThrow(()=>validateDoorTests(value,{expectedTargets:['C','B']}));
  assert.equal(hasDoorTestData(value),false);
  assert.equal(doorTestsComplete(value,['B','C']),false);
});

test('32-bay completion and reports require A/B and their explicitly stored master B',()=>{
  const value=freshDoorTests(['A','B'],'B');
  for(const bank of ['A','B'])Object.assign(value.banks[bank],{status:'skipped',skipReason:'No USB connection.',completedAt:end});
  assert.equal(doorTestsComplete(value),true);
  assert.equal(doorTestsComplete(value,['A','B'],'B'),true);
  assert.equal(doorTestsComplete(value,['A','B'],'A'),false);
  assert.equal(doorTestsComplete(value,banks),false);
  assert.equal(doorTestsComplete(value,[]),false);
  const summary=doorTestSummary(value,['A','B'],'B');
  assert.equal(summary.complete,true);assert.equal(summary.skipped,2);assert.equal(summary.tested,0);assert.equal(summary.pending,0);
  assert.deepEqual(summary.targets,['A','B']);assert.deepEqual(Object.keys(summary.banks),['A','B']);
  assert.equal(summary.master,'B');assert.equal(summary.masterMatches,true);
  assert.deepEqual(Object.keys(summary.banks.B.changes),['A','B']);
  const text=formatDoorTests(value,['A','B'],'B');
  assert.match(text,/Recorded columns: A, B\./);assert.match(text,/Recorded master: B\./);assert.match(text,/0 tested; 2 skipped; 0 pending/);
  assert.match(text,/BANK A:/);assert.match(text,/BANK B:/);
  assert.doesNotMatch(text,/BANK [CDE]:|^  [CDE]:/m);
});

test('an explicit empty target list is an unconfirmed layout and never a completed zero-column test',()=>{
  const value=freshDoorTests([],null);
  assert.doesNotThrow(()=>validateDoorTests(value,{expectedTargets:[]}));
  assert.deepEqual(getDoorTargets(value),[]);assert.equal(hasDoorTestData(value),false);
  assert.equal(getDoorMaster(value),null);
  assert.equal(doorTestsComplete(value),false);assert.equal(doorTestsComplete(value,[]),false);
  const summary=doorTestSummary(value,[]);
  assert.equal(summary.complete,false);assert.equal(summary.layoutConfirmed,false);
  assert.equal(summary.tested,0);assert.equal(summary.skipped,0);assert.equal(summary.pending,0);assert.deepEqual(summary.banks,{});
  const text=formatDoorTests(value,[]);
  assert.match(text,/Layout unconfirmed\. No columns are assigned; door tests are incomplete/);
  assert.doesNotMatch(text,/BANK [A-E]:|Recorded attempts:/);
  Object.assign(value.banks.C,{status:'skipped',skipReason:'No layout.',completedAt:end});
  assert.throws(()=>validateDoorTests(value),/inactive/);
});

test('malformed, duplicate and master-less target lists are rejected without silently discarding evidence',()=>{
  const withProperty=['B','C'];withProperty.extra='A';
  const sparse=['B','C',,];sparse.extra='A';
  for(const targets of [null,'BC',['F','C'],['B','C','C'],['b','C'],withProperty,sparse]){
    assert.throws(()=>freshDoorTests(targets),TypeError);
    const value=freshDoorTests();value.targets=targets;
    assert.throws(()=>validateDoorTests(value),TypeError);assert.throws(()=>getDoorTargets(value),TypeError);
    assert.equal(doorTestsComplete(value),false);assert.equal(hasDoorTestData(value),true);
  }
  const value=freshDoorTests();value.targets=undefined;
  assert.throws(()=>validateDoorTests(value),TypeError);
  assert.throws(()=>validateDoorTests(freshDoorTests(['B','C']),{expectedTargets:['B']}),TypeError);
  for(const targets of [['B'],['A','B']]){
    assert.throws(()=>freshDoorTests(targets),/master/,'a new B master is not inferred from the column letters');
    const value=freshDoorTests();value.targets=targets;
    assert.throws(()=>getDoorMaster(value),/master/);assert.throws(()=>validateDoorTests(value),/master/);
  }
});

test('stored master must be known and included, while missing legacy master remains C',()=>{
  assert.equal(getDoorMaster(undefined),'C');
  const legacy=freshDoorTests(['B','C']);delete legacy.master;
  assert.equal(getDoorMaster(legacy),'C');assert.doesNotThrow(()=>validateDoorTests(legacy));
  for(const master of [null,undefined,'Z','c','D',0]){
    const value=freshDoorTests(['A','B'],'B');value.master=master;
    assert.throws(()=>validateDoorTests(value),/master/);assert.equal(doorTestsComplete(value,['A','B'],'B'),false);
  }
  for(const bank of ['B','C'])Object.assign(legacy.banks[bank],{status:'skipped',skipReason:'Earlier guide record.',completedAt:end});
  assert.equal(doorTestsComplete(legacy),true);assert.equal(doorTestsComplete(legacy,['A','B'],'B'),false);
  const text=formatDoorTests(legacy,['A','B'],'B');
  assert.match(text,/Recorded columns: B, C\./);assert.match(text,/Recorded master: C\./);
  assert.match(text,/Recorded door-test master differs/);assert.match(text,/Historical evidence is retained/);
  assert.match(text,/BANK C:/);
});

test('inactive columns cannot contain attempts or observations, including cross-column samples',()=>{
  for(const mutate of [
    value=>value.banks.A.door=1,
    value=>value.banks.D.skipReason='Evidence must not be hidden.',
    value=>value.banks.E.command.open={status:'sent',at},
    value=>value.banks.B.snapshots.baseline.A=sample('A'),
    value=>value.banks.C.samples=[{phase:'open',...sample('D')}],
  ]){
    const value=freshDoorTests(['B','C']);mutate(value);
    assert.throws(()=>validateDoorTests(value),TypeError);assert.equal(hasDoorTestData(value),true);
  }
  const value=freshDoorTests(['B','C']);
  value.banks.B.snapshots.baseline={B:sample('B'),C:sample('C')};
  value.banks.B.samples=[{phase:'open',...sample('C',[9])}];
  assert.doesNotThrow(()=>validateDoorTests(value));
  assert.deepEqual(doorTestSummary(value).banks.B.changes.C,[9]);
});

test('legacy missing targets retain historical five-column evidence when the current layout differs',()=>{
  const value=skipped();delete value.targets;delete value.master;
  const before=JSON.stringify(value);
  assert.deepEqual(getDoorTargets(value),banks);assert.equal(doorTestsComplete(value),true);
  assert.equal(doorTestsComplete(value,['A','B'],'B'),false);
  assert.throws(()=>validateDoorTests(value,{expectedTargets:['A','B'],expectedMaster:'B'}),/match/);
  const text=formatDoorTests(value,['A','B'],'B');
  assert.match(text,/Historical evidence is retained/);
  for(const bank of banks)assert.ok(text.includes('BANK '+bank+':'));
  assert.equal(JSON.stringify(value),before);
});
