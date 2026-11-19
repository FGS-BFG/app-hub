import {SerialTransport} from '../locker-troubleshooting/serial.js?v=client-check-1';
import {layoutForCapacity} from '../locker-troubleshooting/layouts.js';
import {PortWatch} from './port-watch.js';

const byId = id => document.getElementById(id);
const capacity = byId('capacity'), notes = byId('notes');
const passList = byId('passes'), activity = byId('activity');
const primary = byId('primary'), alternate = byId('alternate');
const startedAt = new Date();
const serial = navigator.serial;
const watch = serial ? new PortWatch(serial, usbChanged) : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resetSettleMs = 6000;
const resetReconnectMs = 8000;
const stamp = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const labels = {
  initial: 'Initial check',
  reset: 'After board reset',
  power: 'After power cycle',
};
const results = {
  reply: 'Replied',
  timeout: 'No reply',
  error: 'No valid reply',
  skipped: 'Not checked',
};
const passes = [], entries = [];
let layout = null, transport = null, stage = 'setup', busy = false, feedback = '';
let lastDownload = null, resetWriteAt = 0, portRemovedDuringCycle = false, confirmed = false;

function log(kind, message) {
  const now = new Date();
  entries.push({at: now.toISOString(), kind, message});
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.dateTime = now.toISOString();
  time.textContent = stamp.format(now);
  item.append(time, kind + ' · ' + message);
  activity.prepend(item);
  if (activity.children.length > 80) activity.lastElementChild.remove();
}

function prompt(title, instruction, nextStage) {
  stage = nextStage;
  byId('step-title').textContent = title;
  byId('instruction').textContent = instruction;
  log('Prompt', instruction);
  render();
  byId('step-title').focus();
}

function setButton(button, text, action, disabled = false) {
  button.hidden = !text;
  button.textContent = text;
  button.onclick = text ? action : null;
  button.disabled = busy || disabled;
}

function render() {
  const chosen = layout ?? layoutForCapacity(capacity.value);
  byId('layout').textContent = chosen ? 'Boards ' + chosen.boards.join(', ') + ' · Master ' + chosen.master : '';
  byId('setup').hidden = stage !== 'setup';
  byId('usb-reference').hidden = !['power-off', 'power-on', 'power-port'].includes(stage);
  capacity.disabled = busy;
  byId('usb').textContent = stage === 'finished' ? 'Test closed'
    : transport?.connected && watch.present ? 'USB open'
    : !watch?.port ? 'USB not selected'
    : watch.present ? 'USB detected' : 'USB disconnected';
  byId('feedback').textContent = feedback;
  byId('feedback').hidden = !feedback;
  byId('recovery-plan').hidden = stage !== 'initial-failed' && stage !== 'resetting';
  byId('save').disabled = busy || !passes.length;
  byId('finish').disabled = busy || !passes.length || stage === 'finished';
  byId('finish').textContent = stage === 'review' || stage === 'finished' ? 'Save and finish' : 'Finish with current results';
  notes.readOnly = stage === 'finished';
  setButton(primary, '', null);
  setButton(alternate, '', null);
  if (stage === 'setup') {
    setButton(primary, 'Choose locker USB and check', choosePort, !chosen || !watch);
  } else if (stage === 'initial-failed') {
    if (transport?.connected && watch.present) setButton(primary, 'Save report and start recovery', startReset);
    else {
      setButton(primary, 'Select locker USB and check again', choosePort);
      setButton(alternate, 'Start recovery with a power cycle', beginPowerCycle);
    }
  } else if (stage === 'review' && !confirmed) {
    setButton(primary, 'Power cycle the master board', beginPowerCycle);
  } else if (stage === 'power-off') {
    setButton(primary, 'Power is off', confirmPowerOff);
  } else if (stage === 'power-on') {
    setButton(primary, 'Power is back on', confirmPowerOn);
  } else if (stage === 'power-port') {
    setButton(primary, 'Select the locker USB port', choosePort);
  } else if (stage === 'finished') {
    setButton(primary, 'Start a new check', () => location.reload());
  }
}

function recordResult(pass, board, result, detail) {
  pass.rows.push({board, result, detail});
  const row = pass.body.insertRow();
  const label = document.createElement('th');
  label.scope = 'row';
  label.textContent = board + (board === layout.master ? ' · Master' : '');
  row.append(label);
  const status = row.insertCell();
  status.dataset.result = result;
  status.textContent = results[result];
  if (detail) status.title = detail;
  const replies = pass.rows.filter(item => item.result === 'reply').length;
  byId('count').textContent = replies + ' of ' + layout.boards.length + ' replied in this check';
  log('Result', 'Board ' + board + ' · ' + results[result] + (detail ? ' · ' + detail : ''));
}

