import test from 'node:test';
import assert from 'node:assert/strict';
import smokeModule from '../src/main/smoke.js';

const { buildSmokeScript, validateSmokeSnapshot } = smokeModule;

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
  ]) {
    assert.ok(script.includes(probe), `smoke script is missing ${probe}`);
  }
});
