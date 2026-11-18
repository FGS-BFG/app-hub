import {hasReportData, payloadForDrive} from './report-record.js?v=20261118-detect';
import {buildReportPayload, validateSaveResult} from './drive-reports.js';
import {validateBeforeRestart} from './before-restart.js?v=20261118-before-restart';
import {validateBoardDetection} from './board-detection.js?v=20261118-detect';

export const STORAGE_PREFIX = 'fgs-mci-guided-usb-v4';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEPS = new Set(['welcome', 'identify', 'before-restart', 'power', 'startup', 'connect', 'reset', 'initial',
  'selftest', 'retry', 'recheck', 'select', 'connector', 'swap', 'cable', 'single-board', 'doors', 'result']);
const BOARDS = new Set(['A', 'B', 'C', 'D', 'E']);
const STATES = new Set(['responded', 'no-response']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const legacy = new Map([
  [STORAGE_PREFIX, 'draft'],
  [STORAGE_PREFIX + '-pending-report', 'pending'],
  [STORAGE_PREFIX + '-saved-report', 'saved'],
]);

function validId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('A valid test UUID is required.');
  return id;
}

export const draftKey = id => STORAGE_PREFIX + ':draft:' + validId(id);
export const pendingKey = id => STORAGE_PREFIX + ':pending:' + validId(id);
export const savedKey = id => STORAGE_PREFIX + ':saved:' + validId(id);

function sameId(one, two) {
  return validId(one).toLowerCase() === validId(two).toLowerCase();
}

function validateDraft(draft) {
  if (!object(draft) || draft.version !== 1 || !STEPS.has(draft.step) ||
      !object(draft.details) || !timestamp(draft.started) ||
      !Array.isArray(draft.log) || !Array.isArray(draft.history)) {
    throw new TypeError('The saved draft has an invalid structure.');
  }
  validId(draft.reportId);
  for (const field of ['location', 'technician', 'notes']) {
    if (typeof draft.details[field] !== 'string') throw new TypeError('Invalid draft details.');
  }
  validateBeforeRestart(draft.beforeRestart);
  validateBoardDetection(draft.boardDetection);
  for (const [field,limit] of Object.entries({boardConfiguration:80,masterBoardLabel:160,slaveBoardLabels:500,configurationNotes:2000})) {
    const value=draft.details[field];
    if (value!==undefined&&(typeof value!=='string'||value.length>limit)) throw new TypeError('Invalid draft board identification.');
  }
  for (const field of ['initial', 'recheck', 'swapped']) {
    if (!object(draft[field]) || Object.entries(draft[field]).some(([board, value]) =>
      !BOARDS.has(board) || !STATES.has(value))) throw new TypeError('Invalid draft board results.');
  }
  if (draft.log.some(entry => !object(entry) || !timestamp(entry.at) || typeof entry.label !== 'string') ||
      draft.history.some(step => !STEPS.has(step))) throw new TypeError('Invalid draft step records.');
  for (const field of ['connection', 'selftest', 'affected', 'neighbor', 'cable']) {
    if (typeof draft[field] !== 'string') throw new TypeError('Invalid draft observations.');
  }
  if (typeof draft.connectionIssue !== 'boolean' || typeof draft.acknowledged !== 'boolean') {
    throw new TypeError('Invalid draft observations.');
  }
  if (draft.checkErrors !== undefined && (!object(draft.checkErrors) ||
      Object.values(draft.checkErrors).some(value => typeof value !== 'string'))) {
    throw new TypeError('Invalid draft check errors.');
  }
  if (draft.usb !== undefined) {
    if (!object(draft.usb)) throw new TypeError('Invalid draft USB evidence.');
    for (const field of ['events', 'observations', 'checks']) {
      if (draft.usb[field] !== undefined && !Array.isArray(draft.usb[field])) {
        throw new TypeError('Invalid draft USB evidence.');
      }
    }
    for (const field of ['boards', 'lastBits']) {
      if (draft.usb[field] !== undefined && !object(draft.usb[field])) {
        throw new TypeError('Invalid draft USB evidence.');
      }
    }
    if (draft.usb.connected !== undefined && typeof draft.usb.connected !== 'boolean') {
      throw new TypeError('Invalid draft USB connection state.');
    }
  }
  return draft;
}

