import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShellDom } from './helpers/dom.mjs';

test('the document declares Pumice, a stylesheet and the module renderer only', async () => {
  const { window } = await loadShellDom();
  const { document } = window;

  assert.equal(document.title, 'Pumice');
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')];
  assert.equal(styles.length, 1);
  assert.match(styles[0].getAttribute('href'), /styles\.css$/);

  const scripts = [...document.querySelectorAll('script')];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute('type'), 'module');
  assert.match(scripts[0].getAttribute('src'), /renderer\.mjs$/);
  assert.equal(scripts[0].textContent.trim(), '');
});

test('a strict content security policy blocks inline and remote code', async () => {
  const { window } = await loadShellDom();
  const meta = window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(meta, 'missing Content-Security-Policy meta tag');
  const policy = meta.getAttribute('content');
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'none'/);
});

test('the shell has the three layout regions and accessible labels', async () => {
  const { window } = await loadShellDom();
  const { document } = window;

  assert.ok(document.querySelector('[data-testid="app-shell"]'));
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  const editor = document.querySelector('[data-testid="editor"]');
  const statusbar = document.querySelector('[data-testid="statusbar"]');

  assert.ok(sidebar);
  assert.ok(editor);
  assert.ok(statusbar);
  assert.equal(sidebar.tagName, 'ASIDE');
  assert.equal(editor.tagName, 'MAIN');
  assert.equal(sidebar.getAttribute('aria-label'), 'Vault');
  assert.equal(editor.getAttribute('aria-label'), 'Editor');
  assert.equal(statusbar.getAttribute('role'), 'contentinfo');
  assert.equal(statusbar.getAttribute('aria-live'), 'polite');
});

test('the empty shell offers an enabled Open vault action', async () => {
  const { window } = await loadShellDom();
  const button = window.document.querySelector('[data-testid="open-vault-button"]');
  assert.ok(button);
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.match(button.textContent, /open vault/i);
  assert.equal(button.disabled, false);
});

test('the file list and editor start in explicit empty states', async () => {
  const { window } = await loadShellDom();
  const { document } = window;
  const fileList = document.querySelector('[data-testid="file-list"]');
  const emptyFiles = document.querySelector('[data-testid="file-list-empty"]');
  const emptyEditor = document.querySelector('[data-testid="editor-empty"]');

  assert.ok(fileList);
  assert.equal(fileList.hidden, true);
  assert.ok(emptyFiles);
  assert.match(emptyFiles.textContent, /vault/i);
  assert.ok(emptyEditor);
  assert.match(emptyEditor.textContent, /markdown|vault/i);
});

test('status and vault title start with honest placeholder text', async () => {
  const { window } = await loadShellDom();
  const { document } = window;
  assert.equal(document.querySelector('[data-testid="vault-title"]').textContent.trim(), 'No vault open');
  assert.equal(document.querySelector('[data-testid="status-text"]').textContent.trim(), 'Ready');
  assert.equal(document.querySelector('[data-testid="status-text"]').dataset.state, 'ready');
});

test('the editor pane starts empty with a disabled save action and a hidden notice banner', async () => {
  const { window } = await loadShellDom();
  const { document } = window;

  const textarea = document.querySelector('[data-testid="note-editor"]');
  assert.ok(textarea);
  assert.equal(textarea.tagName, 'TEXTAREA');
  assert.equal(textarea.hidden, true);
  assert.equal(textarea.getAttribute('aria-label'), 'Note content');
  assert.equal(textarea.getAttribute('spellcheck'), 'true');

  const save = document.querySelector('[data-testid="save-note-button"]');
  const reload = document.querySelector('[data-testid="reload-note-button"]');
  assert.equal(save.tagName, 'BUTTON');
  assert.equal(save.disabled, true);
  assert.match(save.textContent, /save/i);
  assert.equal(reload.disabled, true);

  const dirty = document.querySelector('[data-testid="note-dirty"]');
  assert.equal(dirty.hidden, true);

  const banner = document.querySelector('[data-testid="editor-banner"]');
  assert.ok(banner);
  assert.equal(banner.hidden, true);
  assert.equal(document.querySelector('[data-testid="banner-overwrite-button"]').hidden, true);
  assert.ok(document.querySelector('[data-testid="editor-banner-text"]'));
});
