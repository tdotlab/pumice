import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import windowModule from '../src/main/window.js';

const { buildWindowOptions } = windowModule;
const PRELOAD = '/app/src/preload/preload.js';

test('the shell window has a usable default size and cannot shrink below the layout floor', () => {
  const options = buildWindowOptions({ preloadPath: PRELOAD });
  assert.equal(options.width, 1180);
  assert.equal(options.height, 780);
  assert.equal(options.minWidth, 760);
  assert.equal(options.minHeight, 480);
  assert.equal(options.backgroundColor, '#f6f4ef');
  assert.equal(options.title, 'Pumice');
});

test('the window stays hidden until the renderer is ready to paint', () => {
  const options = buildWindowOptions({ preloadPath: PRELOAD });
  assert.equal(options.show, false);
});

test('the renderer is isolated: context isolation on, node integration off, sandbox on', () => {
  const { webPreferences } = buildWindowOptions({ preloadPath: PRELOAD });
  assert.equal(webPreferences.preload, PRELOAD);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.sandbox, true);
  assert.notEqual(webPreferences.webSecurity, false);
  assert.notEqual(webPreferences.allowRunningInsecureContent, true);
});

test('window options refuse a relative preload path', () => {
  assert.throws(
    () => buildWindowOptions({ preloadPath: 'src/preload/preload.js' }),
    (error) => error instanceof TypeError && /absolute/i.test(error.message),
  );
});

test('window options resolve an absolute preload path unchanged', () => {
  const preloadPath = path.join('/app', 'src', 'preload', 'preload.js');
  assert.equal(buildWindowOptions({ preloadPath }).webPreferences.preload, preloadPath);
});
