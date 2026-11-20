import {Locker, SerialFrames, bays} from './model.js?v=cabinet-monitors';

const el = id => document.getElementById(id);
const connectButton = el('connect');
const help = el('connection-help');
const encoder = new TextEncoder();
const selectedCount = new URLSearchParams(location.search).get('cabinets');
const cabinetCount = /^[1-4]$/.test(selectedCount ?? '') ? Number(selectedCount) : 1;
const createLocker = () => new Locker(undefined, undefined, cabinetCount);
let locker = createLocker();
let bridge = null;
let opening = false;
let renderedEvent = null;
let paintPending = false;

function update() {
  if (!paintPending) {
    paintPending = true;
    requestAnimationFrame(() => {
      paintPending = false;
      render();
    });
  }
}

class Pico {
  constructor(port) {
    this.port = port;
    this.frames = new SerialFrames();
    this.pending = '';
    this.outgoing = Promise.resolve();
  }

  async open() {
    await this.port.open({baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none'});
    this.portOpen = true;
    await this.port.setSignals({dataTerminalReady: true, requestToSend: false});
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.pump = this.read();
    try {
      for (let attempt = 0; attempt < 5 && !this.ready; attempt++) {
        await this.writer.write(encoder.encode('\n?\n'));
        await new Promise(resolve => setTimeout(resolve, 250));
        if (this.failure) throw this.failure;
      }
      if (!this.ready) throw Error('The Pico did not answer. Choose the other Pico COM port or close any cabinet already using it.');
      this.timer = setInterval(() => {
        this.writeReply(locker.tick());
        if (locker.events.at(-1) !== renderedEvent) update();
      }, 30);
    } catch (error) {
      await this.close();
      throw error;
    }
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
          if (line === 'MCI304-USB-1') {
            this.ready = true;
          } else if (this.ready && line === '!write') {
            throw Error('The Pico could not deliver a reply. Reconnect both apps.');
          } else if (this.ready && locker.powerOn && /^>(?:[\da-f]{2})+$/i.test(line)) {
            const bytes = line.slice(1).match(/../g);
            const data = String.fromCharCode(...bytes.map(byte => parseInt(byte, 16)));
            for (const frame of this.frames.feed(data)) {
              this.writeReply(locker.tick() + locker.command(frame));
              update();
            }
          }
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

  writeReply(reply) {
    if (!reply || this.closing || !locker.powerOn) return;
    const frames = this.frames;
    this.outgoing = this.outgoing.then(async () => {
      for (let offset = 0; offset < reply.length; offset += 64) {
        if (this.closing || !locker.powerOn || frames !== this.frames) return;
        const hex = Array.from(reply.slice(offset, offset + 64), byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
        await this.writer.write(encoder.encode('<' + hex + '\n'));
      }
    }).catch(error => {
      if (!this.closing && bridge === this) void disconnect(error.message);
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

async function disconnect(message = 'Disconnected. Connect the Pico to restart the cabinet.') {
  const current = bridge;
  bridge = null;
  opening = true;
  await current?.close();
  help.textContent = message;
  opening = false;
  render();
}

async function connect() {
  if (bridge) {
    await disconnect();
    return;
  }
  if (opening) return;
  opening = true;
  render();
  let candidate;
  try {
    const port = await navigator.serial.requestPort({filters: [{usbVendorId: 0x239a, usbProductId: 0x80f4}]});
    candidate = new Pico(port);
    locker = createLocker();
    for (const panel of panels) {
      panel.lastRelease = null;
      panel.parts['door-status'].hidden = true;
    }
    await candidate.open();
    bridge = candidate;
    help.textContent = 'Use the other Pico COM port in the locker app. Click an energised door to open it. Click again to close it.';
  } catch (error) {
    await candidate?.close();
    if (error.name !== 'NotFoundError') help.textContent = error.message;
  } finally {
    opening = false;
    render();
  }
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

function render() {
  connectButton.disabled = opening || !navigator.serial;
  connectButton.textContent = bridge ? 'Disconnect' : 'Connect Pico';
  el('connection').textContent = bridge ? 'Pico connected' : opening ? 'Connecting' : 'Pico disconnected';
  renderedEvent = locker.events.at(-1);
  const active = locker.activeLockCount;
  const status = locker.powerOn ? 'Power supplies on' : 'Power supplies off';
  const count = locker.powerOn
    ? active + (active === 1 ? ' lock energised' : ' locks energised')
    : locker.tripCount + ' locks at cutoff · serial offline';
  panels.forEach((panel, index) => {
    renderTrace(panel, locker.cabinetEvents[index]);
    renderCabinet(panel, status, count);
  });
}

function renderCabinet({parts, modules, lastRelease}, status, count) {
  parts.cabinet.dataset.power = locker.powerOn;
  parts['power-panel'].dataset.on = locker.powerOn;
  if (parts['power-status'].textContent !== status) parts['power-status'].textContent = status;
  if (parts['active-lock-count'].textContent !== count) parts['active-lock-count'].textContent = count;
  parts['restore-power'].hidden = locker.powerOn;
  parts['restore-power'].disabled = !bridge;
  const release = parts['last-release'];
  const label = lastRelease
    ? 'Last release request · Board ' + lastRelease.board + ', door ' + (lastRelease.bay + 1)
      + (lastRelease.powered ? '' : ' · no coil power')
    : 'No lock release recorded';
  if (release.textContent !== label) release.textContent = label;
  for (const [address, buttons] of Object.entries(modules)) {
    const board = locker.boards[address];
    buttons.forEach((button, index) => {
      const open = Boolean(board.opened & (1 << index));
      const active = locker.coilActive(address, index);
      button.dataset.open = open;
      button.dataset.active = active;
      button.dataset.recent = lastRelease?.board === address && lastRelease.bay === index;
      const name = 'Board ' + address + ', door ' + (index + 1) + ' · ' + (open ? 'open' : 'closed')
        + (active ? ' · lock energised' : '');
      button.setAttribute('aria-label', name);
      button.title = name;
    });
  }
}

function makeBay(address, code, index, status) {
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
    status.textContent = '';
    if (!bridge) {
      status.textContent = 'Connect the Pico first';
    } else {
      bridge.writeReply(locker.tick());
      if (!locker.move(address, index)) {
        status.textContent = locker.powerOn
          ? 'Board ' + address + ', door ' + (index + 1) + ' is locked'
          : 'Power supplies off. Restore power to release a door.';
      }
    }
    status.hidden = !status.textContent;
    render();
  });
  return button;
}

function makeModule(address, parts) {
  const buttons = Array.from(bays, (code, index) => makeBay(address, code, index, parts['door-status']));
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
  const controller = document.createElement('div');
  controller.className = 'controller';
  controller.textContent = address;
  parts['controller-deck'].append(controller);
  return [address, buttons];
}

function makeCabinet(group, index) {
  const column = el('cabinet-template').content.firstElementChild.cloneNode(true);
  const parts = Object.fromEntries(Array.from(column.querySelectorAll('[data-part]'),
    element => [element.dataset.part, element]));
  const suffix = index + 1;
  const title = cabinetCount === 1 ? 'Locker cabinet' : 'Cabinet ' + suffix;
  parts.title.textContent = title + ' · Boards ' + group[0] + '–' + group.at(-1);
  parts.title.id = 'cabinet-title-' + suffix;
  column.querySelector('.cabinet').setAttribute('aria-labelledby', parts.title.id);

  parts['monitor-title'].id = 'monitor-title-' + suffix;
  column.querySelector('.monitor').setAttribute('aria-labelledby', parts['monitor-title'].id);
  parts.trace.setAttribute('aria-label', title + ' serial commands, replies and door events');

  const deck = parts['controller-deck'];
  const toggle = parts['service-toggle'];
  deck.id = 'controller-deck-' + suffix;
  toggle.setAttribute('aria-controls', deck.id);
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.firstElementChild.textContent = expanded ? 'Open service hatch' : 'Close service hatch';
    deck.hidden = expanded;
  });
  parts['restore-power'].addEventListener('click', () => {
    if (!bridge || locker.powerOn) return;
    bridge.frames = new SerialFrames();
    bridge.pending = '';
    locker.restorePower();
    for (const panel of panels) panel.parts['door-status'].hidden = true;
    render();
  });

  const panel = {
    parts,
    modules: Object.fromEntries(Array.from(group, address => makeModule(address, parts))),
    lastRelease: null,
    renderedEvent: null,
  };
  el('cabinet-grid').append(column);
  return panel;
}

el('workspace').dataset.cabinets = cabinetCount;
el('cabinet-capacity').textContent = cabinetCount === 1
  ? '1 cabinet · 80 bays'
  : cabinetCount + ' cabinets · ' + cabinetCount * 80 + ' bays';
const panels = locker.cabinets.map(makeCabinet);
connectButton.addEventListener('click', connect);
if (!navigator.serial) help.textContent = 'Open this page in desktop Chrome or Edge with serial access enabled.';
render();
