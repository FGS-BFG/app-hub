import test from 'node:test';
import assert from 'node:assert/strict';
import {freshBeforeRestart,validateBeforeRestart,beforeRestartComplete} from '../../locker-troubleshooting/before-restart.js?v=20261118-before-restart';
import {freshSession,outcome} from '../../locker-troubleshooting/flow.js?v=20261118-before-restart';
import {createReportRecord,payloadForDrive,hasReportData} from '../../locker-troubleshooting/report-record.js?v=20261118-before-restart';
import {draftKey,pendingKey,readRecoverableTests} from '../../locker-troubleshooting/test-storage.js?v=20261118-before-restart';

const id='361af840-d85e-4695-8f91-c404bd6e8986';
const second='87441bfd-3d97-46dd-a469-44d5602998d4';
const at='2026-11-18T09:00:00.000Z';
const savedAt='2026-11-18T09:05:00.000Z';
const all=['A','B','C','D','E'];
const json=value=>JSON.stringify(value);
const roundTrip=value=>JSON.parse(json(value));
const answer=(communication='some',unresponsiveBoards=['A'])=>({communication,unresponsiveBoards,notes:'Observed before restarting the PC.',recordedAt:at});
function session(){return{...freshSession(),reportId:id,started:at};}
class Storage{
  constructor(items){this.items=new Map(Object.entries(items));this.writes=0;this.removals=0;}
  get length(){return this.items.size;}
  key(index){return[...this.items.keys()][index]??null;}
  getItem(key){return this.items.get(key)??null;}
  setItem(key,value){this.writes++;this.items.set(key,String(value));}
  removeItem(key){this.removals++;this.items.delete(key);}
}
function unchanged(storage,before){assert.deepEqual([...storage.items],before);assert.equal(storage.writes,0);assert.equal(storage.removals,0);}

test('fresh observations have independent empty fields and older missing observations remain compatible',()=>{
  const first=freshBeforeRestart(),second=freshBeforeRestart();
  assert.deepEqual(first,{communication:'',unresponsiveBoards:[],notes:'',recordedAt:''});
  first.unresponsiveBoards.push('A');assert.deepEqual(second.unresponsiveBoards,[]);
  assert.equal(validateBeforeRestart(second),second);assert.equal(validateBeforeRestart(undefined),undefined);
  assert.throws(()=>validateBeforeRestart(undefined,{allowMissing:false}),TypeError);
  assert.equal(beforeRestartComplete(undefined,all),false);assert.equal(beforeRestartComplete(second,all),false);
});

test('communication answers require the appropriate active-board selection without inventing a master map',()=>{
  for(const communication of ['all','none','unsure']){
    const value={...freshBeforeRestart(),communication};
    assert.doesNotThrow(()=>validateBeforeRestart(value));assert.equal(beforeRestartComplete(value,['A','B']),true);
    value.unresponsiveBoards=['A'];assert.doesNotThrow(()=>validateBeforeRestart(value),'incomplete draft choices remain retainable');
    assert.equal(beforeRestartComplete(value,['A','B']),false);
  }
  for(const failures of [['A'],['B']])assert.equal(beforeRestartComplete(answer('some',failures),['A','B']),true);
  for(const failures of [[],['A','B'],['C']])assert.equal(beforeRestartComplete(answer('some',failures),['A','B']),false);
  assert.equal(beforeRestartComplete(answer('some',['A','C']),['A','B','C','D']),true);
  assert.equal(beforeRestartComplete(answer('some',['E']),all),true);
  for(const boards of [undefined,null,[],['A','A'],['F'],'AB'])assert.equal(beforeRestartComplete(answer('all',[]),boards),false);
});

test('stored historical board names stay valid when a later selected capacity has different active columns',()=>{
  const value=answer('some',['D','E']),before=json(value);
  assert.equal(validateBeforeRestart(value),value);
  assert.equal(beforeRestartComplete(value,['A','B']),false);
  assert.equal(beforeRestartComplete(value,all),true);
  assert.equal(json(value),before);
  const draft=session();draft.details.lockerCapacity='32';draft.beforeRestart=value;
  const record=createReportRecord(draft,{id,savedAt});
  assert.deepEqual(record.session.beforeRestart.unresponsiveBoards,['D','E']);
  assert.doesNotThrow(()=>payloadForDrive(roundTrip(record)));
});