function newPass(kind) {
  if (passes.length) passes.at(-1).section.open = false;
  const section = document.createElement('details');
  section.open = true;
  const summary = document.createElement('summary');
  summary.textContent = labels[kind];
  const table = document.createElement('table');
  table.setAttribute('aria-label', labels[kind]);
  const body = table.createTBody();
  section.append(summary, table);
  passList.prepend(section);
  byId('results').hidden = false;
  byId('count').textContent = 'Checking ' + layout.boards.length + ' boards';
  const pass = {kind, rows: [], section, body, summary};
  passes.push(pass);
  return pass;
}

async function run(action) {
  if (busy || stage === 'finished') return;
  busy = true;
  feedback = '';
  render();
  try {
    await action();
  } catch (error) {
    feedback = error.message;
    log('Error', error.message);
  } finally {
    busy = false;
    render();
    maybeRetest();
  }
}

function usbChanged({type, source}) {
  if (type === 'candidate') {
    log('Observed', 'A matching USB serial device appeared. Select the locker port to confirm the connection. (' + source + ')');
    if (stage === 'power-port') feedback = 'A matching USB device appeared. Select the locker port to continue.';
  } else {
    log('Observed', 'Selected USB serial port ' + (type === 'attached' ? 'appeared' : 'disappeared') + ' (' + source + ').');
    if (type === 'removed' && (stage === 'power-off' || stage === 'power-on')) portRemovedDuringCycle = true;
  }
  render();
  maybeRetest();
}

function maybeRetest() {
  if (stage === 'power-port' && !busy && watch.present) run(() => check('power'));
}

async function openPort() {
  const port = watch.port;
  if (!port || !watch.present) return false;
  if (transport?.port === port && transport.connected) return true;
  await transport?.close();
  transport = new SerialTransport(port, {
    masterBoard: layout.master,
    resetBoards: layout.boards,
    onEvent(event) {
      if (event.type === 'rx') log('RX', JSON.stringify(event.raw));
      if (event.type === 'tx') log('TX attempt', event.command);
      if (event.type === 'reset-written') {
        resetWriteAt = Date.now();
        log('TX written', event.command);
      }
      if (event.type === 'error' || event.type === 'warning') log('Serial ' + event.type, event.message);
    },
    onState({connected, error}) {
      if (!connected && error?.code === 'DISCONNECTED') log('Serial session', error.message);
      render();
    },
  });
  try {
    await transport.open();
    log('Observed', 'Serial session opened at 9600 baud.');
    render();
    return true;
  } catch (error) {
    feedback = 'Could not open the locker port. Close other apps using it, then try again.';
    log('Result', error.message + (error.cause?.message ? ' ' + error.cause.message : ''));
    return false;
  }
}

function choosePort() {
  const kind = stage === 'power-port' ? 'power' : 'initial';
  run(async () => {
    log('Action', 'Opened the browser USB port picker.');
    let port;
    try {
      port = await serial.requestPort();
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      feedback = 'No port was selected. Connect the locker USB cable and try again.';
      log('Result', 'No serial port selected.');
      return;
    }
    layout ??= layoutForCapacity(capacity.value);
    const previous = watch.port;
    const wasAbsent = previous && !watch.present;
    watch.select(port);
    log('Observed', wasAbsent ? 'Operator selected the available locker serial port after USB loss.' : 'Operator selected a serial port.');
    const info = port.getInfo?.();
    if (info?.usbVendorId !== undefined && info?.usbProductId !== undefined) {
      const hex = number => number.toString(16).toUpperCase().padStart(4, '0');
      log('USB', 'Vendor ' + hex(info.usbVendorId) + ' · Product ' + hex(info.usbProductId));
    }
    await check(kind);
  });
}

async function check(kind) {
  prompt(labels[kind], 'Keep the locker USB connected while the tool checks each board.', 'checking');
  const pass = newPass(kind);
  const opened = await openPort();
  for (const board of layout.boards) {
    if (!opened || !watch.present || !transport.connected) {
      recordResult(pass, board, 'skipped', 'Serial connection unavailable.');
      continue;
    }
    try {
      const reply = await transport.query(board);
      recordResult(pass, board, 'reply', reply.raw + ' · ' + reply.elapsedMs + ' ms');
    } catch (error) {
      const result = error.code === 'DISCONNECTED' ? 'skipped' : error.code === 'TIMEOUT' ? 'timeout' : 'error';
      recordResult(pass, board, result, error.message);
    }
  }
  const replied = pass.rows.filter(row => row.result === 'reply').length;
  pass.summary.textContent += ' · ' + replied + ' of ' + layout.boards.length + ' replied';
  confirmed = replied === layout.boards.length;
  if (confirmed) {
    prompt('All boards replied', 'Add any notes. Select Save and finish to close the test and download the report.', 'review');
  } else if (kind === 'initial') {
    const missing = pass.rows.filter(row => row.result !== 'reply').map(row => row.board);
    const summary = (missing.length === 1 ? 'Board ' : 'Boards ') + missing.join(', ') + ' did not return a valid reply.';
    const instruction = transport?.connected && watch.present
      ? 'Add any notes, then select Save report and start recovery.'
      : 'Reconnect to the locker USB to reset the boards. If you cannot reconnect, start recovery with a power cycle.';
    prompt('Recovery needed', summary + ' ' + instruction, 'initial-failed');
  } else if (kind === 'reset') {
    log('Result', 'The board check after reset is incomplete. Starting the power cycle.');
    beginPowerCycle();
  } else {
    prompt('The connection issue remains', 'Add any notes. Save the report and send it to parkIT support.', 'review');
  }
}

