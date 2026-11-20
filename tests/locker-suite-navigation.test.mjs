import assert from "node:assert/strict";
import test from "node:test";
import { guardSuiteNavigation } from "../locker-tests/navigation.js";

test("suite links wait for the operator to stop and disconnect", () => {
  const listeners = new Map();
  const status = { textContent: "" };
  const nav = {
    querySelector: () => status,
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  let busy = true;
  guardSuiteNavigation(nav, () => busy, "Disconnect before switching modes.");

  function activate(type, isLink) {
    let prevented = false;
    listeners.get(type)({
      target: { closest: () => isLink },
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  }

  assert.equal(activate("click", false), false);
  assert.equal(status.textContent, "");
  assert.equal(activate("click", true), true);
  assert.equal(activate("auxclick", true), true);
  assert.equal(status.textContent, "Disconnect before switching modes.");
  busy = false;
  assert.equal(activate("click", true), false);
});

test("older pages can load scripts without the new mode navigation", () => {
  assert.doesNotThrow(() => guardSuiteNavigation(null, () => true, ""));
});
