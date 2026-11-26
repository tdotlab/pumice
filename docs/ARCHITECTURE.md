# Pumice shell architecture

## Scope

This document covers the desktop shell only: window creation, startup,
application menu, renderer layout, preload bridge, tests and the seams the vault
module will use. Vault storage, Markdown parsing, editing, saving and search are
out of scope and remain unimplemented.

## Stack decision

**Electron 45 + plain HTML/CSS/ES modules.** No bundler, no UI framework and no
runtime npm dependencies.

Why this stack:

1. **It matches the requested main/renderer concept.** The main process is Node
   with full OS access; the renderer is a sandboxed Chromium page that only sees
   what the preload bridge exposes. That boundary is the right place to keep
   vault IO away from UI code.
2. **The toolchain exists here.** There is no Rust toolchain on the target box,
   so Tauri was not viable without a large system change. Electron only needs
   Node and its downloaded binary.
3. **Small amount of bespoke code.** The shell is a few hundred lines of
   CommonJS/ES modules; the renderer is static files loaded with `loadFile`.
   No build step, no dev server, no source maps to maintain.
4. **Testable seams.** Window options, menu construction, lifecycle and IPC are
   pure functions over injected Electron-like objects, so they run under
   `node --test` without Electron or a display.

Trade-offs accepted: Electron adds a ~275 MB development download and a
Chromium-sized memory footprint, and Linux needs GTK 3 plus a display (or the
headless Ozone path). A native Qt app would be lighter at runtime but would
need a second language, a different UI model, and would not reproduce the
main/renderer web boundary Mike's concept describes.

## Process model

```
┌──────────────────────────── main process (Node) ────────────────────────────┐
│ src/main/main.js                                                            │
│   argv flags → single-instance lock → lifecycle → IPC → app.whenReady()     │
│   ├─ window.js      BrowserWindow options + loadFile(renderer/index.html)   │
│   ├─ menu.js        native menu; shell actions forwarded to renderer        │
│   ├─ lifecycle.js   window-all-closed / activate / second-instance          │
│   ├─ ipc.js         shell:get-app-info, shell:renderer-ready                │
│   └─ smoke.js       --smoke-test probe, validation, optional screenshot     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ contextBridge (preload, CJS)
┌───────────────────────────────────┴─────────────────────────────────────────┐
│ sandboxed renderer (local file, strict CSP)                                  │
│ index.html → styles.css                                                     │
│ ui.mjs        view model: vault title, file list, status, Open vault        │
│ renderer.mjs  boot, error capture, preload wiring, window.pumiceShell       │
└─────────────────────────────────────────────────────────────────────────────┘
```

Renderer settings: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webSecurity: true`, a preload script, and a CSP of
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`.
The renderer loads no remote content and makes no network requests.

## Startup sequence

1. Parse `--smoke-test` and `--devtools`; all other argv entries are ignored.
2. Acquire Electron's single-instance lock. A losing process quits before it
   builds a menu, window or IPC surface.
3. Register lifecycle, IPC handlers and the single-instance focus handler.
4. On `app.whenReady()`: set the native menu, create the window hidden, start
   the smoke probe when requested.
5. The renderer loads; `ready-to-show` fires and the window becomes visible.
6. The renderer calls `window.pumice.notifyReady()` after boot. The main process
   accepts the notification; nothing in the shell blocks on it.

## Layout contract

CSS grid: top bar 56px / workspace `1fr` / status bar 30px. The workspace is a
two-column grid with a 240–280px vault sidebar and a flexible editor.

