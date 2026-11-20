export const boards = 'ABCDE';
const cabinetGroups = [boards, 'FGHIJ', 'KLMNO', 'PQRST'];

export function cabinetBoards(count = 1) {
  return cabinetGroups.slice(0, Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1);
}

export const bays = '0123456789ABCDEF';
const lockLimit = 4;
const firmware = 'Firmware : MCi_304-Fw1.5.9fs';
const directWrite = /^([WP][\s\S]{2})(?:#([A-Z]))?$/;
const routed = /^([^#]+)(?:#([A-Z]))?$/;
const durations = {
  'DR-': [600, 1, 'Locks Manual'], DR0: [600, 1, 'Locks Manual'],
  'DR+': [3000, 5, 'Locks Auto'], DR1: [3000, 5, 'Locks Auto 3 seconds'],
  DR2: [6000, 10, 'Locks Auto 6 seconds'], DR3: [12000, 18, 'Locks Auto 12 seconds'],
  DR4: [24000, 36, 'Locks Auto 24 seconds'],
};
const speeds = { DRA: [8, 1], DRB: [4, 2], DRC: [2, 4] };
const modeReplies = {
  CMA: 'Port A', CMB: 'Port B', 'CM>': 'Output-Inverted', 'CM<': 'Output-Normal',
  'CM.': 'Reversed-Output', 'CM,': 'Normal-Output', CMS: 'Sensor Events:ON', CME: 'Sensor Events:OFF',
};

const binary = (word, width = 8) => word.toString(2).padStart(width, '0');
const hex = (word, width = 2) => word.toString(16).toUpperCase().padStart(width, '0');
const wordBytes = word => String.fromCharCode(word >> 8, word & 255);
const setting = word => hex(word) + ' : ' + binary(word);
const lockWord = board => 'Lock Word:' + binary(board.outputs, 16);
const visible = text => text.replace(/[\x00-\x1f\x7f-\xff\\]/g, char => {
  if (char === '\r') return '\\r';
  if (char === '\n') return '\\n';
  if (char === '\\') return '\\\\';
  return '\\x' + hex(char.charCodeAt(0)).toLowerCase();
});

class Board {
  opened = 0;
  outputs = 0;
  directInputs = 0;
  directOutputs = 0x1C00;
  speed = 8;
  duration = durations.DR1;
  verbose = false;
  locksEnabled = true;
  clearAt = null;
  resetAt = null;
  resetPowerAt = null;
  heartbeatAt = null;
  diagnosticAt = null;
  diagnosticBay = 0;

  latch(value) {
    this.outputs = value;
    this.directOutputs = (this.directOutputs & 0xFF00) | 0x0C00 | (value >> 8);
  }

  clear() {
    this.latch(0);
    this.clearAt = null;
    this.diagnosticAt = null;
  }
}

export class Locker {
  constructor(clock = () => performance.now(), master = 'C', cabinetCount = 1) {
    this.clock = clock;
    this.master = master;
    this.started = clock();
    this.cabinets = cabinetBoards(cabinetCount);
    this.boards = Object.fromEntries(Array.from(this.cabinets.join(''), address => [address, new Board()]));
    this.events = [];
    this.powerOn = true;
    this.tripCount = null;
    const cabinetStatus = this.cabinets.length === 1 ? 'Cabinet ready' : this.cabinets.length + ' cabinets ready';
    this.event('SYSTEM', cabinetStatus + '. All ' + Object.keys(this.boards).length * bays.length + ' doors are closed.');
  }

  event(kind, message) {
    const time = ((this.clock() - this.started) / 1000).toFixed(2).padStart(6, '0');
    this.events.push({time, kind, message});
    if (this.events.length > 180) this.events.shift();
  }

  reply(address, body) {
    return '<' + address + '>' + body + (address === this.master ? '' : '~') + '\n\r';
  }

  get activeLockCount() {
    let count = 0;
    for (const board of Object.values(this.boards)) {
      for (let mask = board.outputs; mask; mask &= mask - 1) count++;
    }
    return count;
  }

  restorePower() {
    if (this.powerOn) return;
    for (const address of Object.keys(this.boards)) {
      const opened = this.boards[address].opened;
      this.boards[address] = new Board();
      this.boards[address].opened = opened;
    }
    this.tripCount = null;
    this.powerOn = true;
    this.event('POWER', 'Power supplies restored · serial online');
  }

  coilActive(address, bay) {
    return this.powerOn && Boolean(this.boards[address].outputs & (1 << bay));
  }

  move(address, bay) {
    const board = this.boards[address];
    const mask = 1 << bay;
    const opened = !(board.opened & mask);
    const label = 'Bay ' + address + '/' + bays[bay];
    if (opened && !this.coilActive(address, bay)) {
      const reason = this.powerOn ? 'coil has no drive' : 'power supplies are off';
      this.event('FAULT', label + ' · door stayed closed, ' + reason);
      return false;
    }
    board.opened ^= mask;
    const doorState = opened ? ' opened' : ' closed';
    const sensorState = this.powerOn ? ' · sensor bit ' + Number(opened) : ' · controller offline';
    this.event('DOOR', label + doorState + sensorState);
    return true;
  }

  command(raw) {
    if (!this.powerOn) return '';
    this.event('TX', visible(raw + '\r'));
    const match = directWrite.exec(raw) || routed.exec(raw);
    const body = match?.[1] ?? raw;
    const address = match?.[2] ?? this.master;
    const board = this.boards[address];
    if (!board) {
      this.event('FAULT', 'No reply · check controller address');
      return '';
    }
    const result = this.execute(board, address, body, Boolean(match?.[2]));
    const active = this.activeLockCount;
    if (active > lockLimit) {
      this.tripCount = active;
      this.powerOn = false;
      for (const linked of Object.values(this.boards)) linked.clear();
      this.event('POWER', 'Power supplies off · ' + active + ' locks energised · serial offline');
      return '';
    }
    this.event('RX', result ? visible(result) : 'No acknowledgement');
    return result;
  }

  execute(board, address, body, addressed) {
    const line = text => this.reply(address, text);
    const say = text => board.verbose ? line(text) : '';
    const short = !addressed;
    if (short && body === 'LC') {
      for (const [target, linked] of Object.entries(this.boards)) {
        if (linked.outputs) this.event('BOARD', 'Board ' + target + ' · both lock banks cleared');
        linked.clear();
      }
      return say(lockWord(board));
    }
    if (body === 'GFV') return line(firmware);
    if (body === 'LRS') return line(lockWord(board));
    if (body === 'ISC') {
      return [
        'System Configuration', '- Responses: ' + (board.verbose ? 'ON' : 'OFF'),
        '- Locks Fnt: ' + (board.locksEnabled ? 'ON' : 'OFF'), '- Board  ID: ' + setting(address.charCodeAt(0)),
        '- Timer DRx: ' + setting(board.duration[1]), '- Heartbeat: ' + setting(board.speed),
      ].map(line).join('');
    }
    if (body === 'ISB' || body === 'ISH') {
      const format = body === 'ISB' ? binary : hex;
      const type = body === 'ISB' ? 'BIN' : 'HEX';
      return line('Ex(' + type + '):' + format(board.opened >> 8) + ':' + format(board.opened & 255));
    }
    if (body === 'ISS') return line('Sensor:' + binary(board.directInputs >> 8));
    if (/^IS.$/.test(body)) return line("Error 'ISx' type:");
    if (body === 'LAX' || body === 'LMX' || (short && body === 'OP')) {
      if (board.outputs) this.event('BOARD', 'Board ' + address + ' · both lock banks cleared');
      board.clear();
      return body === 'OP' ? say(lockWord(board)) : '';
    }
    if (short && body === 'PT') {
      board.directOutputs &= 0xF000;
      return say('Port Byte:00000000');
    }
    if (body === 'CM!' || body === 'CM"') {
      board.verbose = body === 'CM!';
      return say('Response Mode');
    }
    if (body === 'CM(' || body === 'CM)') {
      board.locksEnabled = body === 'CM(';
      return say('Lock Events:' + (board.locksEnabled ? 'ON' : 'OFF'));
    }
    if (Object.hasOwn(modeReplies, body)) return say(modeReplies[body]);
    if (/^CM.$/.test(body)) return line("Error 'CMx' range:");
    if (Object.hasOwn(durations, body)) {
      board.duration = durations[body];
      return say(board.duration[2]);
    }
    if (Object.hasOwn(speeds, body)) {
      board.speed = speeds[body][0];
      return say('Pulse ' + speeds[body][1] + ' per seconds');
    }
    if (/^DR.$/.test(body)) return line("Error 'DRx' range:");
    if (/^HB.$/.test(body)) {
      if (address !== this.master) return line('REMOTE Heartbeat NOT available:');
      const seconds = {HB0: 0, HB1: 3, HB2: 6, HB3: 12}[body];
      if (seconds === undefined) return line("Error 'HBx' range:");
      board.heartbeatAt = seconds ? this.clock() + seconds * 1000 * board.speed / 8 : null;
      return say(seconds ? 'Heartbeat ' + seconds + ' Seconds' : 'Heartbeat Check Cancelled');
    }
    if (body === 'RST') {
      board.resetPowerAt = this.clock() + 1800 * board.speed / 8;
      board.resetAt = board.resetPowerAt + 3000;
      return line((address === this.master ? 'SYSTEM' : 'REMOTE') + '_Reset in 5 seconds...');
    }
    if (body === 'DST') {
      board.clear();
      board.duration = durations.DR1;
      board.diagnosticBay = 0;
      board.latch(1);
      board.diagnosticAt = this.clock() + 3000;
      return line('Diagnostic Self-Test.... In progress');
    }
    const single = /^L([AM])([0-9A-F])$/.exec(body);
    const pair = addressed && /^A([AM])([0-7X])([0-7X])$/.exec(body);
    if (single || pair) {
      if (!board.locksEnabled) return line('Lock Events Deactivated');
      const before = board.outputs;
      const mask = single ? 1 << bays.indexOf(single[2])
        : (pair[2] === 'X' ? 0 : 1 << Number(pair[2])) | (pair[3] === 'X' ? 0 : 1 << (8 + Number(pair[3])));
      board.latch(single ? before | mask : mask);
      for (let index = 0; index < 16; index++) {
        if (mask & (1 << index)) {
          this.event('BOARD', address + '/' + bays[index] + ' · output latched · coil '
            + (this.coilActive(address, index) ? 'energised' : 'de-energised'));
        }
      }
      if ((single || pair)[1] === 'A') board.clearAt = this.clock() + board.duration[0] * board.speed / 8;
      return say(lockWord(board)) + say('Lock Active');
    }
    if (body.length === 3 && /^(W|P|S|RI|RO|TI|TO)/.test(body)) return this.directIo(board, address, body);
    if (body.length === 1) return line('Command Error:');
    return line(address === this.master ? "Unknown 'LOCAL' Command:" : "Unknown 'REMOTE' Command:");
  }

  directIo(board, address, body) {
    const line = text => this.reply(address, text);
    const kind = body.slice(0, 2);
    const param = body[2];
    if (body[0] === 'W' || body[0] === 'P') {
      board.directOutputs = (board.directOutputs & 0xF000) | ((body.charCodeAt(1) & 15) << 8) | body.charCodeAt(2);
      if (body[0] === 'P') return line('RiW:' + wordBytes(board.directInputs));
      return board.verbose ? line('Ok:WR') : '';
    }
    if (kind === 'RI' || kind === 'RO') {
      const input = kind === 'RI';
      const word = input ? board.directInputs : board.directOutputs;
      const label = (input ? 'Ri' : 'Ro') + param + ':';
      if (param === 'W') return line(label + wordBytes(word));
      if (param === 'H') return line(label + hex(word, 4));
      if (param === 'B') return line(label + binary(word, 16));
      return line(label + '<' + address + '>Parameter Error');
    }
    if (body[0] === 'S') {
      const bit = bays.indexOf(body[1]);
      if (bit < 0 || bit > 12) return line("Error 'Sbx' range:");
      const enabled = param === '1';
      board.directOutputs = enabled ? board.directOutputs | (1 << bit) : board.directOutputs & ~(1 << bit);
      return line('Sb' + body[1] + ':' + Number(enabled));
    }
    const bit = bays.indexOf(param);
    const input = kind === 'TI';
    if (bit < 0 || bit > (input ? 14 : 12)) return line("Error '" + kind + "x' range:");
    const word = input ? board.directInputs : board.directOutputs;
    return line((input ? 'Ti' : 'To') + param + ':' + ((word >> bit) & 1));
  }

  tick() {
    if (!this.powerOn) return '';
    let replies = '';
    const now = this.clock();
    for (const [address, board] of Object.entries(this.boards)) {
      const publish = text => {
        const reply = this.reply(address, text);
        this.event('RX', visible(reply));
        replies += reply;
      };
      if (board.resetPowerAt !== null && now >= board.resetPowerAt) {
        board.clear();
        board.resetPowerAt = null;
        board.directOutputs &= ~0x1000;
      }
      if (board.resetAt !== null && now >= board.resetAt) {
        board.clear();
        board.resetAt = null;
        board.duration = durations.DR1;
        board.speed = 8;
        board.verbose = false;
        board.locksEnabled = true;
        board.directOutputs |= 0x1000;
        publish(firmware);
        if (address === this.master) {
          for (const text of [
            'Board  ID : ' + hex(address.charCodeAt(0)), 'Timer DRx : 05', 'Heartbeat : 08',
            'Lock Auto : 3 seconds', 'Lock Event: ON', 'Responses : Quiet Mode',
          ]) publish(text);
        } else {
          publish('REMOTE_Reset Done');
        }
      }
      if (board.clearAt !== null && now >= board.clearAt) {
        board.clear();
        this.event('BOARD', 'Board ' + address + ' · automatic timeout cleared both lock banks');
        if (board.verbose) publish(address === this.master ? 'LOCAL_Lock Done' : 'REMOTE_Lock Done');
      }
      if (board.heartbeatAt !== null && now >= board.heartbeatAt) {
        board.heartbeatAt = null;
        publish('Heartbeat TimeOut....');
        publish('Host POWER RESET in progress ....');
      }
      if (board.diagnosticAt !== null && now >= board.diagnosticAt) {
        board.diagnosticBay++;
        if (board.diagnosticBay === 16) {
          board.clear();
          publish('Diagnostic Self-Test.... Completed');
        } else {
          board.latch(1 << board.diagnosticBay);
          board.diagnosticAt += 3000;
        }
      }
    }
    return replies;
  }
}

export class SerialFrames {
  pending = '';
  discard = false;

  feed(data) {
    const frames = [];
    for (const char of data) {
      if (char === '\r') {
        if (this.pending && !this.discard
            && (directWrite.test(this.pending) || /^[\x21-\x7e]+$/.test(this.pending))) frames.push(this.pending);
        this.pending = '';
        this.discard = false;
      } else if (!this.discard && ((char !== '\x00' && char !== '\n')
          || (/^[WP]/.test(this.pending) && this.pending.length < 3))) {
        if (this.pending.length === 32) this.discard = true;
        else this.pending += char;
      }
    }
    return frames;
  }
}
