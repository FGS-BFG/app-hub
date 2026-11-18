import test from 'node:test';
import assert from 'node:assert/strict';
import{freshBoardDetection,validateBoardDetection,detectedSelection,detectionHasData,formatBoardDetection}from'../../locker-troubleshooting/board-detection.js';
import{freshSession,validateStep,nextStep,outcome,report,BOARDS}from'../../locker-troubleshooting/flow.js';
import{freshDoorTests,getDoorMaster,getDoorScope,validateDoorTests,doorTestsComplete,doorTestSummary,formatDoorTests}from'../../locker-troubleshooting/door-test.js';
import{createReportRecord,payloadForDrive,hasReportData}from'../../locker-troubleshooting/report-record.js';
import{masterFor,boardsFor}from'../../locker-troubleshooting/layouts.js';
import{draftKey,readRecoverableTests}from'../../locker-troubleshooting/test-storage.js';

const at='2026-11-18T12:00:00.000Z',selectedAt='2026-11-18T12:00:10.000Z',checkedAt='2026-11-18T12:00:11.000Z';
const id='88b03413-7180-41a6-a5a9-e757e39a5420';
const reply=(board='A',extra={})=>({board,status:'responded',bits:'0000000000000000',at,raw:`<${board}>Ex(BIN):00000000:00000000~\r\n`,elapsedMs:23,...extra});
const noReply=(board='C',extra={})=>({board,status:'no-response',at,code:'TIMEOUT',error:'No reply within the timeout.',elapsedMs:1500,...extra});
function detection(board='A',expectedMaster='C'){
  return{attempts:[{at,expectedMaster,results:[{...reply(board),stage:'discovery'},{...noReply(expectedMaster===board?'E':expectedMaster),stage:'discovery'}]}],
    selection:{board,at:selectedAt,expectedMaster},checks:[reply(board,{at:checkedAt,stage:'single-board'})]};
}
function selectedSession(board='A'){
  const s=freshSession();s.mode='usb';s.details.lockerCapacity='80';s.reportId=id;
  s.boardDetection=detection(board);s.doorTests=freshDoorTests([board],null,{scope:'board'});s.step='single-board';
  return s;
}
const roundTrip=value=>JSON.parse(JSON.stringify(value));
function readonlyStorage(entries){const values=new Map(entries);return{get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,
  setItem(){throw Error('Recovery must not write');},removeItem(){throw Error('Recovery must not remove');}};}

test('new detection state is independent, blank and never implies a board choice',()=>{
  const one=freshBoardDetection(),two=freshBoardDetection();
  assert.deepEqual(one,{attempts:[],selection:null,checks:[]});
  assert.equal(detectionHasData(one),false);assert.equal(detectedSelection({boardDetection:one}),null);
  one.attempts.push({at,expectedMaster:'C',results:[]});
  assert.deepEqual(two.attempts,[]);assert.equal(detectionHasData(one),true);
  assert.doesNotThrow(()=>validateBoardDetection(undefined));assert.equal(detectedSelection({}),null);
  assert.equal(detectionHasData(undefined),false);assert.equal(detectionHasData({corrupt:true}),true);
});

test('partial and failed discovery attempts retain their stage, timestamps and raw evidence',()=>{
  const value=freshBoardDetection();
  value.attempts.push({at,expectedMaster:'C',results:[]},{at,expectedMaster:'C',results:[{...noReply(),stage:'discovery'},
    {board:'B',status:'error',at,code:'PROTOCOL',error:'Unexpected reply',raw:'<D>unexpected~\r',stage:'discovery'}]});
  assert.doesNotThrow(()=>validateBoardDetection(value));assert.equal(detectedSelection({boardDetection:value}),null);
  const text=formatBoardDetection(value);
  assert.match(text,/No results captured in this attempt/);assert.match(text,/discovery C .*no-response/);
  assert.ok(text.includes(JSON.stringify('<D>unexpected~\r')));
  assert.match(text,/not proof of a locker master/);
});

