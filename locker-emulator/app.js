import {Locker, SerialFrames, boards, bays} from './model.js?v=board-toggles';

const el = id => document.getElementById(id);
const help = el('connection-help');
const encoder = new TextEncoder();
const selectedCount = new URLSearchParams(location.search).get('cabinets');
const cabinetCount = /^[1-4]$/.test(selectedCount ?? '') ? Number(selectedCount) : 1;
const connectButton = el('connect');
const bridgeFilters = [
  {usbVendorId: 0xcafe, usbProductId: 0x4065},
  {usbVendorId: 0x239a, usbProductId: 0x80f4},
];
let bridge = null;
let opening = false;

class Pico {
  constructor(port, panels) {
    this.port = port;
    this.channels = panels.map((panel, index) => ({
      number: index + 1,
      panel,
      locker: this.newSession(panel.locker),
      frames: new SerialFrames(),
    }));
    this.pending = '';
    this.outgoing = Promise.resolve();
  }

  newSession(previous) {
    const locker = new Locker();
    for (const address of previous.offlineBoards) locker.setBoardOffline(address, true);
    locker.setReplyDelay(previous.replyDelay);
    if (previous.stuckDoor) locker.setStuckDoor(previous.stuckDoor.address, previous.stuckDoor.bay);
    return locker;
  }

