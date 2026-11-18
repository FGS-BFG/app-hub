import test from 'node:test';
import assert from 'node:assert/strict';
import {freshSession} from '../../locker-troubleshooting/flow.js';
import {createReportRecord} from '../../locker-troubleshooting/report-record.js';
import {
  STORAGE_PREFIX, draftKey, pendingKey, savedKey, readRecoverableTests,
} from '../../locker-troubleshooting/test-storage.js';

const one = '361af840-d85e-4695-8f91-c404bd6e8986';
const two = '87441bfd-3d97-46dd-a469-44d5602998d4';
const at = '2026-11-18T09:00:00.000Z';
const later = '2026-11-18T10:00:00.000Z';
class MemoryStorage {
  constructor(items = {}) { this.items = new Map(Object.entries(items)); this.writes = 0; this.removals = 0; }
  get length() { return this.items.size; }
  key(index) { return [...this.items.keys()][index] ?? null; }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.writes++; this.items.set(key, String(value)); }
  removeItem(key) { this.removals++; this.items.delete(key); }
}
const json = value => JSON.stringify(value);
function draft(id = one, started = at) {
  return {...freshSession(), reportId:id, started,
    details:{location:'Dublin T2', technician:'George', notes:'Sensor observations'}};
}
function record(id = one, savedAt = at) {
  return createReportRecord(draft(id), {id, savedAt});
}
function receipt(id = one) {
  const fileId = 'confirmed-drive-file-001';
  return {reportId:id.toLowerCase(), fileId, url:'https://drive.google.com/file/d/' + fileId + '/view'};
}
function unchanged(storage, before) {
  assert.deepEqual([...storage.items], before);
  assert.equal(storage.writes, 0);
  assert.equal(storage.removals, 0);
}

test('each UUID has separate draft, pending and saved keys', () => {
  assert.equal(STORAGE_PREFIX, 'fgs-mci-guided-usb-v4');
  assert.equal(draftKey(one), STORAGE_PREFIX + ':draft:' + one);
  assert.equal(pendingKey(one), STORAGE_PREFIX + ':pending:' + one);
  assert.equal(savedKey(one), STORAGE_PREFIX + ':saved:' + one);
  assert.equal(new Set([draftKey(one), pendingKey(one), savedKey(one), draftKey(two), pendingKey(two), savedKey(two)]).size, 6);
  for (const key of [draftKey, pendingKey, savedKey]) {
    for (const bad of [null, '', 'arbitrary', '../another-test', one + ':draft', '00000000-0000-0000-0000-000000000000']) {
      assert.throws(() => key(bad), /UUID/);
    }
  }
});

