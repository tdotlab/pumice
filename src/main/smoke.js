'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isInside } = require('./smoke-vault.js');

const REQUIRED_REGIONS = Object.freeze([
  ['hasShell', 'app shell'],
  ['hasSidebar', 'vault sidebar'],
  ['hasEditor', 'editor region'],
  ['hasStatusbar', 'status bar'],
  ['hasOpenVaultButton', 'Open vault button'],
]);

const LAYOUT_REGIONS = Object.freeze(['sidebar', 'editor', 'statusbar']);

/** The probe runs inside the renderer after the document has loaded. */
function buildSmokeScript() {
  return `(async () => {
    const probe = (id) => !!document.querySelector('[data-testid="' + id + '"]');
    const rect = (id) => {
      const element = document.querySelector('[data-testid="' + id + '"]');
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
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

    const bridge = window.pumice;
    const versionElement = document.querySelector('[data-testid="app-version"]');
    const started = Date.now();
    while (versionElement && versionElement.textContent === '' && Date.now() - started < 2000) {
      await sleep(25);
    }

    const snapshot = {
      title: document.title,
      hasShell: probe('app-shell'),
      hasSidebar: probe('sidebar'),
      hasEditor: probe('editor'),
      hasStatusbar: probe('statusbar'),
      hasOpenVaultButton: probe('open-vault-button'),
      hasPreloadBridge: !!bridge && typeof bridge.getAppInfo === 'function',
      version: versionElement ? versionElement.textContent : '',
      layout: {
        sidebar: rect('sidebar'),
        editor: rect('editor'),
        statusbar: rect('statusbar'),
      },
      rendererErrors: Array.isArray(window.__pumiceErrors) ? window.__pumiceErrors.slice() : ['rendererErrors not initialised'],
    };

    // Drive the real first workflow through the UI: open the (copied) vault,
    // open the first note, edit it and save. Main verifies the disk afterwards.
    const vaultFlow = {
      attempted: true,
      opened: false,
      noteOpened: false,
      edited: false,
      saved: false,
      path: null,
      marker: null,
      status: null,
      error: null,
    };

    try {
      const controller = await waitFor(() => window.pumiceVault || null, 5000);
      if (!controller) throw new Error('vault controller did not start');
      const openButton = document.querySelector('[data-testid="open-vault-button"]');
      if (!openButton) throw new Error('Open vault button is missing');
      openButton.click();

      const firstItem = await waitFor(
        () => document.querySelector('[data-testid="file-items"] li.file-item'),
        8000,
      );
      if (!firstItem) throw new Error('vault file list never populated');
      vaultFlow.opened = true;
      vaultFlow.path = firstItem.dataset.path;
      firstItem.click();

      const textarea = await waitFor(() => {
        const element = document.querySelector('[data-testid="note-editor"]');
        return element && !element.hidden ? element : null;
      }, 5000);
      if (!textarea) throw new Error('note editor never opened');
      vaultFlow.noteOpened = true;

      const marker = 'Smoke edit ' + Date.now();
      textarea.value = textarea.value.replace(/\\s*$/, '') + '\\n\\n' + marker + '\\n';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      vaultFlow.edited = true;
      vaultFlow.marker = marker;

      const saveButton = document.querySelector('[data-testid="save-note-button"]');
      if (!saveButton || saveButton.disabled) {
        throw new Error('save button was not enabled after editing');
      }
      saveButton.click();

      const savedStatus = await waitFor(() => {
        const status = document.querySelector('[data-testid="status-text"]');
        return status && /^Saved /.test(status.textContent.trim())
          ? status.textContent.trim()
          : null;
      }, 8000);
      if (!savedStatus) throw new Error('save was never confirmed in the status bar');
      vaultFlow.saved = true;
      vaultFlow.status = savedStatus;
    } catch (error) {
      vaultFlow.error = String(error && error.message ? error.message : error);
    }

    snapshot.vaultFlow = vaultFlow;
    return snapshot;
  })()`;
}

