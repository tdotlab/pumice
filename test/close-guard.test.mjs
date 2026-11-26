import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import closeGuardModule from '../src/main/close-guard.js';

const { CLOSE_DIALOG, installCloseGuard } = closeGuardModule;

function fakeWindow() {
  const webContents = new EventEmitter();
  return { webContents };
}

function fakeEvent() {
  let prevented = false;
  return {
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
}

test('the close guard asks before discarding and only then lets the unload through', () => {
  const window = fakeWindow();
  const calls = [];
  const dialog = {
    showMessageBoxSync: (target, options) => {
      calls.push([target, options]);
      return 1; // "Discard changes and close"
    },
  };
  installCloseGuard({ window, dialog });

  const event = fakeEvent();
  window.webContents.emit('will-prevent-unload', event);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], window);
  assert.deepEqual(calls[0][1].buttons, ['Keep editing', 'Discard changes and close']);
  assert.equal(calls[0][1].cancelId, 0);
  assert.equal(calls[0][1].defaultId, 0);
  assert.match(calls[0][1].message, /unsaved changes/i);
  assert.equal(event.defaultPrevented, true, 'discard must allow the window to close');
});

test('choosing "Keep editing" leaves the unload prevented', () => {
  const window = fakeWindow();
  const dialog = { showMessageBoxSync: () => 0 };
  installCloseGuard({ window, dialog });

  const event = fakeEvent();
  window.webContents.emit('will-prevent-unload', event);

  assert.equal(event.defaultPrevented, false);
});

test('a failing dialog keeps the window open instead of losing the draft', () => {
  const window = fakeWindow();
  const dialog = {
    showMessageBoxSync: () => {
      throw new Error('dialog backend exploded');
    },
  };
  installCloseGuard({ window, dialog });

  const event = fakeEvent();
  assert.doesNotThrow(() => window.webContents.emit('will-prevent-unload', event));
  assert.equal(event.defaultPrevented, false);
});

test('dispose() detaches the guard so a later close is not intercepted', () => {
  const window = fakeWindow();
  let asked = 0;
  const dialog = { showMessageBoxSync: () => { asked += 1; return 0; } };
  const guard = installCloseGuard({ window, dialog });

  guard.dispose();
  const event = fakeEvent();
  window.webContents.emit('will-prevent-unload', event);

  assert.equal(asked, 0);
  assert.equal(event.defaultPrevented, false);
});

test('installCloseGuard rejects a window without webContents and a missing dialog', () => {
  assert.throws(() => installCloseGuard({ window: {}, dialog: {} }), TypeError);
  assert.throws(() => installCloseGuard({ window: fakeWindow() }), TypeError);
  assert.throws(
    () => installCloseGuard({ window: fakeWindow(), dialog: {} }),
    TypeError
  );
});

test('the dialog text names the consequence and the safe default', () => {
  assert.match(CLOSE_DIALOG.detail, /discard/i);
  assert.equal(CLOSE_DIALOG.type, 'warning');
  assert.equal(CLOSE_DIALOG.noLink, true);
});
