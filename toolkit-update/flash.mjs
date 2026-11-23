import { Picoboot } from './vendor/picoflash-v0.1.5/picoboot.js';

const flashStart = 0x10000000;
const flashSize = 2 * 1024 * 1024;
const pageSize = 256;
const sectorSize = 4096;
const blockSize = 512;
export const bootDevice = { vendorId: 0x2e8a, productId: 0x0003 };

export function decodeFirmware(buffer) {
  const count = buffer.byteLength / blockSize;
  if (!Number.isInteger(count) || count < 1 || count * pageSize > flashSize) {
    throw Error('Invalid Tool Kit UF2 size.');
  }
  const firmware = new Uint8Array(count * pageSize);
  const seen = new Uint8Array(count);
  const view = new DataView(buffer);
  for (let offset = 0; offset < buffer.byteLength; offset += blockSize) {
    const word = index => view.getUint32(offset + index * 4, true);
    const page = (word(3) - flashStart) / pageSize;
    if (word(0) !== 0x0a324655 || word(1) !== 0x9e5d5157 || word(2) !== 0x2000
        || word(4) !== pageSize || word(5) !== page || word(6) !== count
        || word(7) !== 0xe48bff56 || word(127) !== 0x0ab16f30
        || !Number.isInteger(page) || page < 0 || page >= count || seen[page]) {
      throw Error('This file is not a supported Tool Kit RP2040 image.');
    }
    seen[page] = 1;
    firmware.set(new Uint8Array(buffer, offset + 32, pageSize), page * pageSize);
  }
  return firmware;
}

export async function loadFirmware(url, checksum) {
  const response = await fetch(url);
  if (!response.ok) throw Error('Could not download the firmware.');
  const buffer = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== checksum) throw Error('Firmware checksum mismatch.');
  return decodeFirmware(buffer);
}

export async function installFirmware(device, firmware, report, openPico = Picoboot.fromDevice) {
  if (device.vendorId !== bootDevice.vendorId || device.productId !== bootDevice.productId) {
    throw Error('Choose an RP2040 Boot device in update mode.');
  }

  const pico = openPico(device);
  let connection;
  let exclusive = false;
  let restarted = false;
  try {
    report('Connecting to the Pico bootloader…');
    connection = await pico.connect();
    await connection.setExclusiveAccess(1);
    exclusive = true;
    await connection.exitXip();

    report('Writing firmware. Keep the Tool Kit plugged in.');
    await connection.flashErase(flashStart, Math.ceil(firmware.length / sectorSize) * sectorSize);
    await connection.flashWrite(flashStart, firmware);

    report('Verifying the firmware on the device…');
    const actual = await connection.flashRead(flashStart, firmware.length);
    if (actual.length !== firmware.length || actual.some((byte, index) => byte !== firmware[index])) {
      throw Error('Flash verification failed. Try installing again before restarting.');
    }

    try {
      await connection.reboot(500);
      restarted = true;
    } catch {
      // The firmware already passed read-back. The device may have disconnected to restart.
    }
    return restarted;
  } finally {
    if (exclusive && !restarted && device.opened) {
      await connection.setExclusiveAccess(0).catch(() => {});
    }
    await pico.disconnect();
    if (device.opened) await device.close().catch(() => {});
  }
}
