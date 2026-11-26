import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import lifecycleModule from '../src/main/lifecycle.js';

const { acquireSingleInstanceLock, installLifecycle } = lifecycleModule;

function fakeApp(overrides = {}) {
  const app = new EventEmitter();
  app.quitCalled = false;
  app.quit = () => {
    app.quitCalled = true;
  };
  return Object.assign(app, overrides);
}

test('window-all-closed quits the app on Linux and Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const app = fakeApp();
    installLifecycle({
      app,
      platform,
      createWindow: () => {},
      getWindow: () => null,
      focusWindow: () => {},
    });
    app.emit('window-all-closed');
    assert.equal(app.quitCalled, true, `${platform} should quit`);
  }
});

test('window-all-closed keeps the app alive on macOS until the user quits', () => {
  const app = fakeApp();
  installLifecycle({
    app,
    platform: 'darwin',
    createWindow: () => {},
    getWindow: () => null,
    focusWindow: () => {},
  });
  app.emit('window-all-closed');
  assert.equal(app.quitCalled, false);
});

test('activate creates a fresh window when none is open', () => {
  const app = fakeApp();
  let created = 0;
  installLifecycle({
    app,
    platform: 'darwin',
    createWindow: () => {
      created += 1;
    },
    getWindow: () => null,
    focusWindow: () => {},
  });
  app.emit('activate');
  assert.equal(created, 1);
});

test('activate focuses the existing window instead of creating a second one', () => {
  const app = fakeApp();
  let created = 0;
  let focused = 0;
  installLifecycle({
    app,
    platform: 'darwin',
    createWindow: () => {
      created += 1;
    },
    getWindow: () => ({ id: 1 }),
    focusWindow: () => {
      focused += 1;
    },
  });
  app.emit('activate');
  assert.equal(created, 0);
  assert.equal(focused, 1);
});

test('a second instance focuses the running window', () => {
  const app = fakeApp();
  let focused = 0;
  installLifecycle({
    app,
    platform: 'linux',
    createWindow: () => {},
    getWindow: () => ({ id: 1 }),
    focusWindow: () => {
      focused += 1;
    },
  });
  app.emit('second-instance');
  assert.equal(focused, 1);
});

test('a second process without the lock quits immediately', () => {
  const app = fakeApp({ requestSingleInstanceLock: () => false });
  assert.equal(acquireSingleInstanceLock(app), false);
  assert.equal(app.quitCalled, true);
});

test('the first process keeps the single-instance lock', () => {
  const app = fakeApp({ requestSingleInstanceLock: () => true });
  assert.equal(acquireSingleInstanceLock(app), true);
  assert.equal(app.quitCalled, false);
});