function validateRecord(record) {
  buildReportPayload(payloadForDrive(record));
  return record;
}

// Discover evidence only. This function never writes, removes, activates or
// restores a test, and never substitutes a new ID or timestamp for saved data.
export function readRecoverableTests(storage) {
  let unreadable = false;
  const keys = new Set(legacy.keys());
  const candidates = new Map();
  const sourcePriorities = new Map();
  const saved = new Set();
  try {
    const count = storage.length;
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid storage length.');
    for (let i = 0; i < count; i++) {
      try {
        const key = storage.key(i);
        if (typeof key === 'string') keys.add(key);
        else unreadable = true;
      } catch { unreadable = true; }
    }
  } catch { unreadable = true; }

  for (const key of keys) {
    let kind = legacy.get(key), keyId;
    if (!kind) {
      const stem = STORAGE_PREFIX + ':';
      if (!key.startsWith(stem)) continue;
      const suffix = key.slice(stem.length);
      const separator = suffix.indexOf(':');
      if (separator < 0) {
        if (['draft', 'pending', 'saved'].includes(suffix)) unreadable = true;
        continue;
      }
      kind = suffix.slice(0, separator);
      if (!['draft', 'pending', 'saved'].includes(kind)) continue;
      keyId = suffix.slice(separator + 1);
    }
    try {
      if (keyId !== undefined) validId(keyId);
      const raw = storage.getItem(key);
      if (raw === null) {
        if (keyId !== undefined) unreadable = true;
        continue;
      }
      const value = JSON.parse(raw);
      let id, entry;
      if (kind === 'draft') {
        const draft = validateDraft(value);
        id = draft.reportId;
        if (keyId !== undefined && !sameId(keyId, id)) throw new TypeError('Draft ID does not match its key.');
        if (!hasReportData(draft)) continue;
        entry = {id, kind, draft, location:draft.details.location,
          technician:draft.details.technician, at:draft.started};
      } else if (kind === 'pending') {
        const record = validateRecord(value);
        id = record.id;
        if (keyId !== undefined && !sameId(keyId, id)) throw new TypeError('Pending ID does not match its key.');
        entry = {id, kind, record, location:record.location,
          technician:record.technician, at:record.savedAt};
      } else {
        if (!object(value)) throw new TypeError('Invalid saved marker.');
        if (value.record !== undefined) {
          const record = validateRecord(value.record);
          id = record.id;
          if (keyId !== undefined && !sameId(keyId, id)) throw new TypeError('Saved ID does not match its key.');
        } else if (keyId !== undefined) {
          id = keyId;
        } else {
          throw new TypeError('A legacy saved receipt needs its report record.');
        }
        validateSaveResult(value.receipt, validId(id).toLowerCase());
        saved.add(id.toLowerCase());
        continue;
      }
      const normalized = id.toLowerCase();
      const previous = candidates.get(normalized);
      const priority = keyId === undefined ? 0 : 1;
      if (!previous || entry.kind === 'pending' && previous.kind !== 'pending' ||
          entry.kind === previous.kind && (priority > sourcePriorities.get(normalized) ||
            priority === sourcePriorities.get(normalized) && Date.parse(entry.at) > Date.parse(previous.at))) {
        candidates.set(normalized, entry);
        sourcePriorities.set(normalized, priority);
      }
    } catch { unreadable = true; }
  }
  const entries = [...candidates].filter(([id]) => !saved.has(id)).map(([, entry]) => entry);
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  return {entries, unreadable};
}
