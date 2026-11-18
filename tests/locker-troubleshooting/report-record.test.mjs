import test from 'node:test';
import assert from 'node:assert/strict';
import {freshSession, report} from '../../locker-troubleshooting/flow.js';
import {
  createReportRecord, payloadForDrive, hasReportData,
} from '../../locker-troubleshooting/report-record.js';

const id = '361af840-d85e-4695-8f91-c404bd6e8986';
const savedAt = '2026-11-17T15:30:00.000Z';
const options = {id, savedAt};
const roundTrip = value => JSON.parse(JSON.stringify(value));
function recordedSession() {
  const session = freshSession();
  session.mode = 'usb';
  session.details = {location:'Dublin T2', technician:'George', notes:'A changed; café'};
  session.initial = {A:'no-response', B:'responded', C:'responded', D:'responded', E:'responded'};
  session.log.push({at:savedAt, label:'Checked all five boards'});
  session.usb = {
    connected:false, boards:{A:{board:'A', status:'no-response'}},
    checks:[{board:'A', status:'no-response', at:savedAt, elapsedMs:1500}],
    observations:[{at:savedAt, message:'Eight input values changed'}],
    events:[{at:savedAt, type:'rx', raw:'<B>Ex(BIN):00000000:00000001~\n\r'}],
  };
  return session;
}

test('a saved report captures metadata, the complete session and one stable timestamp', () => {
  const session = recordedSession();
  const record = createReportRecord(session, options);
  assert.deepEqual(Object.keys(record), ['schema','id','savedAt','title','location','technician','reportText','session']);
  assert.equal(record.schema, 1);
  assert.equal(record.id, id);
  assert.equal(record.savedAt, savedAt);
  assert.equal(record.title, 'Further investigation is needed');
  assert.equal(record.location, 'Dublin T2');
  assert.equal(record.technician, 'George');
  assert.equal(record.reportText, report(session, {savedAt}));
  assert.ok(record.reportText.includes('Saved: ' + savedAt));
  assert.ok(record.reportText.includes(JSON.stringify(session.usb.events[0].raw)));
  assert.deepEqual(roundTrip(record.session), roundTrip(session));
  assert.notEqual(record.session, session);
});

test('board identification is frozen in the report text uploaded to Drive',()=>{
  const session=recordedSession();
  Object.assign(session.details,{boardConfiguration:'individual-wires',masterBoardLabel:'Printed master label',slaveBoardLabels:'A: printed A label',configurationNotes:'Observed individual sensor connections.'});
  const record=createReportRecord(session,options);
  const payload=payloadForDrive(roundTrip(record));
  session.details.boardConfiguration='flat-input-sense';session.details.masterBoardLabel='Changed live value';
  assert.equal(record.session.details.boardConfiguration,'individual-wires');
  assert.match(payload.reportText,/Operator-observed setup: Individual sensor wires/);
  assert.match(payload.reportText,/Master board label: Printed master label/);
  assert.match(payload.reportText,/Slave board labels: A: printed A label/);
  assert.match(payload.reportText,/Configuration notes: Observed individual sensor connections\./);
  assert.doesNotMatch(payload.reportText,/Changed live value/);
  assert.equal(payloadForDrive(roundTrip(record)).reportText,payload.reportText);
});

test('capacity-only selection is meaningful and its label survives frozen Drive retries',()=>{
  for(const capacity of ['80','64','32']){
    const session=freshSession();session.details.lockerCapacity=capacity;
    assert.equal(hasReportData(session),true);
    const record=createReportRecord(session,options),text=record.reportText;
    session.details.lockerCapacity=capacity==='80'?'32':'80';
    assert.equal(record.session.details.lockerCapacity,capacity);
    assert.ok(text.includes('Locker capacity: '+capacity+' bays'));
    assert.equal(payloadForDrive(roundTrip(record)).reportText,text);
  }
});

test('optional capacity accepts only blank or supported string IDs before freeze and restored transmission',()=>{
  const blank=freshSession();assert.doesNotThrow(()=>createReportRecord(blank,options));
  for(const value of [80,64,32,null,{},[],'16','80 bays',' 80']){
    const session=freshSession();session.details.lockerCapacity=value;
    assert.throws(()=>createReportRecord(session,options),/lockerCapacity/);
    const restored=roundTrip(createReportRecord(freshSession(),options));
    restored.session.details.lockerCapacity=value;
    assert.throws(()=>payloadForDrive(restored),/lockerCapacity/);
  }
});

