import assert from 'node:assert/strict';
import test from 'node:test';
import {PortWatch} from '../locker-client-check/port-watch.js';

function fixture() {
  const serial = new EventTarget();
  serial.ports = [];
  serial.getPorts = async () => serial.ports;
  const changes = [];
  const watch = new PortWatch(serial, change => changes.push(change.type));
  const select = port => {
    serial.ports = [port];
    watch.select(port);
  };
  return {serial, watch, changes, select};
}

test('counts one removal and return of the same selected port', async () => {
  const {serial, watch, changes, select} = fixture();
  const port = {};
  select(port);
  serial.ports = [];
  watch.observe(port, false, 'USB event');
  await watch.scan();
  serial.ports = [port];
  await watch.scan();
  watch.observe(port, true, 'USB event');
  assert.deepEqual(changes, ['removed', 'attached']);
});

test('a device with matching USB identifiers requires explicit selection', async () => {
  const {serial, watch, changes, select} = fixture();
  const port = {getInfo: () => ({usbVendorId: 1240, usbProductId: 10})};
  const other = {getInfo: () => ({usbVendorId: 1240, usbProductId: 11})};
  const replacement = {...port};
  select(port);
  serial.ports = [other, replacement];
  await watch.scan();
  await watch.scan();
  assert.deepEqual(changes, ['removed', 'candidate']);
  assert.equal(watch.port, port);
  assert.equal(watch.present, false);
});

test('an older enumeration cannot undo a newer disconnect event', async () => {
  const {serial, watch, changes, select} = fixture();
  const port = {};
  select(port);
  let finish;
  serial.getPorts = () => new Promise(resolve => { finish = resolve; });
  const scanning = watch.scan();
  watch.observe(port, false, 'USB event');
  finish([port]);
  await scanning;
  assert.deepEqual(changes, ['removed']);
  assert.equal(watch.present, false);
});