| Region | Element | `data-testid` | Notes |
| --- | --- | --- | --- |
| App frame | `div.app-shell` | `app-shell` | 100vh grid |
| Top bar | `header[role=banner]` | — | brand, version (filled from `getAppInfo`) |
| Vault sidebar | `aside[aria-label=Vault]` | `sidebar` | title, Open vault button, file list |
| Vault title | `h1` | `vault-title` | starts as "No vault open" |
| Open vault | `button[type=button]` | `open-vault-button` | always enabled |
| File list | `nav[aria-label="Vault files"]` | `file-list` | `hidden` until a vault exists |
| File list empty | `p` | `file-list-empty` | context-aware empty copy |
| File rows | `ul` > `li` | `file-items` | `li.file-item[data-path]` > `span.file-name` |
| Editor | `main[aria-label=Editor]` | `editor` | toolbar + scrollable body |
| Editor empty state | `div` | `editor-empty` | no note is open yet |
| Status bar | `footer[role=contentinfo]` | `statusbar` | `aria-live=polite` |
| Status text | `span` | `status-text` | `data-state=ready\|warning\|error` |

Window: 1180×780 requested content size, 760×480 minimum, warm stone
background `#f6f4ef`, native frame. The headless Ozone compositor used for
verification reports a 760×480 content viewport (its virtual screen
constraint), and the smoke test validated the layout at that floor.

## Integration interface

The shell deliberately exposes only a few stable seams. The vault module should
extend these rather than reaching around them.

### Preload API — `window.pumice`

Built directly in `src/preload/preload.js` (self-contained: sandboxed preloads
cannot require local modules) and frozen before being exposed:

```ts
interface PumiceApi {
  getAppInfo(): Promise<{
    name: 'Pumice';
    version: string;
    electron: string | null;
    platform: NodeJS.Platform;
    isDev: boolean;
  }>;
  notifyReady(): void;                     // sends shell:renderer-ready
  onMenuAction(
    callback: (action: 'open-vault' | 'about') => void
  ): () => void;                           // returns unsubscribe
}
```

The bridge validates menu action names and never exposes `ipcRenderer`,
`invoke`, `send` or Node primitives.

### IPC channels owned by the shell

| Direction | Channel | Kind | Payload |
| --- | --- | --- | --- |
| renderer → main | `shell:get-app-info` | `invoke`/`handle` | none → app info object |
| renderer → main | `shell:renderer-ready` | `send`/`on` | none |
| main → renderer | `shell:menu-action` | `send`/`on` | `'open-vault' \| 'about'` |

`about` is handled natively in the main process with a message box and is not
forwarded. The vault module must add its own `vault:` channels in a separate
module; it should not overload the `shell:` namespace.

### Renderer seams

- `document` receives `pumice:open-vault-requested` (bubbling `CustomEvent`)
  when the user clicks **Open vault** or uses `File → Open vault…`. This is a
  request only; no folder dialog exists yet.
- After boot, `document` receives `pumice:shell-ready` with
  `{ detail: { view } }`.
- `window.pumiceShell` is the live view:

```ts
interface ShellView {
  setVault(vault: { name: string; files: Array<{ name?: string; path?: string }> } | null): void;
  setStatus(message: string, state?: 'ready' | 'warning' | 'error'): void;
  getState(): { vault: string; fileCount: number; status: string; statusState: string };
  handleMenuAction(action: string): boolean;
  destroy(): void;
}
```

`setVault(null)` restores "No vault open". File rows are rendered with
`textContent` (never `innerHTML`), so vault-controlled names cannot inject
markup. `path` is currently only a stable row identifier; the shell never opens
it.

### Wiring the vault module

1. Add `src/vault/` with its own main-process module and `vault:` IPC handlers.
   Validate that requested paths stay inside the opened vault root.
2. Extend `src/preload/preload.js` with the minimal vault calls (for example
   `selectVault()`, `listFiles()`, `readNote()`, `writeNote()`), keeping the
   object frozen, the file self-contained, and the tests updated for the bridge
   surface.
3. In the renderer, listen for `pumice:open-vault-requested`, call
   `selectVault()`, then `window.pumiceShell.setVault({ name, files })`.
4. Listen for file-row activation (the vault module can delegate a click handler
   on `li.file-item` or add its own `data-*` attribute), read the file, and
   replace the editor empty state with the note view.