test('older frozen records without capacity retain their exact retry wording',()=>{
  const old=roundTrip(createReportRecord(recordedSession(),options));
  assert.equal(Object.hasOwn(old.session.details,'lockerCapacity'),false);
  old.reportText='Original frozen report before capacity selection.';
  assert.equal(payloadForDrive(old).reportText,old.reportText);
});

test('door commands, operator observations and transient samples are independently frozen for Drive retries',()=>{
  const session=recordedSession(),door=session.doorTests.banks.A;
  session.doorTests.setup={connections:'original',note:'Connections returned to original banks.'};
  Object.assign(door,{status:'tested',door:6,startedAt:savedAt,completedAt:'2026-11-17T15:30:20.000Z',
    command:{open:{status:'sent',at:savedAt,raw:'Open command bytes\r'},lockOff:{status:'error',at:savedAt,code:'WRITE',error:'Lock-off transmission not confirmed.'}},
    operator:{opened:'yes',closed:'uncertain'}});
  door.snapshots.baseline.A={board:'A',status:'responded',bits:'0000000000000000',at:savedAt};
  door.samples.push({phase:'open',board:'A',status:'responded',bits:'0000000000000001',at:savedAt,elapsedMs:42});
  door.snapshots.closed.A={board:'A',status:'responded',bits:'0000000000000000',at:'2026-11-17T15:30:20.000Z'};
  const record=createReportRecord(session,options),frozenText=record.reportText;
  assert.equal(Object.isFrozen(record.session.doorTests.banks.A.samples[0]),true);
  assert.match(frozenText,/selected door 6/);assert.match(frozenText,/Lock-off transmission not confirmed/);
  assert.match(frozenText,/open A .*\(BIN\) 0000000000000001 42 ms/);
  door.door=10;door.samples[0].bits='1111111111111111';door.command.lockOff.error='Changed live error';
  const restored=roundTrip(record),payload=payloadForDrive(restored);
  assert.equal(restored.session.doorTests.banks.A.door,6);
  assert.equal(restored.session.doorTests.banks.A.samples[0].bits,'0000000000000001');
  assert.equal(payload.reportText,frozenText);assert.doesNotMatch(payload.reportText,/Changed live error/);
  assert.equal(payload.savedAt,savedAt);assert.equal(payload.id,id);
});

test('malformed new door evidence is rejected before freezing and before a restored retry is sent',()=>{
  const session=recordedSession();session.doorTests.banks.B.door=17;
  assert.throws(()=>createReportRecord(session,options),/Invalid door tests/);
  const restored=roundTrip(createReportRecord(recordedSession(),options));
  restored.session.doorTests.banks.C.samples=[{phase:'open',board:'C',status:'responded',bits:'broken',at:savedAt}];
  assert.throws(()=>payloadForDrive(restored),/16 binary inputs/);
});

test('legacy sessions without door evidence remain readable and older frozen retry text is never regenerated',()=>{
  const session=recordedSession();delete session.doorTests;
  const record=createReportRecord(session,options);
  assert.match(record.reportText,/Not recorded in this older session/);
  const old=roundTrip(record);old.reportText='Original immutable report text from before door tests.';
  assert.equal(payloadForDrive(old).reportText,old.reportText);
  assert.equal(Object.hasOwn(old.session,'doorTests'),false);
});

test('door-only selections and explicit skips are meaningful but fresh door containers are not data',()=>{
  assert.equal(hasReportData(freshSession()),false);
  const selected=freshSession();selected.doorTests.banks.D.door=12;
  assert.equal(hasReportData(selected),true);assert.doesNotThrow(()=>createReportRecord(selected,options));
  const skipped=freshSession();Object.assign(skipped.doorTests.banks.E,{status:'skipped',skipReason:'No USB connection.',completedAt:savedAt});
  assert.equal(hasReportData(skipped),true);assert.doesNotThrow(()=>createReportRecord(skipped,options));
});

test('identification alone is meaningful draft data and optional fields retain their size limits',()=>{
  for(const [field,value] of Object.entries({boardConfiguration:'unsure',masterBoardLabel:'MCI label',slaveBoardLabels:'A: label',configurationNotes:'Could not read the label.'})){
    const session=freshSession();session.details[field]=value;
    assert.equal(hasReportData(session),true,field);
    assert.doesNotThrow(()=>createReportRecord(session,options));
  }
  for(const [field,limit] of Object.entries({boardConfiguration:80,masterBoardLabel:160,slaveBoardLabels:500,configurationNotes:2000})){
    const session=freshSession();session.details[field]='x'.repeat(limit+1);
    assert.throws(()=>createReportRecord(session,options),/must be text of at most/);
    session.details[field]={unexpected:'object'};
    assert.throws(()=>createReportRecord(session,options),/must be text of at most/);
  }
});

