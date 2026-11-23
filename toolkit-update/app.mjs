const toolkit = { usbVendorId: 0xcafe, usbProductId: 0x4065 };
const versionReply = /^FGS-TOOLKIT VERSION=(\d+\.\d+\.\d+)$/;
const legacyReply = /^FGS-TOOLKIT OLED=[0-9a-f]{2} PORTS=4$/i;

export async function readInstalledFirmware(port, timeout = 1400) {
  await port.open({ baudRate: 115200 });
  let reader;
  let writer;
  let timer;

  try {
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    timer = setTimeout(() => void reader.cancel().catch(() => {}), timeout);

    // New firmware answers ?version first. The original multi-COM build
    // ignores that command and answers the read-only ?status probe instead.
    await writer.write(new TextEncoder().encode('\n?version\n?status\n'));
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('No Tool Kit reply. Try its Browser bridge COM port.');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop().slice(-512);

      for (const raw of lines) {
        const line = raw.trim();
        const match = versionReply.exec(line);
        if (match) return { version: match[1] };
        if (legacyReply.test(line)) return { version: null };
      }
    }
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

export function compareVersions(installed, latest) {
  const a = installed.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

function initialisePage() {
  const byId = id => document.getElementById(id);
  const check = byId('check');
  const status = byId('connection-status');
  const initialHelp = status.textContent;
  let release = null;
  let installed = null;

  function showResult() {
    if (!installed) return;
    const { version } = installed;
    byId('installed').textContent = version ? 'v' + version : 'Earlier firmware';
    if (!version) {
      status.textContent = 'Tool Kit detected. This firmware does not report a version. Use the two-button shortcut for the first update.';
    } else if (!release) {
      status.textContent = 'Installed version checked. The latest version is currently unavailable.';
    } else {
      const order = compareVersions(version, release.version);
      status.textContent = order === 0 ? 'Your Tool Kit is up to date.'
        : order < 0 ? 'An update is available.'
          : 'Your Tool Kit is running a newer version than this release.';
    }
  }

  async function loadRelease() {
    try {
      const response = await fetch('./release.json?v=public-uf2', { cache: 'no-store' });
      if (!response.ok) throw new Error('Release lookup failed');
      const data = await response.json();
      if (!/^\d+\.\d+\.\d+$/.test(data.version) || !/^[a-f0-9]{64}$/.test(data.sha256)
        || data.filename !== ('FGS-Toolkit-' + data.version + '.uf2')
        || data.download !== ('./releases/' + data.filename)) throw new Error('Invalid release data');
      release = data;

      byId('latest').textContent = 'v' + release.version;
      byId('release-summary').textContent = release.summary;
      byId('download').href = release.download;
      byId('download').hidden = false;
      byId('filename').textContent = release.filename;
      byId('checksum').textContent = release.sha256;
      byId('version-details').hidden = false;
      showResult();
    } catch {
      byId('latest').textContent = 'Unavailable';
      byId('release-summary').textContent = 'The release information could not be loaded. Reload the page to try again.';
    }
  }

  void loadRelease();
  if (!navigator.serial) {
    status.textContent = 'Open this page in desktop Chrome or Edge to check the version over USB.';
    return;
  }

  check.disabled = false;
  check.addEventListener('click', async () => {
    check.disabled = true;
    let port;
    try {
      status.textContent = 'Choose the Tool Kit’s Browser bridge COM port.';
      port = await navigator.serial.requestPort({ filters: [toolkit] });
      installed = null;
      byId('installed').textContent = 'Checking…';
      status.textContent = 'Reading the installed firmware version.';
      installed = await readInstalledFirmware(port);
      showResult();
    } catch (error) {
      if (!port && error.name === 'NotFoundError') {
        status.textContent = initialHelp;
        showResult();
      } else {
        installed = null;
        byId('installed').textContent = 'Unknown';
        status.textContent = port && error.message.startsWith('No Tool Kit reply')
          ? error.message
          : 'Could not open the Tool Kit port. Close other tabs or apps using it and try again.';
      }
    } finally {
      check.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') initialisePage();
