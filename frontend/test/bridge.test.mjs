import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.ts';

test('bridge sends explicit expectedVersion, including null only on overwrite', async () => {
  const calls = [];
  const bridge = createBridge(async (command, args) => { calls.push([command, args]); return { ok: true }; });
  await bridge.writeNote('a.md', 'draft', 'v1');
  await bridge.writeNote('a.md', 'draft', null);
  assert.deepEqual(calls, [
    ['vault_write', { path: 'a.md', content: 'draft', expectedVersion: 'v1' }],
    ['vault_write', { path: 'a.md', content: 'draft', expectedVersion: null }],
  ]);
});

test('bridge normalizes rejected structured backend errors', async () => {
  const bridge = createBridge(async () => { throw { code: 'CONFLICT', reason: 'deleted', message: 'Changed' }; });
  assert.deepEqual(await bridge.readNote('a.md'), { ok: false, error: { code: 'CONFLICT', reason: 'deleted', message: 'Changed' } });
});

test('close guard blocks dirty close until explicit confirmation', async () => {
  let callback; let closed = 0; let dirty = true; let allow = false;
  const window = { onCloseRequested: async fn => { callback = fn; return () => {}; }, destroy: async () => { closed++; } };
  const { installCloseGuard } = await import('../src/close-guard.ts');
  await installCloseGuard(window, () => dirty, () => allow);
  let prevented = 0;
  await callback({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(closed, 0);
  allow = true;
  await callback({ preventDefault() { prevented++; } });
  assert.equal(closed, 1);
  dirty = false;
  await callback({ preventDefault() { prevented++; } });
  assert.equal(prevented, 3);
  assert.equal(closed, 2);
});

test('a pending asynchronous discard decision cannot close or open multiple prompts', async () => {
  let callback, decide, prompts = 0, closed = 0;
  const window = { onCloseRequested: async fn => { callback = fn; return () => {}; }, destroy: async () => { closed++; } };
  const { installCloseGuard } = await import('../src/close-guard.ts');
  await installCloseGuard(window, () => true, () => { prompts++; return new Promise(resolve => { decide = resolve; }); });
  const event = { preventDefault() {} };
  const first = callback(event);
  await callback(event);
  assert.equal(prompts, 1);
  assert.equal(closed, 0);
  decide(false);
  await first;
  assert.equal(closed, 0);
});

test('clean close is explicitly destroyed so native guard can remain fail-closed', async () => {
  let callback; let closed = 0; let prevented = 0;
  const window = { onCloseRequested: async fn => { callback = fn; return () => {}; }, destroy: async () => { closed++; } };
  const { installCloseGuard } = await import('../src/close-guard.ts');
  await installCloseGuard(window, () => false, () => { throw new Error('clean close should not prompt'); });
  await callback({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(closed, 1);
});

test('startup waits for listener registration before enabling vault access', async () => {
  const { loadShellDom } = await import('./helpers/dom.mjs');
  const { document } = (await loadShellDom()).window;
  const button = document.querySelector('[data-testid="open-vault-button"]');
  let finish, initialized = false;
  const win = { onCloseRequested: () => new Promise(resolve => { finish = resolve; }), destroy: async () => {} };
  const { startGuardedApp } = await import('../src/close-guard.ts');
  assert.equal(typeof startGuardedApp, 'function');
  const startup = startGuardedApp({ document, window: win, confirm: () => false, initialize: () => { initialized = true; return () => false; } });
  assert.equal(button.disabled, true);
  assert.equal(initialized, false);
  finish(() => {});
  await startup;
  assert.equal(initialized, true);
  assert.equal(button.disabled, false);
});

test('registration failure leaves vault access disabled and shows an error', async () => {
  const { loadShellDom } = await import('./helpers/dom.mjs');
  const { document } = (await loadShellDom()).window;
  let initialized = false;
  const { startGuardedApp } = await import('../src/close-guard.ts');
  const win = { onCloseRequested: async () => { throw new Error('unavailable'); }, destroy: async () => {} };
  await startGuardedApp({ document, window: win, confirm: () => false, initialize: () => { initialized = true; return () => false; } });
  assert.equal(initialized, false);
  assert.equal(document.querySelector('[data-testid="open-vault-button"]').disabled, true);
  assert.match(document.querySelector('[data-testid="status-text"]').textContent, /close guard/i);
});

test('all vault commands pass Tauri argument envelopes and preserve backend results', async () => {
  const calls = [];
  const responses = [
    { ok: true, vault: { root: '/fixture', name: 'fixture', files: [] } },
    { ok: true, files: [] },
    { ok: true, note: { path: 'a.md', name: 'a.md', content: 'text', version: 'v1', size: 4, mtimeMs: 1 } },
    { ok: true, note: null },
    { ok: false, error: { code: 'CONFLICT', message: 'changed', reason: 'modified' } },
  ];
  const bridge = createBridge(async (command, args) => { calls.push([command, args]); return responses[calls.length - 1]; });
  assert.equal(await bridge.openVault(), responses[0]);
  assert.equal(await bridge.listNotes(), responses[1]);
  assert.equal(await bridge.readNote('a.md'), responses[2]);
  assert.equal(await bridge.statNote('a.md'), responses[3]);
  assert.equal(await bridge.writeNote('a.md', 'draft', 'v1'), responses[4]);
  assert.deepEqual(calls, [
    ['vault_open', undefined], ['vault_list', undefined], ['vault_read', { path: 'a.md' }],
    ['vault_stat', { path: 'a.md' }], ['vault_write', { path: 'a.md', content: 'draft', expectedVersion: 'v1' }],
  ]);
});
