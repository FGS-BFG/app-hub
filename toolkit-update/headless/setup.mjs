const versionLine = /^FGS-TOOLKIT VERSION=(\d+\.\d+\.\d+) VARIANT=HEADLESS$/;
const wrongPort = 'FGS-TOOLKIT USE-SETUP-PORT';
const bootReply = 'FGS-TOOLKIT BOOTSEL';
const busyReply = 'FGS-TOOLKIT BUSY';

export async function talkToSetupPort(port, update = false, timeout = 1600) {
  await port.open({ baudRate: 115200 });
  let reader;
  let writer;
  let timer;
  try {
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    timer = setTimeout(() => void reader.cancel().catch(() => {}), timeout);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '';

    async function query(command, accept) {
      await writer.write(encoder.encode(command));
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === wrongPort) throw Error('Choose the Setup / Firmware COM port.');
          if (accept(line)) return line;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw Error('The setup port did not reply. Check which COM port you selected.');
        buffer = (buffer + decoder.decode(value, { stream: true })).slice(-512);
      }
    }

    const version = versionLine.exec(await query('\n?version\n', line => versionLine.test(line)))[1];
    if (update) {
      const reply = await query('?bootsel\n', line => line === bootReply || line === busyReply);
      if (reply === busyReply) throw Error('Close the locker or RGB emulator session first and try again.');
    }
    return version;
  } finally {
    clearTimeout(timer);
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (writer) writer.releaseLock();
    await port.close().catch(() => {});
  }
}

function initialise() {
  const el = id => document.getElementById(id);
  const check = el('check');
  const boot = el('boot');
  const status = el('status');
  let setupPort;
  let release;
  let installed;

  function reportVersion() {
    el('installed').textContent = 'v' + installed;
    status.textContent = installed === release?.version
      ? 'Your screenless Tool Kit is up to date.'
      : release ? 'Setup port verified. The latest release is v' + release.version + '.' : 'Setup port verified.';
  }

  async function loadRelease() {
    try {
      const response = await fetch('./release.json', { cache: 'no-store' });
      if (!response.ok) throw Error();
      const data = await response.json();
      if (!/^\d+\.\d+\.\d+$/.test(data.version) || !/^[a-f0-9]{64}$/.test(data.sha256)
          || data.filename !== ('FGS-Toolkit-Headless-' + data.version + '.uf2')) throw Error();
      release = data;
      el('latest').textContent = 'v' + release.version;
      el('download').href = '../releases/' + release.filename;
      el('download').hidden = false;
      el('checksum').textContent = release.sha256;
      el('release-details').hidden = false;
      if (installed) reportVersion();
    } catch {
      el('latest').textContent = 'Unavailable';
    }
  }

  void loadRelease();
  if (!navigator.serial) {
    status.textContent = 'Open this page in desktop Chrome or Edge to use the setup port.';
    return;
  }

  check.disabled = false;
  check.addEventListener('click', async () => {
    check.disabled = true;
    boot.disabled = true;
    setupPort = null;
    installed = null;
    el('installed').textContent = 'Unknown';
    try {
      const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0xcafe, usbProductId: 0x4066 }] });
      status.textContent = 'Checking the selected port.';
      installed = await talkToSetupPort(port);
      setupPort = port;
      reportVersion();
    } catch (error) {
      status.textContent = error.name === 'NotFoundError' ? 'Choose the Setup / Firmware COM port to check the version.' : error.message;
    } finally {
      check.disabled = false;
      boot.disabled = !setupPort;
    }
  });

  boot.addEventListener('click', async () => {
    if (!setupPort || !confirm('Restart the screenless Tool Kit in firmware update mode?')) return;
    check.disabled = boot.disabled = true;
    try {
      await talkToSetupPort(setupPort, true);
      status.textContent = 'Update mode requested. Click Install over USB and choose RP2 Boot.';
      el('installed').textContent = 'Update mode';
      setupPort = null;
      installed = null;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      check.disabled = false;
      boot.disabled = !setupPort;
    }
  });
}

if (typeof document !== 'undefined') initialise();