test('malformed answers, board lists, notes and noncanonical observation timestamps are rejected',()=>{
  const sparse=['A',,];sparse.extra='B';
  const extra=['A'];extra.note='extra property';
  const changes=[
    value=>value.communication='passed',value=>value.communication=true,
    value=>value.unresponsiveBoards='A',value=>value.unresponsiveBoards=['A','A'],
    value=>value.unresponsiveBoards=['a'],value=>value.unresponsiveBoards=['F'],
    value=>value.unresponsiveBoards=[1],value=>value.unresponsiveBoards=sparse,value=>value.unresponsiveBoards=extra,
    value=>value.notes=null,value=>value.notes='x'.repeat(2001),
    value=>value.recordedAt=null,value=>value.recordedAt='2026-11-18T09:00:00Z',
    value=>value.recordedAt='2026-11-18T10:00:00.000+01:00',value=>value.recordedAt='2026-02-30T09:00:00.000Z',
    value=>value.communication='',value=>delete value.notes,value=>value.unexpected='extra',
  ];
  for(const change of changes){const value=answer();change(value);assert.throws(()=>validateBeforeRestart(value),TypeError);assert.equal(beforeRestartComplete(value,all),false);}
  for(const value of [null,[],true,'some',{},new Date()])assert.throws(()=>validateBeforeRestart(value),TypeError);
  assert.doesNotThrow(()=>validateBeforeRestart({...answer(),notes:'x'.repeat(2000)}));
  assert.doesNotThrow(()=>validateBeforeRestart({...answer(),recordedAt:''}));
});

test('answers, notes, selected boards and timestamps count as data while fresh blank observations do not',()=>{
  const blank=session();blank.beforeRestart=freshBeforeRestart();
  assert.equal(hasReportData(blank),false);
  for(const beforeRestart of [
    {...freshBeforeRestart(),communication:'all'},
    {...freshBeforeRestart(),notes:'The columns stopped replying.'},
    {...freshBeforeRestart(),unresponsiveBoards:['A']},
    answer('unsure',[]),
  ])assert.equal(hasReportData({...blank,beforeRestart}),true);
  assert.equal(hasReportData({...blank,beforeRestart:{...freshBeforeRestart(),notes:' \t\n'}}),false);
  assert.equal(hasReportData({...blank,beforeRestart:{...freshBeforeRestart(),recordedAt:at}}),true,'malformed dated evidence must not be silently discarded');
});

test('operator communication claims stay separate from automatic ISB results and the diagnostic outcome',()=>{
  const draft=session(),previous=outcome(draft);
  draft.beforeRestart=answer('all',[]);
  const record=createReportRecord(draft,{id,savedAt});
  assert.deepEqual(outcome(draft),previous);assert.notEqual(record.title,'All five boards responded');
  assert.deepEqual(record.session.initial,{});assert.deepEqual(record.session.recheck,{});
  assert.match(record.reportText,/BEFORE RESTART — OPERATOR OBSERVATION/);
  const initial=record.reportText.split('INITIAL ISB CHECK')[1].split('SELF-TEST')[0];
  assert.match(initial,/not checked/);assert.doesNotMatch(initial,/: responded/);
});

test('blank observations are reported as unrecorded and undated drafts are not presented as confirmed before restart',()=>{
  const draft=session();draft.beforeRestart=freshBeforeRestart();
  assert.match(createReportRecord(draft,{id,savedAt}).reportText,/BEFORE RESTART — OPERATOR OBSERVATION\nNot recorded\./);
  draft.beforeRestart={...freshBeforeRestart(),communication:'unsure',notes:'The original state was unclear.'};
  const record=createReportRecord(draft,{id,savedAt});
  assert.match(record.reportText,/Recorded: Draft only; not confirmed before restart/);
  assert.deepEqual(record.session.initial,{});assert.deepEqual(record.session.recheck,{});
});

test('report snapshots freeze the pre-restart observation and retry the original text and time unchanged',()=>{
  const draft=session();draft.beforeRestart=answer();
  const record=createReportRecord(draft,{id,savedAt}),originalText=record.reportText;
  assert.equal(Object.isFrozen(record.session.beforeRestart),true);assert.equal(Object.isFrozen(record.session.beforeRestart.unresponsiveBoards),true);
  draft.beforeRestart.notes='Later live note';draft.beforeRestart.unresponsiveBoards.push('B');draft.beforeRestart.recordedAt='';
  assert.equal(record.session.beforeRestart.notes,'Observed before restarting the PC.');assert.deepEqual(record.session.beforeRestart.unresponsiveBoards,['A']);
  assert.equal(payloadForDrive(roundTrip(record)).reportText,originalText);
  const restored=roundTrip(record);restored.reportText='Previous report format\nOriginal before-restart evidence.\nSaved: '+savedAt;
  restored.session.details.lockerCapacity='32';restored.session.beforeRestart.unresponsiveBoards=['E'];
  const before=json(restored),payload=payloadForDrive(restored);
  assert.equal(payload.reportText,restored.reportText);assert.equal(payload.savedAt,savedAt);assert.equal(payload.id,id);assert.equal(json(restored),before);
});

