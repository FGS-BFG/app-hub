export class PortWatch {
  constructor(serial, onChange) {
    this.serial = serial;
    this.onChange = onChange;
    this.revision = 0;
    this.listed = new Set();
    this.listener = event => this.observe(event.port ?? event.target, event.type === 'connect', 'USB event');
  }

  start() {
    this.serial.addEventListener('connect', this.listener);
    this.serial.addEventListener('disconnect', this.listener);
    this.timer = setInterval(() => this.scan(), 750);
  }

  stop() {
    clearInterval(this.timer);
    this.serial.removeEventListener('connect', this.listener);
    this.serial.removeEventListener('disconnect', this.listener);
    this.port = null;
    this.revision++;
  }

  select(port) {
    this.port = port;
    this.present = port.connected !== false;
    this.listed.add(port);
    this.revision++;
  }

  observe(port, present, source) {
    const seen = this.listed.has(port);
    if (present) this.listed.add(port);
    else this.listed.delete(port);
    if (!this.port) return;
    if (port === this.port) {
      if (present === this.present) return;
      this.present = present;
      this.revision++;
      this.onChange({type: present ? 'attached' : 'removed', source});
    } else if (present && !seen && !this.present) {
      const selected = this.port.getInfo?.();
      const candidate = port.getInfo?.();
      if (selected?.usbVendorId !== undefined && selected?.usbProductId !== undefined &&
          selected.usbVendorId === candidate?.usbVendorId && selected.usbProductId === candidate?.usbProductId) {
        this.onChange({type: 'candidate', source});
      }
    }
  }

  async scan() {
    if (!this.port || this.scanning || !this.serial.getPorts) return;
    this.scanning = true;
    const port = this.port;
    const revision = this.revision;
    try {
      const ports = await this.serial.getPorts();
      if (revision !== this.revision) return;
      this.observe(port, typeof port.connected === 'boolean' ? port.connected : ports.includes(port), 'serial port check');
      for (const old of this.listed) {
        if (!ports.includes(old)) this.listed.delete(old);
      }
      for (const candidate of ports) this.observe(candidate, candidate.connected !== false, 'serial port check');
    } catch {
      // Connection events can still report changes when polling is unavailable.
    } finally {
      this.scanning = false;
    }
  }
}