test('selection needs a real valid responder from a matching expected-master attempt',()=>{
  const value=detection();assert.equal(detectedSelection({boardDetection:value}),'A');
  for(const mutate of [v=>v.attempts=[],v=>v.selection.board='C',v=>v.selection.expectedMaster='B',
    v=>v.attempts[0].results[0].bits='1111111111111112',v=>v.selection.at='not a date']){
    const bad=roundTrip(value);mutate(bad);assert.throws(()=>validateBoardDetection(bad),TypeError);
    assert.equal(detectedSelection({boardDetection:bad}),null);
  }
});

test('selected-board checks cannot exist before selection or be reused from another board or discovery stage',()=>{
  for(const mutate of [v=>v.selection=null,v=>v.checks[0].board='B',v=>v.checks[0].stage='discovery']){
    const value=detection();mutate(value);assert.throws(()=>validateBoardDetection(value),TypeError);
  }
  const value=detection();delete value.checks[0].stage;
  assert.doesNotThrow(()=>validateBoardDetection(value),'ordinary normalized ISB results need no added stage');
});

test('detection limits reject malformed timestamps, responses, duplicate boards and oversized records',()=>{
  const changes=[
    v=>v.attempts=Array.from({length:21},()=>roundTrip(v.attempts[0])),
    v=>v.attempts[0].results=Array.from({length:6},()=>({...reply(),stage:'discovery'})),
    v=>v.attempts[0].results.push({...reply(),stage:'discovery'}),
    v=>v.checks=Array.from({length:101},()=>reply()),v=>v.attempts=Array(1),
    v=>v.attempts[0].at='2026-11-18T12:00:00Z',v=>v.attempts[0].expectedMaster='F',
    v=>v.checks[0].raw='x'.repeat(1025),v=>v.checks[0].elapsedMs=-1,
    v=>v.checks[0].bits='0'.repeat(15),v=>v.checks[0].error='contradictory success error',
    v=>v.attempts[0].results[1].error='x'.repeat(1001),v=>v.attempts[0].results[1].code='x'.repeat(81),
    v=>v.attempts[0].results[1].bits='0'.repeat(16),v=>v.attempts[0].results[0].stage='initial',
  ];
  for(const change of changes){const value=detection();change(value);assert.throws(()=>validateBoardDetection(value),TypeError);}
});

test('a selected detected board never changes the configured locker master or layout',()=>{
  const s=selectedSession(),before=roundTrip(s);
  assert.equal(detectedSelection(s),'A');assert.equal(masterFor(s),'C');assert.deepEqual(boardsFor(s),BOARDS);
  assert.deepEqual(s,before);
  s.details.lockerCapacity='32';s.boardDetection=detection('D','B');s.doorTests=freshDoorTests(['D'],null,{scope:'board'});
  assert.equal(detectedSelection(s),'D');assert.equal(masterFor(s),'B');assert.deepEqual(boardsFor(s),['A','B']);
  assert.equal(getDoorMaster(s.doorTests),null);
});

test('single-board outcome uses the latest selected check rather than old full-locker results or expected-master errors',()=>{
  const s=selectedSession();s.initial=Object.fromEntries(BOARDS.map(board=>[board,'responded']));s.recheck={...s.initial};
  s.checkErrors={C:'Expected master did not respond'};s.connection='unavailable';
  assert.equal(outcome(s).title,'Board A responded (single-board check)');
  assert.match(outcome(s).summary,/board A only/);assert.match(outcome(s).next,/not door functionality/);
  s.boardDetection.checks.push(noReply('A',{at:checkedAt}));
  assert.equal(outcome(s).kind,'unresolved');assert.match(outcome(s).title,/Board A did not respond/);
  s.boardDetection.checks.push({board:'A',status:'error',at:checkedAt,code:'PROTOCOL',error:'Incomplete frame'});
  assert.match(outcome(s).title,/Board A check is incomplete/);
  assert.doesNotMatch(JSON.stringify(outcome(s)),/All five boards responded|Master C still needs/);
});