5. Report IO failures through `setStatus(message, 'error' | 'warning')`; never
   write outside the selected vault and never touch Mike's checkout.

Tests for the vault module must use copied fixture vaults. This shell performs
no file IO at all, which is why its tests need no fixtures.

## Tests

Run with `npm test`. Node's test runner discovers `test/*.test.mjs`; jsdom loads
the real `src/renderer/index.html`.

| File | Covers |
| --- | --- |
| `cli.test.mjs` | startup flags, unknown argv ignored |
| `window-options.test.mjs` | size floor, hidden start, sandbox/context isolation, absolute preload |
| `menu.test.mjs` | Open vault accelerator, close/quit roles, dev-only devtools, About |
| `lifecycle.test.mjs` | platform quit behaviour, activate focus/recreate, single instance |
| `ipc.test.mjs` | exact shell channels, app-info payload, renderer-ready, action validation |
| `preload-api.test.mjs` | executes the real preload source in a VM: only requires electron, one frozen bridge, invoke/send channels, unsubscribe, filtering |
| `renderer-shell.test.mjs` | CSP, single module script, landmarks, empty states, status defaults |
| `renderer-ui.test.mjs` | open request, vault/file rendering, empty vault, reset, status states, XSS, destroy |
| `smoke.test.mjs` | smoke snapshot validation, including layout geometry |

Test-first evidence:

- Before implementation, `npm test` reported `tests 14 / pass 0 / fail 14`;
  every suite failed on missing `src/main/*` modules or `src/renderer/index.html`.
- After implementation, the suite reached `48 pass`; one test imported the
  renderer module with a default import instead of its named export, which was
  corrected in the test itself.
- The first real Electron smoke run showed no renderer errors but did not yet
  prove the preload bridge. A bridge/version probe was added and failed with
  `hasPreloadBridge:false`: sandboxed preloads cannot `require` local modules,
  so the original `preload.js` → `api.js` split never executed. The preload was
  made self-contained, its real source is now executed in a VM by the tests, and
  the smoke run passes with `hasPreloadBridge:true` and `version:"v0.1.0"`.
- Final suite: **50 tests, 50 pass, 0 fail**.

The Electron smoke run is separate from `npm test` because it launches a real
browser process. `npm run smoke:headless` prints one JSON line. Verified result
in this environment:

```json
{"ok":true,"snapshot":{"title":"Pumice","hasShell":true,"hasSidebar":true,
"hasEditor":true,"hasStatusbar":true,"hasOpenVaultButton":true,
"hasPreloadBridge":true,"version":"v0.1.0",
"layout":{"sidebar":{"x":0,"y":56,"width":240,"height":394},
"editor":{"x":240,"y":56,"width":520,"height":394},
"statusbar":{"x":0,"y":450,"width":760,"height":30}},
"rendererErrors":[]},"errors":[]}
```

A 760×480 screenshot from that run was visually inspected: brand/top bar,
240px sidebar with vault title and button, editor empty state, bottom status
bar; no overlaps, clipping or unstyled content.

## Environment notes and limits

- Verified on Linux x64 (Debian 13), Node 24.22.1, npm 11.19.1, Electron 45.5.0.
- This machine has no display server, no Xvfb and no system GTK 3. The real
  window could not be opened on a visible desktop here. The Electron binary and
  a local GTK runtime were extracted into a scratch prefix outside the repo and
  the app was run with Chromium's Ozone headless platform:
  `--ozone-platform=headless --disable-gpu --no-sandbox`.
- The app-level smoke test is real Electron: BrowserWindow, preload bridge,
  renderer module execution, layout geometry, error capture, screenshot. The
  only thing not exercised is presenting pixels to an X11/Wayland compositor.
- macOS/Windows lifecycle branches are covered by unit tests with injected
  platform values, not by running on those systems.
- There is no packaging, signing, auto-update, persistence, vault IO, editor or
  search yet. No production vault was opened or modified.
- No GitHub push, release or deployment was performed.
