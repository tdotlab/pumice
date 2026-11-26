import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShellDom } from './helpers/dom.mjs';
import { createShellView } from '../src/renderer/ui.mjs';

async function mount() {
  const dom = await loadShellDom();
  const calls = [];
  const view = createShellView({
    document: dom.window.document,
    onOpenVault: () => calls.push('open-vault'),
  });
  return { dom, calls, view, document: dom.window.document };
}

const FILES = [
  { path: 'daily/2026-11-26.md', name: '2026-11-26.md' },
  { path: 'ideas.md', name: 'ideas.md' },
];

test('clicking Open vault asks the integrator to open a vault', async () => {
  const { document, calls } = await mount();
  document.querySelector('[data-testid="open-vault-button"]').click();
  assert.deepEqual(calls, ['open-vault']);
});

test('a vault view names the vault and lists its Markdown files', async () => {
  const { document, view } = await mount();
  view.setVault({ name: 'Field Notes', files: FILES });

  assert.equal(document.querySelector('[data-testid="vault-title"]').textContent, 'Field Notes');
  const list = document.querySelector('[data-testid="file-list"]');
  assert.equal(list.hidden, false);

  const items = [...document.querySelectorAll('[data-testid="file-items"] li')];
  assert.equal(items.length, 2);
  assert.equal(items[0].dataset.path, 'daily/2026-11-26.md');
  assert.equal(items[0].textContent.trim(), '2026-11-26.md');
  assert.equal(items[1].dataset.path, 'ideas.md');
  assert.match(document.querySelector('[data-testid="status-text"]').textContent, /Field Notes/);
});

test('a vault without Markdown files shows an explicit empty list note', async () => {
  const { document, view } = await mount();
  view.setVault({ name: 'Empty Vault', files: [] });

  const empty = document.querySelector('[data-testid="file-list-empty"]');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /no markdown files/i);
  assert.equal(document.querySelectorAll('[data-testid="file-items"] li').length, 0);
  assert.equal(document.querySelector('[data-testid="file-list"]').hidden, false);
});

test('closing the vault returns the shell to its initial empty state', async () => {
  const { document, view } = await mount();
  view.setVault({ name: 'Field Notes', files: FILES });
  view.setVault(null);

  assert.equal(document.querySelector('[data-testid="vault-title"]').textContent, 'No vault open');
  assert.equal(document.querySelector('[data-testid="file-list"]').hidden, true);
  assert.equal(document.querySelectorAll('[data-testid="file-items"] li').length, 0);
  assert.equal(document.querySelector('[data-testid="status-text"]').textContent, 'Ready');
  assert.equal(document.querySelector('[data-testid="status-text"]').dataset.state, 'ready');
});

test('status messages carry a machine-readable state for failures', async () => {
  const { document, view } = await mount();
  view.setStatus('Vault is read-only', 'warning');
  const status = document.querySelector('[data-testid="status-text"]');
  assert.equal(status.textContent, 'Vault is read-only');
  assert.equal(status.dataset.state, 'warning');
  view.setStatus('Could not read note', 'error');
  assert.equal(status.dataset.state, 'error');
});

test('file names are rendered as text, never as markup', async () => {
  const { document, view } = await mount();
  const hostile = '<img src=x onerror="alert(1)">.md';
  view.setVault({ name: 'Untrusted', files: [{ path: 'x.md', name: hostile }] });

  const item = document.querySelector('[data-testid="file-items"] li');
  assert.equal(item.querySelector('img'), null);
  assert.equal(item.textContent.trim(), hostile);
});

test('menu actions route through the same vault-opening seam', async () => {
  const { view, calls } = await mount();
  assert.equal(view.handleMenuAction('open-vault'), true);
  assert.equal(view.handleMenuAction('launch-missiles'), false);
  assert.deepEqual(calls, ['open-vault']);
});

test('destroy detaches the Open vault listener', async () => {
  const { document, view, calls } = await mount();
  view.destroy();
  document.querySelector('[data-testid="open-vault-button"]').click();
  assert.deepEqual(calls, []);
});
