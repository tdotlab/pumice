'use strict';

/**
 * Application menu. Shell-level actions are forwarded to the renderer as
 * validated menu actions; file and vault work stays outside this module.
 */
function buildMenuTemplate({ appName = 'Pumice', isDev = false, onAction } = {}) {
  const emit = (action) => () => {
    if (typeof onAction === 'function') onAction(action);
  };

  return [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open vault…',
          accelerator: 'CmdOrCtrl+O',
          click: emit('open-vault'),
        },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
    {
      role: 'help',
      submenu: [{ label: `About ${appName}`, click: emit('about') }],
    },
  ];
}

module.exports = { buildMenuTemplate };