test('single-board navigation requires an actual post-selection check attempt, including failed attempts',()=>{
  const s=selectedSession();s.boardDetection.checks=[];
  assert.equal(validateStep(s),false);assert.equal(nextStep(s),null);
  for(const row of [reply(),noReply('A'),{board:'A',status:'error',at,code:'DISCONNECTED',error:'USB disconnected'}]){
    s.boardDetection.checks=[row];assert.equal(validateStep(s),true);assert.equal(nextStep(s),'doors');
  }
  s.step='initial';s.initial={A:'responded'};assert.equal(validateStep(s),false,'normal initial flow remains full-layout scoped');
});

test('a board-only door record requires explicit scope and one target without assigning that board as a master',()=>{
  const value=freshDoorTests(['A'],null,{scope:'board'});
  assert.equal(getDoorScope(value),'board');assert.equal(getDoorMaster(value),null);assert.doesNotThrow(()=>validateDoorTests(value));
  assert.throws(()=>freshDoorTests(['A'],null),TypeError);
  assert.throws(()=>freshDoorTests(['A','B'],null,{scope:'board'}),TypeError);
  assert.throws(()=>freshDoorTests(['A'],'A',{scope:'board'}),TypeError);
  assert.throws(()=>freshDoorTests(['A'],null,{scope:'unknown'}),TypeError);
  Object.assign(value.banks.A,{status:'skipped',skipReason:'No safe door test could be completed.',completedAt:checkedAt});
  assert.equal(doorTestsComplete(value,['A'],null),true);assert.equal(doorTestsComplete(value,BOARDS,'C'),false);
  const summary=doorTestSummary(value,['A'],null);assert.equal(summary.scope,'board');assert.equal(summary.master,null);assert.equal(summary.complete,true);
  const text=formatDoorTests(value,['A'],null);assert.match(text,/None assigned in this board-only scope/);
  assert.doesNotMatch(text,/Recorded master: A|BANK [B-E]:/);
});

test('limited door completion rejects other targets and retains normal locker validation',()=>{
  const s=selectedSession();s.step='doors';assert.equal(nextStep(s),null);
  Object.assign(s.doorTests.banks.A,{status:'skipped',skipReason:'Could not test the selected door.',completedAt:checkedAt});
  assert.equal(nextStep(s),'result');
  s.doorTests=freshDoorTests(['B'],null,{scope:'board'});
  Object.assign(s.doorTests.banks.B,{status:'skipped',skipReason:'Wrong target.',completedAt:checkedAt});
  assert.equal(nextStep(s),null);
  assert.throws(()=>freshDoorTests(['A','B'],'C'),TypeError);
  const locker=freshDoorTests();assert.equal(Object.hasOwn(locker,'scope'),false);assert.equal(getDoorMaster(locker),'C');
});

test('limited reports show detection and selected evidence without normal reset, recheck or swap blocks',()=>{
  const s=selectedSession(),before=roundTrip(s),text=report(s,{savedAt:checkedAt});
  assert.match(text,/Board A responded \(single-board check\)/);
  assert.match(text,/Configured layout master \(context only\): C/);
  assert.match(text,/Explicit operator choice: Test detected board A only/);
  assert.match(text,/No RST was performed on the limited single-board path/);
  assert.match(text,/No locker-master role is assigned to this board/);
  assert.match(text,/Port closed; completed checks remain historical observations/);
  assert.doesNotMatch(outcome(s).summary,/currently connected|port is open|is connected/);
  assert.match(text,/BOARD DETECTION/);assert.match(text,/discovery A .*0000000000000000/);
  assert.match(text,/SELECTED-BOARD ISB CHECKS/);assert.match(text,/single-board A .*23 ms/);
  assert.ok(text.includes(JSON.stringify(s.boardDetection.attempts[0].results[0].raw)));
  assert.doesNotMatch(text,/INITIAL ISB CHECK|ISB CHECK AFTER|CONNECTION COMPARISON|All five boards responded|Master C still needs/);
  assert.doesNotMatch(text.split('ONE DOOR PER COLUMN')[1],/BANK [B-E]:/);
  assert.deepEqual(s,before);
});

