'use strict';

/**
 * Real-Electron data-safety check (headless Ozone).
 *
 * Boots the real preload, renderer modules and vault IPC against a throwaway
 * vault, then verifies the two QA data-loss defects at application level:
 *
 *  1. a latin-1 and a UTF-16LE note are listed but not editable; opening one
 *     shows the encoding banner and never puts decoded text in the editor, and
 *     `vault:read` / `vault:write` refuse with INVALID_ENCODING while the bytes
 *     on disk stay identical;
 *  2. closing the window with a dirty draft asks first: "Keep editing" leaves
 *     the window and the draft alive, "Discard changes and close" closes it.
 *  3. a CRLF note keeps its CRLF line endings when it is edited and saved (the
 *     textarea itself only ever holds LF);
 *  4. a note replaced with non-UTF-8 bytes while it is open is announced when
 *     the window regains focus, with the draft kept and no overwrite offered.
 *
 * The dialog is a stub so the run can be automated; everything else is the
 * shipped code path. Prints one `PUMICE_E2E_RESULT {...}` line and exits 0 only
 * when every check passes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain } = require('electron');

const { loadShellWindow } = require('../src/main/window.js');
const { installCloseGuard } = require('../src/main/close-guard.js');
const { registerIpcHandlers } = require('../src/main/ipc.js');
const { registerVaultIpcHandlers } = require('../src/main/vault-ipc.js');
const { VaultSession } = require('../src/main/vault-session.js');

const LATIN1 = Buffer.from('café note\n', 'latin1');
const UTF16LE = Buffer.from('\ufeffutf16 note\n', 'utf16le');
const UTF8 = '# plain utf8 note\n';
const CRLF = Buffer.from('# crlf\r\nline\r\n', 'utf8');

app.disableHardwareAcceleration();

const checks = [];
function check(name, ok, detail) {
  const snapshot = detail === undefined ? null : JSON.parse(JSON.stringify(detail));
  checks.push({ name, ok: Boolean(ok), detail: snapshot });
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pumice-e2e-'));
function cleanup() {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function finish() {
  const ok = checks.every((entry) => entry.ok);
  console.log(`PUMICE_E2E_RESULT ${JSON.stringify({ ok, checks })}`);
  cleanup();
  app.exit(ok ? 0 : 1);
}

const nextDialogResponse = { value: 0 };
const dialogCalls = [];
const dialog = {
  showMessageBoxSync(window, options) {
    dialogCalls.push({ title: options.title, buttons: options.buttons, detail: options.detail });
    return nextDialogResponse.value;
  },
};

const rendererScript = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = read();
      if (value) return value;
      await sleep(25);
    }
    return null;
  };
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');

  const controller = await waitFor(() => window.pumiceVault || null, 5000);
  if (!controller) throw new Error('vault controller did not start');
  q('open-vault-button').click();

  const rows = await waitFor(() => {
    const items = document.querySelectorAll('[data-testid="file-items"] li.file-item');
    return items.length === 4 ? Array.from(items) : null;
  }, 8000);
  if (!rows) throw new Error('file list never populated');

  const listing = rows.map((item) => ({
    path: item.dataset.path,
    ariaDisabled: item.getAttribute('aria-disabled'),
    tag: item.textContent.trim(),
  }));

  const latinRow = rows.find((item) => item.dataset.path === 'notes/latin1.md');
  latinRow.click();
  await sleep(300);
  const latin = {
    banner: q('editor-banner-text').textContent,
    bannerVisible: q('editor-banner').hidden === false,
    editorHidden: q('note-editor').hidden,
    meta: q('status-meta').textContent,
    status: q('status-text').textContent,
    statusState: q('status-text').dataset.state,
    note: controller.getState().note,
  };

  const readLatin = await window.pumice.readNote('notes/latin1.md');
  const writeLatin = await window.pumice.writeNote('notes/latin1.md', 'overwritten\\n', null);
  const readUtf16 = await window.pumice.readNote('notes/utf16.md');

  const utf8Row = rows.find((item) => item.dataset.path === 'utf8.md');
  utf8Row.click();
  const textarea = await waitFor(() => {
    const element = q('note-editor');
    return element && !element.hidden ? element : null;
  }, 5000);
  if (!textarea) throw new Error('UTF-8 note never opened');
  const metaOnUtf8 = q('status-meta').textContent;

  textarea.value = '# edited by e2e\\n';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  q('save-note-button').click();
  const savedStatus = await waitFor(() => {
    const text = q('status-text').textContent.trim();
    return /^Saved /.test(text) ? text : null;
  }, 5000);

  // A CRLF note opens as LF text (the textarea cannot hold CR), and an edit
  // saved from it must go back to disk with its CRLF endings intact.
  const crlfRow = rows.find((item) => item.dataset.path === 'notes/crlf.md');
  crlfRow.click();
  const crlfTextarea = await waitFor(() => {
    const element = q('note-editor');
    return element && !element.hidden && element.value.indexOf('crlf') !== -1 ? element : null;
  }, 5000);
  if (!crlfTextarea) throw new Error('CRLF note never opened');
  const crlfShown = crlfTextarea.value;
  crlfTextarea.value = crlfShown + 'X\\n';
  crlfTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  q('save-note-button').click();
  const crlfSavedStatus = await waitFor(() => {
    const text = q('status-text').textContent.trim();
    return text.startsWith('Saved notes/crlf.md') ? text : null;
  }, 5000);

  // Re-open the UTF-8 note so the dirty-close checks below act on it.
  utf8Row.click();
  await waitFor(() => q('note-editor').value.indexOf('edited by e2e') !== -1, 5000);

  const draft = 'draft that must survive a cancelled close\\n';
  textarea.value = draft;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  return {
    listing,
    latin,
    readLatin,
    writeLatin,
    readUtf16,
    metaOnUtf8,
    savedStatus,
    crlfShown,
    crlfSavedStatus,
    dirty: controller.getState().dirty,
    draft,
  };
})()`;

async function run() {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'utf8.md'), UTF8);
  fs.writeFileSync(path.join(root, 'notes', 'latin1.md'), LATIN1);
  fs.writeFileSync(path.join(root, 'notes', 'utf16.md'), UTF16LE);
  fs.writeFileSync(path.join(root, 'notes', 'crlf.md'), CRLF);

  const session = new VaultSession();
  await session.open(root);

  registerIpcHandlers({ ipcMain, app, isDev: false });
  registerVaultIpcHandlers({
    ipcMain,
    session,
    chooseDirectory: async () => root,
  });

  const window = loadShellWindow({
    BrowserWindow,
    preloadPath: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
  });
  installCloseGuard({ window, dialog });

  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));

  const result = await window.webContents.executeJavaScript(rendererScript);

  // --- Fix 1: encoding ----------------------------------------------------
  const rows = Object.fromEntries(result.listing.map((row) => [row.path, row]));
  check('latin-1 note listed with a "not UTF-8" tag', /not UTF-8/i.test(rows['notes/latin1.md'].tag), rows['notes/latin1.md']);
  check('latin-1 note marked aria-disabled', rows['notes/latin1.md'].ariaDisabled === 'true', rows['notes/latin1.md']);
  check('UTF-16 note listed with a "not UTF-8" tag', /not UTF-8/i.test(rows['notes/utf16.md'].tag), rows['notes/utf16.md']);
  check('UTF-8 note is not tagged', !/not UTF-8/i.test(rows['utf8.md'].tag), rows['utf8.md']);

  check('opening the latin-1 note keeps the editor empty', result.latin.editorHidden === true, result.latin);
  check('opening the latin-1 note shows the encoding banner', /not UTF-8/i.test(result.latin.banner) && result.latin.bannerVisible, result.latin);
  check('status bar reports "not UTF-8"', result.latin.meta === 'Markdown · not UTF-8', result.latin);
  check('no note was opened in the controller', result.latin.note === null, result.latin);

  check('vault:read refuses latin-1 with INVALID_ENCODING', result.readLatin.ok === false && result.readLatin.error.code === 'INVALID_ENCODING', result.readLatin);
  check('vault:write refuses latin-1 with INVALID_ENCODING', result.writeLatin.ok === false && result.writeLatin.error.code === 'INVALID_ENCODING', result.writeLatin);
  check('vault:read refuses UTF-16LE with INVALID_ENCODING', result.readUtf16.ok === false && result.readUtf16.error.code === 'INVALID_ENCODING', result.readUtf16);

  check('UTF-8 note opens and the status bar says UTF-8', result.metaOnUtf8 === 'Markdown · UTF-8', result.metaOnUtf8);
  check('UTF-8 note saved through the real UI', typeof result.savedStatus === 'string' && /^Saved /.test(result.savedStatus), result.savedStatus);

  const utf8OnDisk = fs.readFileSync(path.join(root, 'utf8.md'));
  check('UTF-8 edit reached the disk', utf8OnDisk.equals(Buffer.from('# edited by e2e\n', 'utf8')), { sha256: sha(utf8OnDisk) });

  // --- F5: CRLF line endings survive an editor save ----------------------
  const crlfOnDisk = fs.readFileSync(path.join(root, 'notes', 'crlf.md'));
  check('the CRLF note is listed as UTF-8', !/not UTF-8/i.test(rows['notes/crlf.md'].tag), rows['notes/crlf.md']);
  check('the editor shows a CRLF note as LF text', result.crlfShown === '# crlf\nline\n', result.crlfShown);
  check(
    'saving an edit keeps the CRLF line endings',
    crlfOnDisk.equals(Buffer.from('# crlf\r\nline\r\nX\r\n', 'utf8')),
    { hex: crlfOnDisk.toString('hex'), status: result.crlfSavedStatus },
  );

  // --- Fix 2: dirty close -------------------------------------------------
  check('editor is dirty before the close attempt', result.dirty === true, result.dirty);
  check('cancelled close wrote nothing to disk', fs.readFileSync(path.join(root, 'utf8.md')).equals(Buffer.from('# edited by e2e\n', 'utf8')));

  nextDialogResponse.value = 0; // Keep editing
  window.close();
  await sleep(400);
  check('the window survives "Keep editing"', window.isDestroyed() === false);
  check('the close dialog was shown with both choices', dialogCalls.length === 1 && dialogCalls[0].buttons.length === 2, dialogCalls);

  const draftAfterCancel = await window.webContents.executeJavaScript(
    "document.querySelector('[data-testid=\"note-editor\"]').value"
  );
  check('the draft survives the cancelled close', draftAfterCancel === result.draft, draftAfterCancel);
  check('the cancelled close did not write the draft', fs.readFileSync(path.join(root, 'utf8.md')).equals(Buffer.from('# edited by e2e\n', 'utf8')));

  // Quitting the app must go through the same guard.
  nextDialogResponse.value = 0; // Keep editing
  app.quit();
  await sleep(600);
  check('the app keeps running when quit is cancelled', window.isDestroyed() === false, {
    destroyed: window.isDestroyed(),
  });

  // Non-UTF-8 bytes were never touched by any of the above.
  check('latin-1 bytes are unchanged', fs.readFileSync(path.join(root, 'notes', 'latin1.md')).equals(LATIN1), {
    sha256: sha(fs.readFileSync(path.join(root, 'notes', 'latin1.md'))),
  });
  check('UTF-16LE bytes are unchanged', fs.readFileSync(path.join(root, 'notes', 'utf16.md')).equals(UTF16LE));

  // --- F9: focus-time warning when the open note turns non-UTF-8 -----------
  fs.writeFileSync(path.join(root, 'utf8.md'), LATIN1);
  const focusResult = await window.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const q = (id) => document.querySelector('[data-testid="' + id + '"]');
    window.dispatchEvent(new Event('focus'));
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const banner = q('editor-banner-text').textContent;
      if (banner) {
        return {
          banner,
          bannerVisible: q('editor-banner').hidden === false,
          editorText: q('note-editor').value,
          reloadHidden: q('banner-reload-button').hidden,
          overwriteHidden: q('banner-overwrite-button').hidden,
          status: q('status-text').textContent,
          statusState: q('status-text').dataset.state,
          dirty: window.pumiceVault.getState().dirty,
        };
      }
      await sleep(25);
    }
    return { banner: '', timedOut: true };
  })()`);

  check(
    'a note that turns non-UTF-8 on disk is announced on focus',
    /not UTF-8/i.test(focusResult.banner) && focusResult.bannerVisible === true,
    focusResult,
  );
  check(
    'the dirty draft survives the note turning non-UTF-8',
    focusResult.editorText === result.draft && focusResult.dirty === true,
    focusResult,
  );
  check(
    'no reload or overwrite is offered for a non-UTF-8 note',
    focusResult.reloadHidden === true && focusResult.overwriteHidden === true,
    focusResult,
  );

  const closed = new Promise((resolve) => window.once('closed', resolve));
  nextDialogResponse.value = 1; // Discard changes and close
  window.close();
  await Promise.race([closed, sleep(3000)]);
  check('the window closes after "Discard changes and close"', window.isDestroyed() === true || window.closed === true);
  check('the close dialog was shown for every close/quit attempt', dialogCalls.length === 3, dialogCalls);
}

app
  .whenReady()
  .then(run)
  .then(finish)
  .catch((error) => {
    check('run completed without an exception', false, String(error && error.stack ? error.stack : error));
    finish();
  });