function validateSmokeSnapshot(snapshot, { expectVaultFlow = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, errors: ['renderer returned no snapshot'] };
  }

  const errors = [];
  if (snapshot.title !== 'Pumice') {
    errors.push(`unexpected document title: ${JSON.stringify(snapshot.title)}`);
  }
  for (const [key, label] of REQUIRED_REGIONS) {
    if (snapshot[key] !== true) errors.push(`missing ${key} (${label})`);
  }
  if (snapshot.hasPreloadBridge !== true) {
    errors.push('preload bridge window.pumice is unavailable');
  }
  if (typeof snapshot.version !== 'string' || !/^v\d+\./.test(snapshot.version)) {
    errors.push(`app version was not delivered to the renderer: ${JSON.stringify(snapshot.version)}`);
  }

  const layout = snapshot.layout;
  if (!layout || typeof layout !== 'object') {
    errors.push('layout metrics are missing');
  } else {
    for (const region of LAYOUT_REGIONS) {
      const box = layout[region];
      if (!box || !(box.width > 0) || !(box.height > 0)) {
        errors.push(`layout region ${region} has no painted size`);
      }
    }
    if (layout.sidebar && layout.editor) {
      const sidebarRight = layout.sidebar.x + layout.sidebar.width;
      if (sidebarRight > layout.editor.x + 1) errors.push('sidebar overlaps the editor');
    }
    if (layout.statusbar && layout.editor && layout.statusbar.y < layout.editor.y) {
      errors.push('status bar is not below the editor');
    }
  }

  if (!Array.isArray(snapshot.rendererErrors)) {
    errors.push('renderer error list is missing');
  } else if (snapshot.rendererErrors.length > 0) {
    errors.push(`renderer error: ${snapshot.rendererErrors.join('; ')}`);
  }

  if (expectVaultFlow) {
    const flow = snapshot.vaultFlow;
    if (!flow || typeof flow !== 'object') {
      errors.push('vault flow was not attempted');
    } else {
      const reason = flow.error ? `: ${flow.error}` : '';
      if (flow.opened !== true) errors.push(`vault did not open${reason}`);
      if (flow.noteOpened !== true) errors.push(`no note opened in the editor${reason}`);
      if (flow.edited !== true) errors.push(`no edit reached the note editor${reason}`);
      if (flow.saved !== true) errors.push(`save was not confirmed${reason}`);
      if (flow.diskContainsEdit !== true) errors.push('saved text was not found on disk');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Confirm from the main process that the renderer's save actually reached the
 * scratch vault on disk. Refuses paths that escape the vault root.
 */
function verifySavedNote({ vaultRoot, vaultFlow }) {
  if (!vaultRoot || !vaultFlow) return false;
  const relPath = vaultFlow.path;
  const marker = vaultFlow.marker;
  if (typeof relPath !== 'string' || relPath === '') return false;
  if (typeof marker !== 'string' || marker === '') return false;

  const absolute = path.resolve(vaultRoot, relPath);
  if (!isInside(vaultRoot, absolute)) return false;

  try {
    return fs.readFileSync(absolute, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

/**
 * Drive one real renderer load and exit the app with a meaningful status.
 * Used by `npm run smoke`; it cannot run without a usable display/compositor.
 * When `vaultRoot` is provided the run also exercises open -> edit -> save
 * against that copied vault and verifies the text on disk.
 */
function runSmokeTest({
  app,
  window,
  vaultRoot = null,
  timeoutMs = 20000,
  log = console.log,
  beforeExit = null,
}) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`PUMICE_SMOKE_RESULT ${JSON.stringify({ ok, ...details })}`);
      if (typeof beforeExit === 'function') {
        try {
          beforeExit();
        } catch (error) {
          log(`PUMICE_SMOKE_CLEANUP_ERROR ${String(error)}`);
        }
      }
      app.exit(ok ? 0 : 1);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      finish(false, { errors: [`timed out after ${timeoutMs}ms waiting for the renderer`] });
    }, timeoutMs);

    const webContents = window.webContents;
    webContents.once('did-fail-load', (_event, code, description, url) => {
      finish(false, { errors: [`did-fail-load ${code} ${description} ${url}`] });
    });
    webContents.once('did-finish-load', async () => {
      try {
        const snapshot = await webContents.executeJavaScript(buildSmokeScript());
        if (snapshot && typeof snapshot === 'object' && vaultRoot) {
          const flow = snapshot.vaultFlow && typeof snapshot.vaultFlow === 'object'
            ? snapshot.vaultFlow
            : {};
          flow.diskContainsEdit = verifySavedNote({ vaultRoot, vaultFlow: flow });
          snapshot.vaultFlow = flow;
        }
        const result = validateSmokeSnapshot(snapshot, { expectVaultFlow: Boolean(vaultRoot) });
        const details = { snapshot, errors: result.errors };

        const screenshotPath = process.env.PUMICE_SMOKE_SCREENSHOT;
        if (result.ok && screenshotPath) {
          try {
            // Give the compositor one frame to paint the version label that
            // arrived from the main process after load.
            await new Promise((resolve) => setTimeout(resolve, 200));
            const image = await webContents.capturePage();
            fs.writeFileSync(screenshotPath, image.toPNG());
            log(`PUMICE_SMOKE_SCREENSHOT ${screenshotPath}`);
          } catch (error) {
            details.screenshotError = String(error);
          }
        }

        finish(result.ok, details);
      } catch (error) {
        finish(false, { errors: [String(error)] });
      }
    });
  });
}

module.exports = {
  REQUIRED_REGIONS,
  buildSmokeScript,
  runSmokeTest,
  validateSmokeSnapshot,
  verifySavedNote,
};
