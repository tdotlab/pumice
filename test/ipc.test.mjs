import test from 'node:test';
import assert from 'node:assert/strict';
import ipcModule from '../src/main/ipc.js';

const { isMenuAction, registerIpcHandlers } = ipcModule;

function fakeIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on(channel, listener) {
      this.listeners.set(channel, listener);
    },
  };
}

function fakeApp(version = '0.1.0') {
  return { getVersion: () => version };
}

test('the shell exposes exactly its app-info and renderer-ready channels', () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({
    ipcMain,
    app: fakeApp(),
    onRendererReady: () => {},
    versions: { electron: '45.5.0' },
    platform: 'linux',
    isDev: false,
  });

  assert.deepEqual([...ipcMain.handlers.keys()], ['shell:get-app-info']);
  assert.deepEqual([...ipcMain.listeners.keys()], ['shell:renderer-ready']);
  assert.equal(ipcMain.handlers.has('vault:open'), false);
  assert.equal(ipcMain.listeners.has('vault:read-file'), false);
});

test('app info reports the running shell version and host platform', async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({
    ipcMain,
    app: fakeApp('0.1.0'),
    versions: { electron: '45.5.0' },
    platform: 'linux',
    isDev: true,
  });

  const info = await ipcMain.handlers.get('shell:get-app-info')();
  assert.deepEqual(info, {
    name: 'Pumice',
    version: '0.1.0',
    electron: '45.5.0',
    platform: 'linux',
    isDev: true,
  });
});

test('renderer-ready fires once per notification with the sender event', () => {
  const ipcMain = fakeIpcMain();
  const events = [];
  registerIpcHandlers({
    ipcMain,
    app: fakeApp(),
    onRendererReady: (event) => events.push(event),
    versions: {},
    platform: 'linux',
    isDev: false,
  });

  const event = { senderId: 42 };
  ipcMain.listeners.get('shell:renderer-ready')(event);
  assert.deepEqual(events, [event]);
});

test('only known menu actions are accepted for renderer delivery', () => {
  assert.equal(isMenuAction('open-vault'), true);
  assert.equal(isMenuAction('about'), true);
  assert.equal(isMenuAction('delete-vault'), false);
  assert.equal(isMenuAction(undefined), false);
  assert.equal(isMenuAction({ action: 'open-vault' }), false);
});