test('discovery without an explicit selection stays in the normal report and cannot become a selected-board result',()=>{
  const s=selectedSession();s.boardDetection.selection=null;s.boardDetection.checks=[];s.doorTests=freshDoorTests();
  const text=report(s);
  assert.match(text,/BOARD DETECTION/);assert.match(text,/Explicit limited selection: None recorded/);
  assert.match(text,/INITIAL ISB CHECK/);assert.doesNotMatch(text,/SINGLE-BOARD TEST SCOPE/);
  s.boardDetection.selection={board:'C',at:selectedAt,expectedMaster:'C'};
  assert.equal(outcome(s).kind,'unresolved');assert.match(outcome(s).title,/evidence needs review/);
});

test('freezing preserves detection replies, selected checks and limited door scope for exact retries',()=>{
  const s=selectedSession();Object.assign(s.doorTests.banks.A,{status:'skipped',skipReason:'No operator-confirmed opening.',completedAt:checkedAt});
  const record=createReportRecord(s,{id,savedAt:checkedAt}),text=record.reportText;
  assert.equal(Object.isFrozen(record.session.boardDetection.attempts[0].results[0]),true);
  s.boardDetection.attempts[0].results[0].raw='Changed live raw';s.boardDetection.checks[0].bits='1'.repeat(16);
  s.doorTests.banks.A.skipReason='Changed live skip';
  const restored=roundTrip(record),payload=payloadForDrive(restored);
  assert.equal(payload.reportText,text);assert.equal(payload.id,id);assert.equal(payload.savedAt,checkedAt);
  assert.notEqual(restored.session.boardDetection.attempts[0].results[0].raw,'Changed live raw');
  assert.equal(restored.session.doorTests.scope,'board');assert.equal(restored.session.doorTests.master,null);
});

test('malformed detection or an unproved board-scoped door record cannot be frozen or retried',()=>{
  const s=selectedSession(),record=roundTrip(createReportRecord(s,{id,savedAt:checkedAt}));
  for(const mutate of [value=>value.boardDetection.selection.board='B',value=>value.boardDetection.checks[0].bits='bad',
    value=>value.boardDetection=undefined,value=>value.doorTests=freshDoorTests(['B'],null,{scope:'board'})]){
    const bad=roundTrip(s);mutate(bad);assert.throws(()=>createReportRecord(bad,{id,savedAt:checkedAt}),TypeError);
    const restored=roundTrip(record);mutate(restored.session);assert.throws(()=>payloadForDrive(restored),TypeError);
  }
});

test('detection-only evidence counts as data while legacy frozen reports remain valid without the new section',()=>{
  assert.equal(hasReportData(freshSession()),false);
  const s=freshSession();s.boardDetection.attempts.push({at,expectedMaster:'C',results:[]});assert.equal(hasReportData(s),true);
  const old=freshSession();delete old.boardDetection;
  const record=roundTrip(createReportRecord(old,{id,savedAt:checkedAt}));record.reportText='Original frozen locker report from before discovery.';
  assert.equal(payloadForDrive(record).reportText,record.reportText);
  assert.equal(Object.hasOwn(record.session,'boardDetection'),false);
});

test('single-board drafts remain recoverable and malformed detection is flagged without changing raw storage',()=>{
  const s=selectedSession(),raw=' \n'+JSON.stringify(s,null,2)+'\n ',key=draftKey(id),storage=readonlyStorage([[key,raw]]);
  const found=readRecoverableTests(storage);
  assert.equal(found.unreadable,false);assert.equal(found.entries.length,1);assert.equal(found.entries[0].draft.step,'single-board');
  assert.equal(found.entries[0].draft.boardDetection.selection.board,'A');assert.equal(storage.getItem(key),raw);
  const corrupt=roundTrip(s);corrupt.boardDetection.selection.board='E';
  const badRaw=JSON.stringify(corrupt),badStorage=readonlyStorage([[key,badRaw]]),bad=readRecoverableTests(badStorage);
  assert.equal(bad.unreadable,true);assert.deepEqual(bad.entries,[]);assert.equal(badStorage.getItem(key),badRaw);
});