test('legacy records missing the optional observation remain saveable and retry their frozen text without adding it',()=>{
  const draft=session();delete draft.beforeRestart;
  const record=roundTrip(createReportRecord(draft,{id,savedAt}));
  assert.equal(Object.hasOwn(record.session,'beforeRestart'),false);
  record.reportText='An older frozen report with no pre-restart section.';
  assert.equal(payloadForDrive(record).reportText,record.reportText);assert.equal(Object.hasOwn(record.session,'beforeRestart'),false);
});

test('malformed new observations are rejected both before freezing and before sending a restored record',()=>{
  const draft=session();draft.beforeRestart=answer();const record=roundTrip(createReportRecord(draft,{id,savedAt}));
  for(const mutate of [value=>value.notes='x'.repeat(2001),value=>value.unresponsiveBoards=['A','A'],
    value=>value.communication='invalid',value=>value.recordedAt='invalid']){
    const current=structuredClone(draft);mutate(current.beforeRestart);assert.throws(()=>createReportRecord(current,{id,savedAt}),TypeError);
    const restored=roundTrip(record);mutate(restored.session.beforeRestart);assert.throws(()=>payloadForDrive(restored),TypeError);
  }
});

test('before-restart drafts and their step history are recoverable without writing, restoring or relabelling evidence',()=>{
  const draft=session();draft.step='before-restart';draft.history=['welcome','identify','before-restart'];draft.beforeRestart=answer('some',['E']);draft.details.lockerCapacity='32';
  const storage=new Storage({[draftKey(id)]:json(draft)}),before=[...storage.items],result=readRecoverableTests(storage);
  assert.equal(result.unreadable,false);assert.equal(result.entries.length,1);assert.equal(result.entries[0].kind,'draft');
  assert.equal(result.entries[0].draft.step,'before-restart');assert.deepEqual(result.entries[0].draft.history,draft.history);
  assert.deepEqual(result.entries[0].draft.beforeRestart,draft.beforeRestart);unchanged(storage,before);
});

test('observation-only drafts are recoverable but initialized blank observations are not saved-report data',()=>{
  const notes=session();notes.step='before-restart';notes.beforeRestart={...freshBeforeRestart(),notes:'Observed a loss of communication.'};
  const blank=session();blank.reportId=second;blank.beforeRestart=freshBeforeRestart();
  const storage=new Storage({[draftKey(id)]:json(notes),[draftKey(second)]:json(blank)}),before=[...storage.items],result=readRecoverableTests(storage);
  assert.equal(result.unreadable,false);assert.deepEqual(result.entries.map(entry=>entry.id),[id]);unchanged(storage,before);
});

test('malformed stored observations are preserved and flagged while legacy drafts and frozen pending reports remain recoverable',()=>{
  const malformed=session();malformed.beforeRestart={...answer(),unresponsiveBoards:['A','A']};
  const legacy=session();legacy.reportId=second;delete legacy.beforeRestart;legacy.details.location='Legacy site';
  const storage=new Storage({[draftKey(id)]:json(malformed),[draftKey(second)]:json(legacy)}),before=[...storage.items],result=readRecoverableTests(storage);
  assert.equal(result.unreadable,true);assert.deepEqual(result.entries.map(entry=>entry.id),[second]);
  assert.equal(Object.hasOwn(result.entries[0].draft,'beforeRestart'),false);unchanged(storage,before);

  const pending=roundTrip(createReportRecord({...session(),beforeRestart:answer()},{id,savedAt}));
  pending.reportText='Earlier frozen observation wording.';
  const pendingStore=new Storage({[pendingKey(id)]:json(pending)}),pendingBefore=[...pendingStore.items],recovered=readRecoverableTests(pendingStore);
  assert.equal(recovered.unreadable,false);assert.equal(recovered.entries[0].record.reportText,pending.reportText);
  assert.deepEqual(recovered.entries[0].record.session.beforeRestart,pending.session.beforeRestart);unchanged(pendingStore,pendingBefore);
});