  async open() {
    await this.port.open({baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'});
    this.portOpen = true;
    await this.port.setSignals({dataTerminalReady: true, requestToSend: false});
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.pump = this.read();
    const negotiate = async (command, marker, attempts = 5) => {
      this.expectedMarker = marker;
      for (let attempt = 0; attempt < attempts; attempt++) {
        await this.writer.write(encoder.encode(command));
        await new Promise(resolve => setTimeout(resolve, 175));
        if (this.failure) throw this.failure;
        if (this.mode) return true;
      }
      return false;
    };
    if (!await negotiate('\n?multi=' + this.channels.length + '\n', 'MCI304-USB-4', 2)
        && !await negotiate('\n?multi\n', 'MCI304-USB-4')
        && !await negotiate('\n?\n', 'MCI304-USB-1')) {
      throw Error('The Pico did not answer. Select the browser bridge COM port.');
    }
    if (this.mode === 'legacy' && this.channels.length > 1) {
      throw Error('This Pico firmware provides one locker COM port. Use the multi-COM Tool Kit firmware for this preset.');
    }
    this.timer = setInterval(() => {
      for (const channel of this.channels) {
        this.writeReply(channel, channel.locker.tick());
        this.syncDisplay(channel);
        if (channel.locker.events.at(-1) !== channel.panel.renderedEvent) updatePanel(channel.panel);
      }
    }, 30);
  }

  async read() {
    const decoder = new TextDecoder();
    try {
      while (!this.closing) {
        const {value, done} = await this.reader.read();
        if (done) break;
        this.pending += decoder.decode(value, {stream: true});
        let end;
        while ((end = this.pending.indexOf('\n')) !== -1) {
          const line = this.pending.slice(0, end).replace(/\r$/, '');
          this.pending = this.pending.slice(end + 1);
          this.readLine(line);
        }
        if (this.pending.length > 1024) this.pending = '';
      }
      if (!this.closing) throw Error('The Pico disconnected. Plug it in and connect again.');
    } catch (error) {
      if (!this.closing) {
        this.failure = error;
        if (bridge === this) void disconnect(error.message);
      }
    }
  }

  readLine(line) {
    if (!this.mode && line === this.expectedMarker) {
      this.mode = line === 'MCI304-USB-4' ? 'multi' : 'legacy';
      return;
    }
    if (!this.mode) return;
    const failure = /^!write([1-4])?$/.exec(line);
    if (failure && (this.mode === 'multi') === Boolean(failure[1])) {
      const channel = this.channels[Number(failure[1] || 1) - 1];
      channel?.locker.event('FAULT', 'The locker app could not receive this reply. Check its COM port.');
      if (channel) updatePanel(channel.panel);
      return;
    }
    const match = /^>(?:([1-4]):)?((?:[\da-f]{2})+)$/i.exec(line);
    if (!match || (this.mode === 'multi') !== Boolean(match[1])) return;
    const channel = this.channels[Number(match[1] || 1) - 1];
    if (!channel?.locker.powerOn) return;
    const data = String.fromCharCode(...match[2].match(/../g).map(byte => parseInt(byte, 16)));
    for (const frame of channel.frames.feed(data)) {
      this.writeReply(channel, channel.locker.tick() + channel.locker.command(frame));
      updatePanel(channel.panel);
    }
  }

  syncDisplay(channel) {
    if (this.mode !== 'multi' || this.closing) return;
    const {powerOn, offlineBoards, stuckDoor, replyDelay} = channel.locker;
    // The current OLED protocol has one slot for an offline board address.
    const offlineBoard = [...boards].find(address => offlineBoards.has(address));
    const fields = [powerOn ? 1 : 0, offlineBoard ?? '-', stuckDoor?.address ?? '-',
      stuckDoor ? stuckDoor.bay + 1 : 0, replyDelay];
    const line = '@F' + channel.number + ':' + fields.join(':') + '\n';
    if (line === channel.displayStatus) return;
    channel.displayStatus = line;
    this.enqueueWrite(() => this.writer.write(encoder.encode(line)));
  }

  enqueueWrite(write) {
    this.outgoing = this.outgoing.then(() => {
      if (!this.closing) return write();
    }).catch(error => {
      if (!this.closing && bridge === this) void disconnect(error.message);
    });
  }

  writeReply(channel, reply) {
    if (!reply || this.closing || !channel.locker.powerOn) return;
    const frames = channel.frames;
    const prefix = this.mode === 'multi' ? '<' + channel.number + ':' : '<';
    this.enqueueWrite(async () => {
      for (let offset = 0; offset < reply.length; offset += 64) {
        if (this.closing || !channel.locker.powerOn || frames !== channel.frames) return;
        const hex = Array.from(reply.slice(offset, offset + 64), byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        await this.writer.write(encoder.encode(prefix + hex + '\n'));
      }
    });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    try { await this.reader?.cancel(); } catch {}
    await this.pump;
    this.reader?.releaseLock();
    try { await this.writer?.abort(); } catch {}
    this.writer?.releaseLock();
    if (this.portOpen) {
      try { await this.port.close(); } catch {}
    }
  }
}

async function disconnect(message = 'Pico disconnected.') {
  if (opening) return;
  opening = true;
  const current = bridge;
  bridge = null;
  for (const panel of panels) panel.channel = null;
  renderConnection();
  try {
    await current?.close();
  } finally {
    help.textContent = message;
    opening = false;
    renderConnection();
    panels.forEach(renderCabinet);
  }
}

async function connect() {
  if (opening) return;
  if (bridge) {
    await disconnect();
    return;
  }
  opening = true;
  renderConnection();
  let candidate;
  try {
    const port = await navigator.serial.requestPort({filters: bridgeFilters});
    candidate = new Pico(port, panels);
    await candidate.open();
    if (candidate.failure) throw candidate.failure;
    for (const channel of candidate.channels) {
      const {panel, locker} = channel;
      panel.channel = channel;
      panel.locker = locker;
      panel.lastRelease = null;
      panel.parts['door-status'].hidden = true;
    }
    bridge = candidate;
    help.textContent = 'In the locker app, select the corresponding locker COM port for each cabinet.';
  } catch (error) {
    await candidate?.close();
    if (error.name !== 'NotFoundError') help.textContent = error.message;
  } finally {
    opening = false;
    renderConnection();
    panels.forEach(renderCabinet);
  }
}

function updatePanel(panel) {
  if (panel.paintPending) return;
  panel.paintPending = true;
  requestAnimationFrame(() => {
    panel.paintPending = false;
    renderCabinet(panel);
  });
}

function renderTrace(panel, events) {
  if (panel.renderedEvent === events.at(-1)) return;
  panel.renderedEvent = events.at(-1);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind !== 'BOARD') continue;
    const match = /^([A-Z])\/([0-9A-F]) · output latched · coil (energised|de-energised)$/.exec(event.message);
    if (match) {
      panel.lastRelease = {board: match[1], bay: bays.indexOf(match[2]), powered: match[3] === 'energised'};
      break;
    }
  }

  const trace = panel.parts.trace;
  const top = trace.scrollTop;
  const follow = trace.scrollHeight - trace.clientHeight - top < 12;
  const rows = events.map(event => {
    const row = document.createElement('div');
    row.className = 'trace-row';
    row.dataset.kind = event.kind;
    const time = document.createElement('span');
    const kind = document.createElement('strong');
    const message = document.createElement('span');
    time.textContent = event.time;
    kind.textContent = event.kind;
    message.textContent = event.message;
    row.append(time, kind, message);
    return row;
  });
  trace.replaceChildren(...rows);
  trace.scrollTop = follow ? trace.scrollHeight : top;
}

function renderConnection() {
  connectButton.disabled = opening || !navigator.serial;
  connectButton.textContent = bridge ? 'Disconnect Pico' : 'Connect Pico';
  el('connection').textContent = bridge ? 'Pico connected' : opening ? 'Connecting' : 'Pico disconnected';
  for (const panel of panels) {
    for (const field of ['reply-delay', 'stuck-board', 'stuck-door', 'apply-stuck']) {
      panel.parts[field].disabled = opening;
    }
    panel.parts['clear-stuck'].disabled = opening || !panel.locker.stuckDoor;
    for (const {controller} of Object.values(panel.modules)) controller.disabled = opening;
  }
}

function renderCabinet(panel) {
  const {parts, modules, locker, channel} = panel;
  renderTrace(panel, locker.events);
  const {lastRelease} = panel;
  const active = locker.activeLockCount;
  const status = locker.powerOn ? 'Power supplies on' : 'Power supplies off';
  const count = locker.powerOn
    ? active + (active === 1 ? ' lock energised' : ' locks energised')
    : locker.tripCount + ' locks at cutoff · serial offline';
  parts.cabinet.dataset.power = locker.powerOn;
  parts['power-panel'].dataset.on = locker.powerOn;
  if (parts['power-status'].textContent !== status) parts['power-status'].textContent = status;
  if (parts['active-lock-count'].textContent !== count) parts['active-lock-count'].textContent = count;
  parts['restore-power'].hidden = locker.powerOn;
  parts['restore-power'].disabled = !channel;
  const release = parts['last-release'];
  const label = lastRelease
    ? 'Last release request · Board ' + lastRelease.board + ', door ' + (lastRelease.bay + 1)
      + (lastRelease.powered ? '' : ' · no coil power')
    : 'No lock release recorded';
  if (release.textContent !== label) release.textContent = label;
  const faultCount = locker.offlineBoards.size + Number(Boolean(locker.stuckDoor)) + Number(locker.replyDelay > 0);
  const faultLabel = faultCount ? 'Faults (' + faultCount + ')' : 'Faults';
  if (parts['fault-summary'].textContent !== faultLabel) parts['fault-summary'].textContent = faultLabel;
  parts['clear-stuck'].disabled = opening || !locker.stuckDoor;
  const offline = [...boards].filter(address => locker.offlineBoards.has(address));
  const boardStatus = offline.length ? 'Offline: ' + offline.join(', ') : 'All boards enabled';
  if (parts['board-status'].textContent !== boardStatus) parts['board-status'].textContent = boardStatus;
  for (const [address, {buttons, module, controller}] of Object.entries(modules)) {
    const online = !locker.offlineBoards.has(address);
    module.dataset.online = online;
    controller.dataset.online = online;
    controller.setAttribute('aria-pressed', String(!online));
    controller.title = (online ? 'Disable board ' : 'Enable board ') + address;
    const board = locker.boards[address];
    buttons.forEach((button, index) => {
      const open = Boolean(board.opened & (1 << index));
      const active = locker.coilActive(address, index);
      button.dataset.open = open;
      button.dataset.active = active;
      const stuck = locker.stuckDoor?.address === address && locker.stuckDoor.bay === index;
      button.dataset.stuck = stuck;
      button.dataset.recent = lastRelease?.board === address && lastRelease.bay === index;
      const name = 'Board ' + address + ', door ' + (index + 1) + ' · ' + (open ? 'open' : 'closed')
        + (active ? ' · lock energised' : '')
        + (stuck ? ' · stuck open' : '');
      button.setAttribute('aria-label', name);
      button.title = name;
    });
  }
}

function makeBay(address, code, index, panel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bay';
  button.dataset.board = address;
  button.dataset.bay = code;
  const face = document.createElement('span');
  face.className = 'door-face';
  const window = document.createElement('span');
  window.className = 'door-window';
  window.textContent = index + 1;
  const pull = document.createElement('span');
  pull.className = 'door-pull';
  const lamp = document.createElement('span');
  lamp.className = 'door-lamp';
  face.append(window, pull);
  button.append(lamp, face);
  button.addEventListener('click', () => {
    const {parts, channel, locker} = panel;
    const status = parts['door-status'];
    status.textContent = '';
    if (!bridge || !channel) {
      status.textContent = 'Connect the Pico first';
    } else {
      bridge.writeReply(channel, locker.tick());
      if (!locker.move(address, index)) {
        if (locker.stuckDoor?.address === address && locker.stuckDoor.bay === index) {
          status.textContent = 'Board ' + address + ', door ' + (index + 1) + ' is stuck open.';
        } else if (locker.offlineBoards.has(address)) {
          status.textContent = 'Board ' + address + ' is offline.';
        } else {
          status.textContent = locker.powerOn
            ? 'Board ' + address + ', door ' + (index + 1) + ' is locked'
            : 'Power supplies off. Restore power to release a door.';
        }
      }
    }
    status.hidden = !status.textContent;
    renderCabinet(panel);
  });
  return button;
}

function makeModule(address, panel) {
  const {parts} = panel;
  const buttons = Array.from(bays, (code, index) => makeBay(address, code, index, panel));
  const module = document.createElement('div');
  module.className = 'module';
  const label = document.createElement('div');
  label.className = 'module-name';
  label.textContent = address;
  const doors = document.createElement('div');
  doors.className = 'module-doors';
  for (let bank = 0; bank < 2; bank++) {
    const side = document.createElement('div');
    side.className = 'bank';
    side.append(...buttons.slice(bank * 8, bank * 8 + 8));
    doors.append(side);
  }
  module.append(label, doors);
  parts.bays.append(module);
  const controller = document.createElement('button');
  controller.type = 'button';
  controller.className = 'controller';
  controller.dataset.board = address;
  controller.setAttribute('aria-label', 'Disable board ' + address);
  controller.textContent = address;
  controller.addEventListener('click', () => {
    const {locker} = panel;
    locker.setBoardOffline(address, !locker.offlineBoards.has(address));
    parts['door-status'].hidden = true;
    renderCabinet(panel);
  });
  parts['controller-deck'].append(controller);
  return [address, {buttons, module, controller}];
}

function bindFaultControls(panel) {
  const {parts} = panel;
  const delay = parts['reply-delay'];
  const board = parts['stuck-board'];
  const door = parts['stuck-door'];
  for (const address of boards) {
    board.add(new Option(address, address));
  }
  for (let bay = 0; bay < bays.length; bay++) door.add(new Option(String(bay + 1), String(bay)));

  function changeFault(mutator) {
    mutator(panel.locker);
    parts['door-status'].hidden = true;
    renderCabinet(panel);
  }
  delay.addEventListener('change', () => changeFault(locker => locker.setReplyDelay(Number(delay.value))));
  parts['apply-stuck'].addEventListener('click',
    () => changeFault(locker => locker.setStuckDoor(board.value, Number(door.value))));
  parts['clear-stuck'].addEventListener('click', () => changeFault(locker => locker.setStuckDoor(null)));
}

function makeCabinet(index) {
  const column = el('cabinet-template').content.firstElementChild.cloneNode(true);
  const parts = Object.fromEntries(Array.from(column.querySelectorAll('[data-part]'),
    element => [element.dataset.part, element]));
  const suffix = index + 1;
  const title = cabinetCount === 1 ? 'Locker cabinet' : 'Cabinet ' + suffix;
  parts.title.textContent = title;
  parts.connection.textContent = 'Locker port ' + suffix + ' · Boards A–E';
  parts.title.id = 'cabinet-title-' + suffix;
  column.querySelector('.cabinet').setAttribute('aria-labelledby', parts.title.id);

  parts['monitor-title'].id = 'monitor-title-' + suffix;
  column.querySelector('.monitor').setAttribute('aria-labelledby', parts['monitor-title'].id);
  parts.trace.setAttribute('aria-label', title + ' serial commands, replies and door events');

  const deck = parts['controller-deck'];
  const toggle = parts['service-toggle'];
  deck.id = 'controller-deck-' + suffix;
  toggle.setAttribute('aria-controls', deck.id);
  function setHatch(expanded) {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.firstElementChild.textContent = expanded ? 'Close service hatch' : 'Open service hatch';
    deck.hidden = !expanded;
  }
  toggle.addEventListener('click', () => setHatch(deck.hidden));
  parts['manage-boards'].addEventListener('click', () => {
    parts['fault-summary'].closest('details').open = false;
    setHatch(true);
    const first = deck.querySelector('.controller:not(:disabled)');
    (first || toggle).focus();
  });
  const panel = {
    parts,
    locker: new Locker(),
    channel: null,
    lastRelease: null,
    renderedEvent: null,
    paintPending: false,
  };
  panel.modules = Object.fromEntries(Array.from(boards, address => makeModule(address, panel)));
  parts['restore-power'].addEventListener('click', () => {
    const {channel, locker} = panel;
    if (!channel || locker.powerOn) return;
    channel.frames = new SerialFrames();
    locker.restorePower();
    parts['door-status'].hidden = true;
    renderCabinet(panel);
  });
  bindFaultControls(panel);
  el('cabinet-grid').append(column);
  return panel;
}

el('workspace').dataset.cabinets = cabinetCount;
el('cabinet-capacity').textContent = cabinetCount === 1
  ? '1 cabinet · 80 bays'
  : cabinetCount + ' cabinets · ' + cabinetCount * 80 + ' bays';
const panels = Array.from({length: cabinetCount}, (_, index) => makeCabinet(index));
if (!navigator.serial) help.textContent = 'Open this page in desktop Chrome or Edge with serial access enabled.';
connectButton.addEventListener('click', () => void connect());
renderConnection();
panels.forEach(renderCabinet);
