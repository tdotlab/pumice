import test from 'node:test';
import assert from 'node:assert/strict';
import menuModule from '../src/main/menu.js';

const { buildMenuTemplate } = menuModule;

function findItem(template, label) {
  for (const menu of template) {
    if (!Array.isArray(menu.submenu)) continue;
    const item = menu.submenu.find((entry) => entry.label === label);
    if (item) return item;
  }
  return undefined;
}

function findMenu(template, label) {
  return template.find((menu) => menu.label === label);
}

test('the File menu offers Open vault with the platform shortcut', () => {
  const actions = [];
  const template = buildMenuTemplate({ onAction: (action) => actions.push(action) });
  const item = findItem(template, 'Open vault…');

  assert.ok(item, 'Open vault… is missing from the menu');
  assert.equal(item.accelerator, 'CmdOrCtrl+O');
  item.click();
  assert.deepEqual(actions, ['open-vault']);
});

test('the File menu carries standard close and quit roles', () => {
  const template = buildMenuTemplate({});
  const roles = findMenu(template, 'File').submenu.map((item) => item.role).filter(Boolean);
  assert.ok(roles.includes('close'));
  assert.ok(roles.includes('quit'));
});

test('developer tools are only offered on a development build', () => {
  const devTemplate = buildMenuTemplate({ isDev: true });
  const prodTemplate = buildMenuTemplate({ isDev: false });
  const devRoles = findMenu(devTemplate, 'View').submenu.map((item) => item.role);
  const prodRoles = findMenu(prodTemplate, 'View').submenu.map((item) => item.role);

  assert.ok(devRoles.includes('toggleDevTools'));
  assert.equal(prodRoles.includes('toggleDevTools'), false);
  assert.ok(prodRoles.includes('reload'));
});

test('the Help menu reports About without throwing when no handler is supplied', () => {
  const actions = [];
  const about = findItem(
    buildMenuTemplate({ appName: 'Pumice', onAction: (action) => actions.push(action) }),
    'About Pumice',
  );
  assert.ok(about);
  about.click();
  assert.deepEqual(actions, ['about']);

  assert.doesNotThrow(() => buildMenuTemplate({}).flatMap((menu) => menu.submenu ?? [])
    .filter((item) => typeof item.click === 'function')
    .forEach((item) => item.click()));
});