test('older frozen reports with no board-identification fields keep their original retry text',()=>{
  const old=roundTrip(createReportRecord(recordedSession(),options));
  old.reportText='Original frozen report text from before board identification existed.';
  assert.equal(Object.hasOwn(old.session.details,'boardConfiguration'),false);
  assert.equal(payloadForDrive(old).reportText,old.reportText);
});

test('saving neither freezes nor changes the live session, and later changes cannot alter the record', () => {
  const session = recordedSession();
  const original = roundTrip(session);
  const record = createReportRecord(session, options);
  assert.deepEqual(session, original);
  assert.equal(Object.isFrozen(session), false);
  assert.equal(Object.isFrozen(session.usb.events), false);
  session.details.location = 'Another site';
  session.initial.A = 'responded';
  session.usb.events[0].raw = 'changed';
  session.usb.checks.push({board:'C', status:'responded'});
  assert.deepEqual(record.session, original);
  assert.equal(record.location, 'Dublin T2');
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.session), true);
  assert.equal(Object.isFrozen(record.session.details), true);
  assert.equal(Object.isFrozen(record.session.usb.events[0]), true);
  assert.equal(Object.isFrozen(record.session.usb.checks), true);
  assert.throws(() => { record.session.details.notes = 'changed'; }, TypeError);
  assert.throws(() => record.session.usb.checks.push({}), TypeError);
});

test('JSON restore produces the same Drive payload and excludes the raw session object', () => {
  const record = createReportRecord(recordedSession(), options);
  const payload = payloadForDrive(roundTrip(record));
  assert.deepEqual(payload, {
    id, savedAt, title:record.title, location:record.location,
    technician:record.technician, reportText:record.reportText,
  });
  assert.deepEqual(Object.keys(payload), ['id','savedAt','title','location','technician','reportText']);
  assert.equal(Object.getPrototypeOf(payload), Object.prototype);
  payload.title = 'A caller can change its own payload';
  assert.notEqual(record.title, payload.title);
  assert.deepEqual(payloadForDrive(record), payloadForDrive(roundTrip(record)));
});

test('a saved report remains unchanged when a separate new draft is started and edited', () => {
  const first = createReportRecord(recordedSession(), options);
  const firstJson = JSON.stringify(first);
  const second = freshSession();
  second.details.location = 'Second site';
  second.details.notes = 'A completely new check';
  const next = createReportRecord(second, {
    id:'87441bfd-3d97-46dd-a469-44d5602998d4',
    savedAt:'2026-11-18T08:00:00.000Z',
  });
  assert.equal(JSON.stringify(first), firstJson);
  assert.notEqual(next.id, first.id);
  assert.equal(first.session.details.location, 'Dublin T2');
  assert.equal(next.session.details.location, 'Second site');
  assert.equal(payloadForDrive(first).savedAt, savedAt);
});

test('default identities are UUIDs and default save times are canonical ISO timestamps', () => {
  const first = createReportRecord(freshSession());
  const second = createReportRecord(freshSession());
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.id, second.id);
  assert.equal(new Date(first.savedAt).toISOString(), first.savedAt);
  assert.ok(first.reportText.includes('Saved: ' + first.savedAt));
});

test('empty drafts do not acquire report data from timestamps, mode or initialized USB containers', () => {
  assert.equal(hasReportData(null), false);
  assert.equal(hasReportData(undefined), false);
  const session = freshSession();
  assert.equal(hasReportData(session), false);
  session.mode = 'usb';
  session.title = '   ';
  session.details = {location:' ', technician:'\t', notes:'\n'};
  session.usb = {connected:false, boards:{}, checks:[], observations:[], events:[], lastBits:{}};
  session.log.push({at:savedAt, label:''});
  assert.equal(hasReportData(session), false);
});

