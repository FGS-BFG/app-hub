const install = document.getElementById('flash-device');
const status = document.getElementById('flash-status');
const model = install.dataset.model;
const filePrefix = model === 'Screenless' ? 'FGS-Toolkit-Headless-' : 'FGS-Toolkit-';
let selectedRelease;

async function prepare() {
  if (!navigator.usb) {
    status.textContent = 'Use desktop Chrome or Edge to install over USB.';
    return;
  }
  try {
    const manifestUrl = new URL(install.dataset.manifest, import.meta.url);
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw Error();
    const release = await response.json();
    if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256)
        || release.filename !== (filePrefix + release.version + '.uf2')) throw Error();
    selectedRelease = release;
    install.disabled = false;
  } catch {
    status.textContent = 'The release could not be loaded. Reload the page to try again.';
  }
}

install.addEventListener('click', async () => {
  if (!selectedRelease) return;
  install.disabled = true;
  let device;
  try {
    status.textContent = 'Select RP2 Boot in the USB chooser.';
    device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x2e8a, productId: 0x0003 }] });
    if (!confirm('Install ' + model + ' firmware v' + selectedRelease.version + ' on the selected Pico?')) {
      status.textContent = 'Installation cancelled.';
      return;
    }
    status.textContent = 'Checking the firmware download…';
    const { loadFirmware, installFirmware } = await import('./flash.mjs');
    const url = new URL('./releases/' + selectedRelease.filename, import.meta.url);
    const firmware = await loadFirmware(url, selectedRelease.sha256);
    const restarted = await installFirmware(device, firmware, message => { status.textContent = message; });
    status.textContent = restarted
      ? 'Firmware written and verified. The Tool Kit is restarting.'
      : 'Firmware written and verified. Reconnect the Tool Kit if it does not restart.';
  } catch (error) {
    status.textContent = !device && error.name === 'NotFoundError'
      ? 'Put the Tool Kit into update mode, then choose RP2 Boot.'
      : (error.message || 'The direct USB install failed.') + ' You can also download the UF2 and copy it to RPI-RP2.';
  } finally {
    install.disabled = false;
  }
});

void prepare();
