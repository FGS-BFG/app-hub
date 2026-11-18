import {outcome, report, LOCKER_CAPACITIES} from './flow.js?v=20261118-capacity';
import {validateDoorTests,hasDoorTestData} from './door-test.js?v=20261118-doors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['id', 'savedAt', 'title', 'location', 'technician', 'reportText'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;

function invalid(message) {
  throw new TypeError('Invalid report record: ' + message);
}

function validateIdentity(id, savedAt) {
  if (typeof id !== 'string' || !UUID.test(id)) invalid('id must be a UUID.');
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt)) ||
      new Date(savedAt).toISOString() !== savedAt) invalid('savedAt must be an ISO UTC timestamp.');
}

function validateCapacity(details) {
  const value=details?.lockerCapacity;
  if(value!==undefined&&(typeof value!=='string'||!['',...LOCKER_CAPACITIES.map(option=>option.id)].includes(value))) {
    invalid('session.details.lockerCapacity must be blank, 80, 64 or 32 as text.');
  }
}

// Restrict snapshots to data that survives JSON storage without losing evidence.
// In particular, structuredClone alone also accepts dates, maps and non-finite numbers.
function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('numbers must be finite.');
    return;
  }
  if (typeof value !== 'object') invalid('session must contain only JSON data.');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null) {
    invalid('session must contain only plain objects and arrays.');
  }
  if (ancestors.has(value)) invalid('session must not contain circular references.');
  if (Object.getOwnPropertySymbols(value).length) invalid('symbol properties cannot be saved.');
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(descriptors, i)) invalid('sparse arrays cannot be saved.');
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid('non-enumerable properties and accessors cannot be saved.');
    }
    if (Array.isArray(value) &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      invalid('array properties cannot be saved.');
    }
    validateJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function validateSession(session) {
  if (!isObject(session) || session.version !== 1) invalid('session version must be 1.');
  for (const key of ['details', 'initial', 'recheck', 'swapped']) {
    if (!isObject(session[key])) invalid('session.' + key + ' must be an object.');
  }
  for (const key of ['location', 'technician', 'notes']) {
    if (typeof session.details[key] !== 'string') invalid('session.details.' + key + ' must be text.');
  }
  validateCapacity(session.details);
  for (const [key,limit] of Object.entries({boardConfiguration:80,masterBoardLabel:160,slaveBoardLabels:500,configurationNotes:2000})) {
    const value=session.details[key];
    if (value!==undefined&&(typeof value!=='string'||value.length>limit)) invalid('session.details.'+key+' must be text of at most '+limit+' characters.');
  }
  if (!Array.isArray(session.log) || !Array.isArray(session.history)) invalid('session records must be arrays.');
  if (typeof session.started !== 'string' || !Number.isFinite(Date.parse(session.started))) {
    invalid('session.started must be a timestamp.');
  }
  for (const entry of session.log) {
    if (!isObject(entry) || typeof entry.at !== 'string' || typeof entry.label !== 'string') {
      invalid('step records must contain a timestamp and label.');
    }
  }
  validateDoorTests(session.doorTests);
}

function clone(value) {
  return typeof globalThis.structuredClone === 'function' ?
    globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createReportRecord(session, {
  id = globalThis.crypto.randomUUID(),
  savedAt = new Date().toISOString(),
} = {}) {
  validateIdentity(id, savedAt);
  validateJson(session);
  validateSession(session);
  const snapshot = clone(session);
  return freeze({
    schema: 1,
    id,
    savedAt,
    title: outcome(snapshot).title,
    location: snapshot.details.location,
    technician: snapshot.details.technician,
    reportText: report(snapshot, {savedAt}),
    session: snapshot,
  });
}

export function payloadForDrive(record) {
  validateJson(record);
  if (!isObject(record) || record.schema !== 1) invalid('schema must be 1.');
  validateIdentity(record.id, record.savedAt);
  for (const key of fields) {
    if (typeof record[key] !== 'string') invalid(key + ' must be text.');
  }
  if (!hasText(record.title) || !hasText(record.reportText)) invalid('title and report text are required.');
  if (record.title.length > 500 || record.location.length > 1000 ||
      record.technician.length > 1000 || record.reportText.length > 2_000_000) {
    invalid('report text or metadata exceeds the supported length.');
  }
  if (!isObject(record.session)) invalid('saved session must be an object.');
  validateCapacity(record.session.details);
  validateDoorTests(record.session.doorTests);
  // Retries send exactly the saved text. Never regenerate an old report using a
  // newer outcome/formatter, which may legitimately use different wording.
  return Object.fromEntries(fields.map(key => [key, record[key]]));
}

function hasEntries(value) {
  if (!Array.isArray(value)) return false;
  return value.some(entry => hasText(entry) || isObject(entry) &&
    ['label', 'message', 'command', 'raw', 'board', 'status', 'bits', 'code'].some(key => hasText(entry[key])));
}

export function hasReportData(session) {
  if (!isObject(session)) return false;
  if (hasDoorTestData(session.doorTests)) return true;
  if (['location', 'technician', 'notes', 'title', 'lockerCapacity', 'boardConfiguration', 'masterBoardLabel', 'slaveBoardLabels', 'configurationNotes'].some(key => hasText(session.details?.[key]))) return true;
  if (['connection', 'selftest', 'affected', 'neighbor', 'cable', 'title'].some(key => hasText(session[key]))) return true;
  if (session.connectionIssue === true || session.acknowledged === true) return true;
  if (['initial', 'recheck', 'swapped', 'checkErrors'].some(key =>
    isObject(session[key]) && Object.values(session[key]).some(hasText))) return true;
  if (hasEntries(session.log) || hasEntries(session.history)) return true;
  const usb = session.usb;
  if (!isObject(usb)) return false;
  if (usb.connected === true || ['checks', 'observations', 'events'].some(key => hasEntries(usb[key]))) return true;
  if (isObject(usb.boards) && Object.values(usb.boards).some(value =>
    isObject(value) && ['board', 'status', 'bits', 'error'].some(key => hasText(value[key])))) return true;
  return isObject(usb.lastBits) && Object.values(usb.lastBits).some(hasText);
}