test('enumerates independent meaningful drafts and ignores blank drafts without restoring them', () => {
  const blank = {...freshSession(), reportId:crypto.randomUUID(), mode:'usb',
    usb:{boards:{}, lastBits:{}, connected:false, checks:[], observations:[], events:[]}};
  const storage = new MemoryStorage({
    unrelated:'not JSON and not this application',
    [draftKey(one)]:json(draft(one)),
    [draftKey(two)]:json(draft(two, later)),
    [draftKey(blank.reportId)]:json(blank),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, false);
  assert.deepEqual(result.entries.map(entry => entry.id), [two, one]);
  assert.equal(result.entries[0].kind, 'draft');
  assert.equal(result.entries[0].location, 'Dublin T2');
  assert.equal(result.entries[0].technician, 'George');
  assert.equal(result.entries[0].at, later);
  result.entries[0].draft.details.notes = 'Changing the returned object does not write storage';
  unchanged(storage, before);
});

test('discovers legacy singleton drafts and frozen pending reports without migrating or deleting them', () => {
  const pending = record(two, later);
  const storage = new MemoryStorage({
    [STORAGE_PREFIX]:json(draft(one)),
    [STORAGE_PREFIX + '-pending-report']:json(pending),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, false);
  assert.deepEqual(result.entries.map(entry => [entry.id, entry.kind]), [[two, 'pending'], [one, 'draft']]);
  assert.deepEqual(result.entries[0].record, JSON.parse(json(pending)));
  unchanged(storage, before);
});

test('a pending record wins over the same draft and retains its original ID, save time and wording', () => {
  const pending = JSON.parse(json(record(one)));
  pending.title = 'An earlier guide outcome';
  pending.reportText = 'An older frozen report layout with original raw evidence.';
  const editedDraft = draft(one, later);
  editedDraft.details.location = 'Later draft wording';
  const storage = new MemoryStorage({
    [draftKey(one)]:json(editedDraft),
    [STORAGE_PREFIX]:json(draft(one)),
    [pendingKey(one)]:json(pending),
    [draftKey(two)]:json(draft(two, later)),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  const recovered = result.entries.find(entry => entry.id === one);
  assert.equal(result.unreadable, false);
  assert.equal(result.entries.length, 2);
  assert.equal(recovered.kind, 'pending');
  assert.equal(recovered.record.id, one);
  assert.equal(recovered.record.savedAt, at);
  assert.equal(recovered.record.title, pending.title);
  assert.equal(recovered.record.reportText, pending.reportText);
  assert.equal(recovered.location, 'Dublin T2');
  assert.equal(recovered.at, at);
  unchanged(storage, before);
});

test('an updated per-test draft takes priority over its older legacy copy with the same start time', () => {
  const current = draft(one);
  current.details.notes = 'New evidence from continuing this test';
  const storage = new MemoryStorage({
    [STORAGE_PREFIX]:json(draft(one)),
    [draftKey(one)]:json(current),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].draft.details.notes, current.details.notes);
  unchanged(storage, before);
});

test('a valid per-test saved receipt excludes only its own draft and pending record', () => {
  const storage = new MemoryStorage({
    [draftKey(one)]:json(draft(one)),
    [pendingKey(one)]:json(record(one)),
    [savedKey(one)]:json({receipt:receipt(one)}),
    [draftKey(two)]:json(draft(two, later)),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, false);
  assert.deepEqual(result.entries.map(entry => entry.id), [two]);
  unchanged(storage, before);
});

test('a legacy saved record and receipt exclude the matching report without overwriting other data', () => {
  const storage = new MemoryStorage({
    [STORAGE_PREFIX]:json(draft(one)),
    [STORAGE_PREFIX + '-pending-report']:json(record(one)),
    [STORAGE_PREFIX + '-saved-report']:json({schema:1, record:record(one), receipt:receipt(one)}),
    [pendingKey(two)]:json(record(two, later)),
  });
  const before = [...storage.items];
  assert.deepEqual(readRecoverableTests(storage).entries.map(entry => entry.id), [two]);
  unchanged(storage, before);
});

test('malformed entries are preserved and flagged while valid evidence remains discoverable', () => {
  const invalidDraft = draft(one);
  delete invalidDraft.reportId;
  const storage = new MemoryStorage({
    [STORAGE_PREFIX]:json(invalidDraft),
    [STORAGE_PREFIX + '-pending-report']:'{bad JSON',
    [STORAGE_PREFIX + '-saved-report']:json({record:record(one), receipt:{...receipt(one), url:'https://example.com/not-drive'}}),
    [draftKey(one)]:json({...draft(one), history:[17]}),
    [pendingKey(two)]:json(record(two, later)),
    [STORAGE_PREFIX + ':draft:not-a-uuid']:json(draft(one)),
    [STORAGE_PREFIX + ':draft']:json(draft(one)),
  });
  const before = [...storage.items];
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, true);
  assert.deepEqual(result.entries.map(entry => entry.id), [two]);
  unchanged(storage, before);
});

test('mismatched IDs and invalid saved receipts cannot hide a recoverable draft', () => {
  for (const invalidSaved of [{receipt:receipt(two)}, {receipt:{...receipt(one), fileId:'different-file-id'}},
    {record:record(two), receipt:receipt(two)}, {receipt:{...receipt(one), url:'javascript:alert(1)'}}]) {
    const storage = new MemoryStorage({
      [draftKey(one)]:json(draft(one)),
      [savedKey(one)]:json(invalidSaved),
      [pendingKey(two)]:json(record(one)),
    });
    const before = [...storage.items];
    const result = readRecoverableTests(storage);
    assert.equal(result.unreadable, true);
    assert.deepEqual(result.entries.map(entry => [entry.id, entry.kind]), [[one, 'draft']]);
    unchanged(storage, before);
  }
});

test('minimal draft validation rejects malformed observations and keeps every original byte', () => {
  const variants = [
    {version:2}, {step:'unrecognized'}, {details:[]}, {started:'not a date'}, {log:'not an array'},
    {log:[{at:'not a date', label:'Observed'}]}, {history:['not a step']}, {initial:{Z:'responded'}},
    {recheck:{A:'unknown'}}, {connectionIssue:'yes'}, {usb:{checks:'not an array'}},
  ];
  for (const change of variants) {
    const storage = new MemoryStorage({[draftKey(one)]:json({...draft(one), ...change})});
    const before = [...storage.items];
    assert.deepEqual(readRecoverableTests(storage), {entries:[], unreadable:true});
    unchanged(storage, before);
  }
});

test('storage failures are reported and never trigger writes or removals', () => {
  const storage = new MemoryStorage({[draftKey(one)]:json(draft(one)), [draftKey(two)]:json(draft(two, later))});
  const before = [...storage.items];
  const read = storage.getItem;
  storage.getItem = function(key) { if (key === draftKey(one)) throw Error('denied'); return read.call(this, key); };
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, true);
  assert.deepEqual(result.entries.map(entry => entry.id), [two]);
  unchanged(storage, before);
  assert.deepEqual(readRecoverableTests(null), {entries:[], unreadable:true});
});

test('legacy known keys can still be recovered if key enumeration is unavailable', () => {
  const storage = new MemoryStorage({[STORAGE_PREFIX]:json(draft(one))});
  const before = [...storage.items];
  storage.key = () => { throw Error('enumeration unavailable'); };
  const result = readRecoverableTests(storage);
  assert.equal(result.unreadable, true);
  assert.deepEqual(result.entries.map(entry => entry.id), [one]);
  unchanged(storage, before);
});

test('metadata-only and USB-only evidence are meaningful, while timestamps alone are not', () => {
  const noDetails = {...freshSession(), reportId:one, started:at};
  const usbOnly = {...freshSession(), reportId:two, started:later,
    usb:{checks:[{board:'A', status:'no-response', at:later}]}};
  const storage = new MemoryStorage({[draftKey(one)]:json(noDetails), [draftKey(two)]:json(usbOnly)});
  assert.deepEqual(readRecoverableTests(storage).entries.map(entry => entry.id), [two]);
  noDetails.details.technician = 'George';
  storage.items.set(draftKey(one), json(noDetails));
  assert.deepEqual(readRecoverableTests(storage).entries.map(entry => entry.id), [two, one]);
});
