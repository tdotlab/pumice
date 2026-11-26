# Pumice shell architecture

## Scope

This document covers the desktop shell and the first editing workflow: window,
startup, menu, renderer layout, preload bridge, the vault IPC surface, and the
open → browse → edit → save path. Markdown parsing, preview, highlighting,
search, creation/deletion of notes and recovery are out of scope and remain
unimplemented.

Implemented in the first vertical slice:

- open a vault folder (copied test vaults only in this milestone)
- list its Markdown notes and open one in a plain-text editor
- save atomically through the vault core, with external-change detection
- refuse to clobber a note another program changed, and let the user reload or
  explicitly overwrite
- notice an external change when the window regains focus

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
│   ├─ close-guard.js dirty-close dialog on will-prevent-unload               │
│   ├─ ipc.js         shell:get-app-info, shell:renderer-ready                │
│   ├─ vault-session.js  one open vault over src/vault.js (list/read/write)   │
│   ├─ vault-ipc.js      vault:* channels, plain-data result envelopes        │
│   └─ smoke.js       --smoke-test probe, vault flow, optional screenshot     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ contextBridge (preload, CJS)
┌───────────────────────────────────┴─────────────────────────────────────────┐
│ sandboxed renderer (local file, strict CSP)                                  │
│ index.html → styles.css                                                     │
│ ui.mjs          shell view: vault title, file list, status, Open vault      │
│ vault-ui.mjs    controller: open/list/read/edit/save/conflict handling      │
│                 + encoding refusal + dirty-close beforeunload               │
│ renderer.mjs    boot, error capture, preload wiring, window.pumiceShell     │
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

