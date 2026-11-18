const BOARDS = ['A', 'B', 'C', 'D', 'E'];
const COMMUNICATION = ['', 'all', 'some', 'none', 'unsure'];
const FIELDS = ['communication', 'unresponsiveBoards', 'notes', 'recordedAt'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new TypeError('Invalid before-restart observation: ' + message); };

function boardList(value) {
  return Array.isArray(value) && value.length <= BOARDS.length
    && Object.keys(value).length === value.length
    && Object.keys(value).every((key, index) => key === String(index))
    && value.every(board => typeof board === 'string' && BOARDS.includes(board))
    && new Set(value).size === value.length;
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function freshBeforeRestart() {
  return {communication: '', unresponsiveBoards: [], notes: '', recordedAt: ''};
}

// Stored observations describe what the operator saw at that time. Do not apply
// a subsequently selected capacity to their historical bank names here.
export function validateBeforeRestart(value, {allowMissing = true} = {}) {
  if (value === undefined && allowMissing) return value;
  if (!object(value) || Object.keys(value).some(key => !FIELDS.includes(key))) invalid('the observation must have the supported fields.');
  if (typeof value.communication !== 'string' || !COMMUNICATION.includes(value.communication)) invalid('choose a supported communication answer.');
  if (!boardList(value.unresponsiveBoards)) invalid('unresponsive boards must be unique letters A–E.');
  if (typeof value.notes !== 'string' || value.notes.length > 2000) invalid('notes must be text of at most 2000 characters.');
  if (typeof value.recordedAt !== 'string' || value.recordedAt !== '' && !timestamp(value.recordedAt)) invalid('recordedAt must be blank or a canonical UTC ISO timestamp.');
  if (value.recordedAt && !value.communication) invalid('a recorded timestamp requires a communication answer.');
  return value;
}

export function beforeRestartComplete(value, boards) {
  try {
    validateBeforeRestart(value, {allowMissing: false});
    if (!boardList(boards) || !boards.length || !value.communication) return false;
    const failed = value.unresponsiveBoards;
    return value.communication === 'some'
      ? failed.length > 0 && failed.length < boards.length && failed.every(board => boards.includes(board))
      : failed.length === 0;
  } catch { return false; }
}
