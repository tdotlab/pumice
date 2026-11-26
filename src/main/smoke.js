'use strict';

const fs = require('node:fs');

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

    const bridge = window.pumice;
    const versionElement = document.querySelector('[data-testid="app-version"]');
    const started = Date.now();
    while (versionElement && versionElement.textContent === '' && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return {
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
  })()`;
}

function validateSmokeSnapshot(snapshot) {
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

  return { ok: errors.length === 0, errors };
}

/**
 * Drive one real renderer load and exit the app with a meaningful status.
 * Used by `npm run smoke`; it cannot run without a usable display/compositor.
 */
function runSmokeTest({ app, window, timeoutMs = 20000, log = console.log }) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`PUMICE_SMOKE_RESULT ${JSON.stringify({ ok, ...details })}`);
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
        const result = validateSmokeSnapshot(snapshot);
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

module.exports = { REQUIRED_REGIONS, buildSmokeScript, runSmokeTest, validateSmokeSnapshot };