test('metadata, observations, failed connections and actual USB evidence count as report data', () => {
  const variations = [
    s => { s.details.location = 'Dublin'; },
    s => { s.details.technician = 'George'; },
    s => { s.details.notes = 'A red light was visible'; },
    s => { s.initial.A = 'no-response'; },
    s => { s.connectionIssue = true; },
    s => { s.selftest = 'uncertain'; },
    s => { s.checkErrors = {C:'Unexpected reply'}; },
    s => { s.log.push({at:savedAt, label:'Power cycle recorded'}); },
    s => { s.usb = {checks:[{at:savedAt, board:'A', status:'no-response'}]}; },
    s => { s.usb = {events:[{at:savedAt, type:'rx', raw:'<C>reply\r'}]}; },
    s => { s.usb = {observations:[{at:savedAt, message:'Inputs changed'}]}; },
    s => { s.usb = {boards:{A:{status:'responded', bits:'0000000000000000'}}}; },
    s => { s.usb = {lastBits:{A:'0000000000000000'}}; },
    s => { s.usb = {connected:true}; },
  ];
  for (const change of variations) {
    const session = freshSession();
    change(session);
    assert.equal(hasReportData(session), true);
  }
});

test('invalid UUIDs, timestamps and session shapes are rejected', () => {
  for (const bad of ['', 'some-id', '00000000-0000-0000-0000-000000000000', 17]) {
    assert.throws(() => createReportRecord(freshSession(), {...options, id:bad}), /UUID/);
  }
  for (const bad of ['', 'yesterday', '2026-02-30T10:00:00.000Z', null]) {
    assert.throws(() => createReportRecord(freshSession(), {...options, savedAt:bad}), /timestamp/);
  }
  for (const bad of [null, [], {}, {...freshSession(), version:2}, {...freshSession(), details:null},
    {...freshSession(), log:[{at:savedAt}]}, {...freshSession(), started:'invalid'}]) {
    assert.throws(() => createReportRecord(bad, options), /Invalid report record/);
  }
});

test('non-JSON values cannot silently disappear from a saved evidence snapshot', () => {
  const extraArrayProperty = [];
  extraArrayProperty['4294967295'] = 'would disappear from JSON';
  for (const value of [undefined, () => {}, Symbol('value'), BigInt(1), NaN, Infinity, new Date(), new Map(), [,], extraArrayProperty]) {
    const session = freshSession();
    session.evidence = value;
    assert.throws(() => createReportRecord(session, options), /Invalid report record/);
  }
  const circular = freshSession();
  circular.evidence = circular;
  assert.throws(() => createReportRecord(circular, options), /circular/);
  const accessor = freshSession();
  Object.defineProperty(accessor, 'evidence', {enumerable:true, get() { throw Error('must not run'); }});
  assert.throws(() => createReportRecord(accessor, options), /accessors/);
});

test('malformed or oversized pending records are rejected before Drive transmission', () => {
  const original = createReportRecord(recordedSession(), options);
  for (const [key, value] of [['schema',2], ['id','not-a-uuid'], ['savedAt','invalid'],
    ['title',''], ['location',null], ['technician',4], ['reportText',''], ['session',null],
    ['title','x'.repeat(501)], ['location','x'.repeat(1001)], ['technician','x'.repeat(1001)],
    ['reportText','x'.repeat(2_000_001)]]) {
    assert.throws(() => payloadForDrive({...roundTrip(original), [key]:value}), /Invalid report record/);
  }
  for (const key of ['id', 'savedAt', 'title', 'location', 'technician', 'reportText', 'session']) {
    const restored = roundTrip(original);
    delete restored[key];
    assert.throws(() => payloadForDrive(restored), /Invalid report record/);
  }
  assert.throws(() => payloadForDrive(null), /Invalid report record/);
});

test('retrying an older saved report preserves its original text and outcome wording', () => {
  const restored = roundTrip(createReportRecord(recordedSession(), options));
  restored.title = 'The wording used by the previous guide';
  restored.reportText = 'An older report layout\nSaved: ' + savedAt + '\nOriginal raw evidence.';
  restored.session = {version:1, previousGuideLayout:true};
  const payload = payloadForDrive(restored);
  assert.equal(payload.title, restored.title);
  assert.equal(payload.reportText, restored.reportText);
  assert.equal(payload.savedAt, savedAt);
  assert.equal(payload.id, id);
});

test('the JSON cloning fallback also isolates and freezes nested evidence', () => {
  const original = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    const session = recordedSession();
    const record = createReportRecord(session, options);
    session.usb.events[0].raw = 'changed';
    assert.notEqual(record.session.usb.events[0].raw, 'changed');
    assert.equal(Object.isFrozen(record.session.usb.events), true);
    assert.deepEqual(payloadForDrive(record), payloadForDrive(roundTrip(record)));
  } finally {
    globalThis.structuredClone = original;
  }
});