async function waitForResetPort() {
  if (!resetWriteAt) return;
  const earliest = resetWriteAt + resetSettleMs;
  const deadline = earliest + resetReconnectMs;
  while (Date.now() < earliest || (!watch.present && Date.now() < deadline)) await sleep(150);
}

function startReset() {
  if (busy || !watch.present || !transport?.connected) return;
  if (lastDownload?.pass !== passes.at(-1) || lastDownload.notes !== notes.value) {
    downloadReport('before-reset');
  }
  run(async () => {
    const order = layout.boards.filter(board => board !== layout.master).concat(layout.master);
    prompt('Recovery in progress', 'Keep the locker USB connected. The tool resets the fitted boards, with the master last, then checks for replies again.', 'resetting');
    log('Action', 'Reset order ' + order.join(', ') + '.');
    resetWriteAt = 0;
    for (const board of order) {
      if (!watch.present || !transport.connected) {
        await waitForResetPort();
        if (!await openPort()) {
          log('Result', 'RST#' + board + ' skipped. Serial connection unavailable.');
          continue;
        }
      }
      try {
        const {acknowledged} = await transport.resetBoard(board);
        log('Result', 'RST#' + board + (acknowledged ? ' acknowledged.' : ' had no reset acknowledgement.'));
      } catch (error) {
        log('Result', 'RST#' + board + ' interrupted or rejected. ' + error.message);
      }
    }
    await waitForResetPort();
    await check('reset');
  });
}

function beginPowerCycle() {
  portRemovedDuringCycle = false;
  feedback = '';
  if (!watch.present) {
    log('Observed', 'The selected serial port was already absent when the power cycle started.');
  }
  prompt(
    'Power cycle the master board',
    'Switch off power to the master board. For a single-board test, switch off the board under test. If USB is its only power source, unplug the locker USB cable at the powered hub. If the board has a separate supply, use the normal locker power switch. When the board is off, select Power is off.',
    'power-off',
  );
}

function confirmPowerOff() {
  log('Operator', 'Confirmed the board power is off.');
  prompt('Restore power to the board',
    'Switch the locker power back on if you switched it off. Reconnect the locker USB cable to the same socket if you removed it. Wait for the board to start. Then select Power is back on.',
    'power-on');
}

function confirmPowerOn() {
  log('Operator', 'Confirmed the board power is back on.');
  if (!portRemovedDuringCycle) log('Observed', 'No USB port removal was detected during the power cycle steps.');
  if (watch.present) {
    run(() => check('power'));
  } else {
    prompt('Wait for the locker USB port',
      'Check that the locker USB cable is connected. If the port does not return, select the locker USB port again.',
      'power-port');
  }
}

function downloadReport(suffix) {
  log('Action', 'Requested report download.');
  const saved = new Date();
  const report = [
    'FGS Locker Connection Check',
    'Started ' + startedAt.toISOString(),
    'Report generated ' + saved.toISOString(),
    'Locker ' + layout.capacity + ' bays | Master ' + layout.master + ' | Boards ' + layout.boards.join(', '),
    'Notes', notes.value.trim() || 'None recorded.',
    '',
    ...passes.flatMap(pass => [
      labels[pass.kind],
      ...pass.rows.map(row => row.board + ' · ' + results[row.result] + (row.detail ? ' · ' + row.detail : '')),
      '',
    ]),
    'Activity (UTC)',
    ...entries.map(entry => entry.at + ' | ' + entry.kind + ' | ' + entry.message),
    '',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([report], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'locker-check-' + saved.toISOString().replace(/[:.]/g, '-') + '-' + suffix + '.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  lastDownload = {pass: passes.at(-1), notes: notes.value};
  byId('report-status').textContent = 'Report download started.';
}

function finish() {
  run(async () => {
    log('Action', 'Operator selected ' + byId('finish').textContent + '.');
    await transport?.close();
    watch.stop();
    prompt('Test closed', 'Keep the report for your records or send it to parkIT support.', 'finished');
    downloadReport('final');
  });
}

byId('save').onclick = () => downloadReport(stage === 'finished' ? 'final' : 'results');
byId('finish').onclick = finish;
capacity.onchange = render;
capacity.value = '';
notes.value = '';
if (watch) watch.start();
else feedback = 'Open this tool in desktop Chrome or Edge to use USB serial.';
log('Prompt', byId('instruction').textContent);
log('Prompt', 'Select the locker size and the locker USB serial port.');
render();