The shell and the vault session meet at three narrow seams: the frozen preload
bridge, the `vault:` IPC channels, and the shell view. Everything else — path
validation, atomic writes, conflict detection — lives in `src/vault.js` behind
the main process boundary.

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

  openVault(): Promise<VaultResult>;
  listNotes(): Promise<VaultResult>;
  readNote(path: string): Promise<VaultResult>;
  statNote(path: string): Promise<VaultResult>;
  writeNote(
    path: string,
    content: string,
    expectedVersion?: string | null
  ): Promise<VaultResult>;
}
```

The bridge validates argument types (non-empty string path, string content,
string-or-null version) and never exposes `ipcRenderer`, `invoke`, `send` or
Node primitives.

### IPC channels

The shell owns `shell:`; the vault session owns `vault:`. Neither overloads the
other.

| Direction | Channel | Kind | Payload |
| --- | --- | --- | --- |
| renderer → main | `shell:get-app-info` | `invoke`/`handle` | none → app info object |
| renderer → main | `shell:renderer-ready` | `send`/`on` | none |
| main → renderer | `shell:menu-action` | `send`/`on` | `'open-vault' \| 'about'` |
| renderer → main | `vault:open` | `invoke`/`handle` | none → `{ ok, vault }` or `{ ok: false, canceled }` |
| renderer → main | `vault:list` | `invoke`/`handle` | none → `{ ok, files }` |
| renderer → main | `vault:read` | `invoke`/`handle` | note path → `{ ok, note }` |
| renderer → main | `vault:stat` | `invoke`/`handle` | note path → `{ ok, note \| null }` |
| renderer → main | `vault:write` | `invoke`/`handle` | `{ path, content, expectedVersion }` → `{ ok, note }` |

Every vault handler resolves with a plain-data envelope:
`{ ok: true, ... }` or `{ ok: false, canceled?: true, error: { code, name,
message, path, reason } }`. Errors are converted in `vault-ipc.js` because
Electron only preserves an error message across IPC; the editor needs
`code: 'CONFLICT'` and `reason: 'modified' | 'deleted'` to react correctly. No
stack traces are sent to the renderer.

`vault:open` shows a native folder picker. The smoke run substitutes a copied
fixture vault for the picker, which is how the full open/edit/save path is
exercised without a human.

### Renderer seams

- `document` receives `pumice:open-vault-requested` (bubbling `CustomEvent`)
  when the user clicks **Open vault** or uses `File → Open vault…`.
  `renderer.mjs` forwards it to `controller.openVault()`.
- After boot, `document` receives `pumice:shell-ready` with
  `{ detail: { view } }`.
- `window.pumiceShell` is the shell view:

```ts
interface ShellView {
  setVault(vault: { name: string; files: Array<{ name?: string; path?: string }> } | null): void;
  setStatus(message: string, state?: 'ready' | 'warning' | 'error'): void;
  getState(): { vault: string; fileCount: number; status: string; statusState: string };
  handleMenuAction(action: string): boolean;
  destroy(): void;
}
```

- `window.pumiceVault` is the editing controller (exposed for the smoke probe;
  it is not a general-purpose API):

```ts
interface VaultController {
  openVault(): Promise<VaultResult>;
  openNote(path: string): Promise<VaultResult>;
  save(options?: { force?: boolean }): Promise<VaultResult>;
  overwrite(): Promise<VaultResult>;
  reload(options?: { quiet?: boolean }): Promise<VaultResult>;
  checkForExternalChange(): Promise<void>;
  getState(): { vault; note; version; dirty; saving; externalChange; bannerVisible };
  destroy(): void;
}
```

`setVault(null)` restores "No vault open". File rows are rendered with
`textContent` (never `innerHTML`), so vault-controlled names cannot inject
markup. `path` is the stable row identifier and the only note identifier the
renderer ever sends; the main process resolves it inside the open vault root
and the vault core rejects traversal, absolute paths, NUL bytes and symlinks.

### First editing workflow

`src/renderer/vault-ui.mjs` is the state machine:

1. **Open** — `vault:open` returns the vault name plus sorted Markdown entries.
   The shell view renders them; the editor returns to its empty state.
2. **Read** — activating a row (click, Enter or Space) calls `vault:read`. The
   note body fills the textarea, and the returned `version` (sha256 of the
   bytes) becomes the expected version for the next save.
3. **Edit** — typing compares the textarea against the loaded text; the dirty
   badge and Save button follow. Switching notes or reopening a vault with
   unsaved edits asks for confirmation first.
4. **Save** — `vault:write` with the read version (button or Ctrl/Cmd+S). The
   vault core writes a temp file, fsyncs and atomically renames it, so a crash
   or failure leaves the previous note intact. Success updates the version
   token and status; text typed while a save was in flight stays dirty.
5. **Conflict** — if the note changed (or disappeared) on disk, the core returns
   `CONFLICT` and leaves the disk copy untouched. The controller keeps the draft
   in the editor, explains what happened, and offers **Reload from disk** or an
   explicit **Overwrite with my version** (a deliberate unchecked save).
6. **External change while open** — on window focus the controller calls
   `vault:stat`. A clean note is reloaded quietly with a warning; a dirty note
   keeps its text and shows the conflict banner. No automatic write ever
   happens.

The editor is a plain monospace `<textarea>`: no contenteditable, no renderer
framework, consistent with the shell's no-build stack. Markdown is stored as
text; preview and highlighting are future work.

### Wiring summary

1. `src/vault.js` (core, tested separately) provides `Vault.open`,
   `listMarkdown`, `readMarkdown`, `writeMarkdown`.
2. `src/main/vault-session.js` holds the one open vault and adds display
   metadata (note name, path).
3. `src/main/vault-ipc.js` registers the five `vault:` handlers and converts
   errors to envelopes.
4. `src/preload/preload.js` exposes type-checked vault calls on `window.pumice`.
5. `src/renderer/vault-ui.mjs` drives the UI from those results; the shell view
   in `ui.mjs` owns only chrome. IO failures surface through `setStatus(...,
   'error' | 'warning')` and the banner; no path outside the selected vault is
   ever written, and Mike's checkout is never touched.

The renderer performs no file IO. Session and IPC tests build real temporary
vaults; the app-level smoke run uses a copy of `test/fixtures/smoke-vault` in
the OS temp directory and removes it on exit. No test or smoke run opens a real
user vault.

## Tests

Run with `npm test`. Node's test runner discovers both `test/*.test.mjs` and
`test/*.test.js`; jsdom loads the real `src/renderer/index.html`.

| File | Covers |
| --- | --- |
| `cli.test.mjs` | startup flags, unknown argv ignored |
| `window-options.test.mjs` | size floor, hidden start, sandbox/context isolation, absolute preload |
| `menu.test.mjs` | Open vault accelerator, close/quit roles, dev-only devtools, About |
| `lifecycle.test.mjs` | platform quit behaviour, activate focus/recreate, single instance |
| `ipc.test.mjs` | exact shell channels, app-info payload, renderer-ready, action validation |
| `preload-api.test.mjs` | real preload source in a VM: one frozen bridge, shell and vault channels, argument validation, unsubscribe, filtering |
| `renderer-shell.test.mjs` | CSP, single module script, landmarks, empty states, editor markup defaults |
| `renderer-ui.test.mjs` | open request, vault/file rendering, empty vault, reset, status states, XSS, destroy |
| `renderer-vault.test.mjs` | open/cancel/error, read, edit/dirty, save, conflict, overwrite, reload, external change, deleted note, note switching, non-UTF-8 refusal, dirty-close beforeunload, destroy |
| `close-guard.test.mjs` | dirty-close dialog: discard allows the unload; keep-editing, a failing dialog and dispose keep it |
| `vault-session.test.mjs` | one open vault, listing, read/write, conflict/deleted, stat, NO_VAULT, traversal, non-Markdown, utf8 listing flag |
| `vault-ipc.test.mjs` | exact vault channels, envelopes, cancelled dialog, conflict, explicit overwrite, validation, error serialisation |
| `smoke.test.mjs` | snapshot/vault-flow validation, generated-script syntax and escaping, fixture copy/cleanup, disk verification |
| `open/list-read/write/security.test.js` | vault core safety, atomicity, conflict and byte-preservation tests |
| `encoding.test.js` | non-UTF-8 refusal (latin-1, UTF-16LE/BE with BOM), `utf8` listing flag, byte-identical BOM/CRLF round trip |

Test-first evidence for this slice:

- The new tests were written before the implementation. The red run reported
  `tests 100 / pass 91 / fail 9`: missing `src/main/vault-session.js`,
  `src/main/vault-ipc.js`, `src/main/smoke-vault.js`,
  `src/renderer/vault-ui.mjs`, missing editor markup, and the old preload and
  smoke contracts.
- After implementation: **141 tests, 141 pass, 0 fail** (`npm test`, exit 0) at
  that milestone; the suite has grown since (see the follow-up below).
  The red and green summaries are appended to `docs/red-green-log.txt`.

### Data-safety follow-up: non-UTF-8 notes and dirty close

QA found two data-loss defects at the first milestone (commit `fcacbdb`):
`readMarkdown` decoded with `buffer.toString('utf8')`, so saving a note that was
not UTF-8 permanently replaced its bytes with U+FFFD; and no close handler
existed, so the titlebar X or Quit discarded a dirty draft.

- **Encoding policy — refuse, never re-encode.** `readMarkdown` validates the
  bytes with `require('node:buffer').isUtf8` and raises `INVALID_ENCODING`
  instead of decoding. The listing reports `utf8` per note, the renderer tags
  such a note "not UTF-8", refuses to open it, and the status bar reports
  "not UTF-8" instead of assuming UTF-8. `writeMarkdown` also refuses to
  replace a non-UTF-8 file, so no path can rewrite one. UTF-8 with a BOM and
  CRLF still round-trip byte-identically.
- **Dirty close.** The renderer cancels `beforeunload` while the editor is
  dirty; `src/main/close-guard.js` answers Electron's `will-prevent-unload`
  with a *Keep editing / Discard changes and close* dialog and only calls
  `event.preventDefault()` (allowing the unload) when discarding is chosen. A
  dialog failure keeps the window. Quit goes through the same guard because it
  closes the window.

Test-first evidence for the follow-up:

- Red: the new tests were run before the implementation — `tests 58 / pass 43 /
  fail 15` in the focused run (encoding refusal, `utf8` listing flag, IPC
  `INVALID_ENCODING` and missing `expectedVersion`, renderer refusal banner and
  status meta, `beforeunload`, and the missing `close-guard.js`).
- Green: **165 tests, 165 pass, 0 fail** (`npm test`, exit 0).
- `npm run smoke:headless`: exit 0, `"ok":true`, `diskContainsEdit:true`,
  `rendererErrors:[]`.
- `npm run e2e:data-safety` (real Electron, headless Ozone, 24 checks): exit 0,
  `"ok":true` — latin-1 and UTF-16LE notes are listed and tagged, refused by
  `vault:read`/`vault:write` with `INVALID_ENCODING` while their bytes stay
  unchanged; a UTF-8 note opens and saves; the close dialog keeps the window
  and the draft on "Keep editing" (for both window close and Quit) and closes
  the window on "Discard changes and close".

The Electron smoke run is separate from `npm test` because it launches a real
browser process. It now drives the whole workflow through the UI — click **Open
vault**, click the first note, type, click **Save** — and the main process then
reads the copied vault from disk to confirm the saved text is really there.
`npm run smoke:headless` prints one JSON line. Verified result in this
environment:

```json
{"ok":true,"snapshot":{"title":"Pumice","hasShell":true,"hasSidebar":true,
"hasEditor":true,"hasStatusbar":true,"hasOpenVaultButton":true,
"hasPreloadBridge":true,"version":"v0.1.0",
"layout":{"sidebar":{"x":0,"y":56,"width":240,"height":394},
"editor":{"x":240,"y":56,"width":520,"height":394},
"statusbar":{"x":0,"y":450,"width":760,"height":30}},
"rendererErrors":[],
"vaultFlow":{"attempted":true,"opened":true,"noteOpened":true,"edited":true,
"saved":true,"path":"notes/daily.md","marker":"Smoke edit 1795722682241",
"status":"Saved notes/daily.md","error":null,"diskContainsEdit":true}},
"errors":[]}
```

The run exits 0 and leaves no temporary vault behind. Layout geometry is
checked at the 760×480 Ozone floor. Pixel-level appearance of the new editor
was not inspected by a human because this host has no visible display; the DOM
and geometry were verified instead.

## Environment notes and limits

- Verified on Linux x64 (Debian 13), Node 24.22.1, npm 11.19.1, Electron 45.5.0.
- This machine has no display server, no Xvfb and no system GTK 3. The real
  window could not be opened on a visible desktop here. The Electron binary and
  a local GTK runtime were extracted into a scratch prefix outside the repo and
  the app was run with Chromium's Ozone headless platform:
  `--ozone-platform=headless --disable-gpu --no-sandbox`.
- The app-level smoke test is real Electron: BrowserWindow, preload bridge,
  renderer modules, folder selection substitution, file listing, note read,
  text edit, save through IPC and vault core, and disk verification. The only
  thing not exercised is presenting pixels to an X11/Wayland compositor.
- macOS/Windows lifecycle branches are covered by unit tests with injected
  platform values, not by running on those systems.
- The editor is a plain textarea: no Markdown preview, syntax highlighting,
  wrapping toggle, or WYSIWYG. Markdown is stored verbatim as UTF-8 text; a note
  that is not valid UTF-8 is refused rather than converted.
- Unsaved work is protected only by the close dialog: there is no autosave,
  journal or crash recovery, and a crashed renderer cannot ask.
- There is no search, note creation/deletion, rename, recovery UI, or file
  watcher. External changes are detected on save (conflict) and when the window
  regains focus (version comparison); a change made while the app is focused
  and idle is not noticed until the next focus/save.
- The inherited vault-core limits still apply: conflict checking is
  compare-then-atomic-rename without an OS file lock, so a third-party write
  landing between the version check and the rename can be overwritten and is
  not detected afterwards (best-effort, not serializable conflict handling);
  `writeMarkdown` requires the parent directory to exist; symlinks are refused
  outright.
- There is no packaging, signing, auto-update, or persistence beyond the files
  themselves. No production or irreplaceable vault was opened or modified, and
  Mike's checkout was never touched.
- No GitHub push, release or deployment was performed.
