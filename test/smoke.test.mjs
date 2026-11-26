import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import smokeModule from '../src/main/smoke.js';
import smokeVaultModule from '../src/main/smoke-vault.js';

const { buildSmokeScript, validateSmokeSnapshot, verifySavedNote } = smokeModule;
const { copyFixtureVault, isInside } = smokeVaultModule;

const VALID = {
  title: 'Pumice',
  hasShell: true,
  hasSidebar: true,
  hasEditor: true,
  hasStatusbar: true,
  hasOpenVaultButton: true,
  hasPreloadBridge: true,
  version: 'v0.1.0',
  layout: {
    sidebar: { x: 0, y: 56, width: 280, height: 694 },
    editor: { x: 280, y: 56, width: 900, height: 694 },
    statusbar: { x: 0, y: 750, width: 1180, height: 30 },
  },
  rendererErrors: [],
};

test('a complete rendered shell passes validation', () => {
  const result = validateSmokeSnapshot(VALID);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('a missing layout region fails validation with a named error', () => {
  for (const region of ['hasShell', 'hasSidebar', 'hasEditor', 'hasStatusbar', 'hasOpenVaultButton']) {
    const result = validateSmokeSnapshot({ ...VALID, [region]: false });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.includes(region)),
      `expected an error naming ${region}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('a renderer error or wrong document title fails validation', () => {
  const withError = validateSmokeSnapshot({ ...VALID, rendererErrors: ['boom'] });
  assert.equal(withError.ok, false);
  assert.ok(withError.errors.some((error) => /renderer error/i.test(error)));

  const wrongTitle = validateSmokeSnapshot({ ...VALID, title: 'Electron' });
  assert.equal(wrongTitle.ok, false);
  assert.ok(wrongTitle.errors.some((error) => /title/i.test(error)));
});

test('a missing preload bridge or version fails validation', () => {
  const noBridge = validateSmokeSnapshot({ ...VALID, hasPreloadBridge: false });
  assert.equal(noBridge.ok, false);
  assert.ok(noBridge.errors.some((error) => /preload bridge/i.test(error)));

  const noVersion = validateSmokeSnapshot({ ...VALID, version: '' });
  assert.equal(noVersion.ok, false);
  assert.ok(noVersion.errors.some((error) => /version/i.test(error)));
});

test('unpainted or overlapping layout regions fail validation', () => {
  const collapsed = validateSmokeSnapshot({
    ...VALID,
    layout: { ...VALID.layout, editor: { x: 280, y: 56, width: 0, height: 0 } },
  });
  assert.equal(collapsed.ok, false);
  assert.ok(collapsed.errors.some((error) => /editor/.test(error) && /size/i.test(error)));

  const overlapping = validateSmokeSnapshot({
    ...VALID,
    layout: { ...VALID.layout, editor: { ...VALID.layout.editor, x: 100 } },
  });
  assert.equal(overlapping.ok, false);
  assert.ok(overlapping.errors.some((error) => /overlap/i.test(error)));

  const statusAbove = validateSmokeSnapshot({
    ...VALID,
    layout: { ...VALID.layout, statusbar: { ...VALID.layout.statusbar, y: 0 } },
  });
  assert.equal(statusAbove.ok, false);
  assert.ok(statusAbove.errors.some((error) => /status bar/i.test(error)));
});

test('the smoke script is self-contained and reports the required probes', () => {
  const script = buildSmokeScript();
  assert.equal(typeof script, 'string');
  for (const probe of [
    'app-shell',
    'sidebar',
    'editor',
    'statusbar',
    'open-vault-button',
    'rendererErrors',
    'note-editor',
    'save-note-button',
    'vaultFlow',
  ]) {
    assert.ok(script.includes(probe), `smoke script is missing ${probe}`);
  }
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'smoke-script.js' }));
  assert.ok(script.includes(String.raw`/\s*$/`), 'smoke script should trim trailing whitespace with a regex');
  assert.ok(script.includes(String.raw`'\n\n'`), 'smoke script should insert a newline-separated marker');
});

const VAULT_FLOW = {
  attempted: true,
  opened: true,
  noteOpened: true,
  edited: true,
  saved: true,
  path: 'notes/daily.md',
  status: 'Saved notes/daily.md',
  diskContainsEdit: true,
  error: null,
};

test('a full open/edit/save flow passes when disk was verified', () => {
  const result = validateSmokeSnapshot({ ...VALID, vaultFlow: VAULT_FLOW }, { expectVaultFlow: true });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('the vault flow is required only when the caller expects it', () => {
  const withoutFlow = validateSmokeSnapshot(VALID);
  assert.equal(withoutFlow.ok, true);

  const expected = validateSmokeSnapshot(VALID, { expectVaultFlow: true });
  assert.equal(expected.ok, false);
  assert.ok(expected.errors.some((error) => /vault flow/i.test(error)));
});

test('an incomplete or unverified vault flow fails validation', () => {
  const notSaved = validateSmokeSnapshot(
    { ...VALID, vaultFlow: { ...VAULT_FLOW, saved: false, error: 'save button never enabled' } },
    { expectVaultFlow: true },
  );
  assert.equal(notSaved.ok, false);
  assert.ok(notSaved.errors.some((error) => /save/i.test(error)));

  const diskMismatch = validateSmokeSnapshot(
    { ...VALID, vaultFlow: { ...VAULT_FLOW, diskContainsEdit: false } },
    { expectVaultFlow: true },
  );
  assert.equal(diskMismatch.ok, false);
  assert.ok(diskMismatch.errors.some((error) => /disk/i.test(error)));

  const noEditor = validateSmokeSnapshot(
    { ...VALID, vaultFlow: { ...VAULT_FLOW, noteOpened: false } },
    { expectVaultFlow: true },
  );
  assert.equal(noEditor.ok, false);
  assert.ok(noEditor.errors.some((error) => /note/i.test(error)));
});

test('the smoke vault is copied to a scratch directory and removed again', async () => {
  const vault = await copyFixtureVault();
  try {
    assert.notEqual(vault.root, path.resolve('test/fixtures/smoke-vault'));
    const welcome = await fs.readFile(path.join(vault.root, 'welcome.md'), 'utf8');
    assert.match(welcome, /Welcome to Pumice/);
    const daily = await fs.readFile(path.join(vault.root, 'notes/daily.md'), 'utf8');
    assert.match(daily, /Daily note/);
    // The copy is a faithful vault: non-Markdown and hidden files come along
    // even though the vault listing filter hides them.
    await fs.access(path.join(vault.root, 'notes/attachments.txt'));
    await fs.access(path.join(vault.root, '.hidden/secret.md'));
    const entries = await fs.readdir(vault.root);
    assert.deepEqual(entries.sort(), ['.hidden', 'notes', 'welcome.md']);
  } finally {
    vault.cleanup();
  }
  await assert.rejects(fs.access(vault.root), 'cleanup should remove the scratch vault');
});

test('isInside accepts children and rejects siblings and traversal', () => {
  assert.equal(isInside('/vault', '/vault/notes/daily.md'), true);
  assert.equal(isInside('/vault', '/vault'), false);
  assert.equal(isInside('/vault-other/daily.md', '/vault/daily.md'), false);
  assert.equal(isInside('/vault', '/vault-other/daily.md'), false);
  assert.equal(isInside('/vault', '/vault/../outside.md'), false);
});

test('copyFixtureVault refuses an existing destination without deleting it', async () => {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'pumice-smoke-existing-'));
  const keep = path.join(destination, 'keep.txt');
  await fs.writeFile(keep, 'keep me');
  try {
    await assert.rejects(copyFixtureVault({ destination }));
    assert.equal(await fs.readFile(keep, 'utf8'), 'keep me');
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
});

test('verifySavedNote reads the saved marker back from the copied vault', async () => {
  const vault = await copyFixtureVault();
  try {
    const flow = { path: 'notes/daily.md', marker: 'Smoke edit 123' };
    assert.equal(verifySavedNote({ vaultRoot: vault.root, vaultFlow: flow }), false);

    await fs.appendFile(path.join(vault.root, 'notes/daily.md'), '\nSmoke edit 123\n');
    assert.equal(verifySavedNote({ vaultRoot: vault.root, vaultFlow: flow }), true);
    assert.equal(
      verifySavedNote({ vaultRoot: vault.root, vaultFlow: { ...flow, marker: 'different' } }),
      false,
    );
    assert.equal(
      verifySavedNote({ vaultRoot: vault.root, vaultFlow: { ...flow, path: '../outside.md' } }),
      false,
    );
    assert.equal(
      verifySavedNote({ vaultRoot: vault.root, vaultFlow: { ...flow, path: 'notes/gone.md' } }),
      false,
    );
  } finally {
    vault.cleanup();
  }
});
