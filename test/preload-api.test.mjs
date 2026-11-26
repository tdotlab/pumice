import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PRELOAD_PATH = new URL('../src/preload/preload.js', import.meta.url);

function fakeIpcRenderer() {
  const listeners = new Map();
  return {
    invocations: [],
    sends: [],
    listeners,
    invoke(channel, ...args) {
      this.invocations.push([channel, ...args]);
      return Promise.resolve({ name: 'Pumice' });
    },
    send(channel, ...args) {
      this.sends.push([channel, ...args]);
    },
    on(channel, listener) {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? [];
      listeners.set(channel, list.filter((entry) => entry !== listener));
    },
  };
}

/**
 * Execute the real preload file the way Electron does not quite do: with a
 * minimal CommonJS shim and a fake electron module. This catches syntax errors
 * and accidental dependencies on modules that sandboxed preloads cannot load.
 */
function loadPreload() {
  const exposed = [];
  const ipcRenderer = fakeIpcRenderer();
  const sandbox = {
    module: { exports: {} },
    require(specifier) {
      assert.equal(specifier, 'electron', 'preload may only require electron');
      return {
        contextBridge: {
          exposeInMainWorld(key, value) {
            exposed.push([key, value]);
          },
        },
        ipcRenderer,
      };
    },
  };

  vm.runInNewContext(readFileSync(PRELOAD_PATH, 'utf8'), sandbox, {
    filename: 'src/preload/preload.js',
  });

  return { exposed, ipcRenderer, exports: sandbox.module.exports };
}

test('the preload source only requires electron and exposes one frozen bridge', () => {
  const { exposed, exports } = loadPreload();
  assert.equal(exposed.length, 1);
  const [key, api] = exposed[0];
  assert.equal(key, 'pumice');
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ['getAppInfo', 'notifyReady', 'onMenuAction']);
  assert.equal('invoke' in api, false);
  assert.equal('send' in api, false);
  assert.deepEqual(Object.keys(exports).sort(), ['MENU_ACTIONS', 'createPreloadApi']);
});

test('getAppInfo asks the main process over the app-info channel', async () => {
  const { exposed, ipcRenderer } = loadPreload();
  const api = exposed[0][1];
  const info = await api.getAppInfo();
  assert.deepEqual(ipcRenderer.invocations, [['shell:get-app-info']]);
  assert.equal(info.name, 'Pumice');
});

test('notifyReady reports that the renderer finished booting', () => {
  const { exposed, ipcRenderer } = loadPreload();
  exposed[0][1].notifyReady();
  assert.deepEqual(ipcRenderer.sends, [['shell:renderer-ready']]);
});

test('menu actions are validated before reaching renderer callbacks', () => {
  const { exposed, ipcRenderer } = loadPreload();
  const received = [];
  exposed[0][1].onMenuAction((action) => received.push(action));

  const [listener] = ipcRenderer.listeners.get('shell:menu-action');
  assert.ok(listener, 'expected a shell:menu-action listener');
  listener({}, 'open-vault');
  listener({}, 'rm -rf');
  listener({}, undefined);
  assert.deepEqual(received, ['open-vault']);
});

test('onMenuAction returns an unsubscribe function that detaches its listener', () => {
  const { exposed, ipcRenderer } = loadPreload();
  const received = [];
  const unsubscribe = exposed[0][1].onMenuAction((action) => received.push(action));
  assert.equal(ipcRenderer.listeners.get('shell:menu-action').length, 1);

  unsubscribe();
  assert.equal(ipcRenderer.listeners.get('shell:menu-action').length, 0);
  assert.deepEqual(received, []);
});

test('onMenuAction rejects non-function subscribers early', () => {
  const { exposed } = loadPreload();
  assert.throws(
    () => exposed[0][1].onMenuAction(null),
    (error) => error.name === 'TypeError' && /callback function/i.test(error.message),
  );
});
