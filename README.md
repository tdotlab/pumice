# Pumice

An independent experiment building a lightweight desktop shell for
plain-Markdown vaults, informed by Mike's Pumice crew roles. Mike's checkout is
a separate project and remains untouched.

## Status

This repository contains a runnable **desktop app with its first editing
workflow**: one window, menu, vault/editor layout, a sandboxed preload bridge,
safe Markdown storage, and the open → browse → edit → save path.

You can open a folder of Markdown notes, list them, open a note in a plain-text
editor, and save it atomically. If another program changes the note, Pumice
refuses to overwrite it and offers **Reload from disk** or an explicit
**Overwrite with my version**. It does not yet preview Markdown, highlight
syntax, search, create/delete/rename notes, or watch the filesystem live.

Do not test on an irreplaceable vault. This milestone was exercised only on
copied fixture vaults; no production vaults were used.

## Stack

Electron 45 with plain HTML, CSS and ES modules — no bundler, no frontend
framework, no runtime npm dependencies. Electron gives the main/renderer split
that matches Mike's concept: a Node main process owns windows, menus and
lifecycle, while a sandboxed renderer owns the UI and receives data over a
narrow preload bridge.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full rationale,
security posture, file ownership, integration interface and known limits.

## Requirements

- Node.js **>= 24.15** (the renderer tests use jsdom 31's supported engine
  range; development used Node 24.22.1)
- npm **>= 11**
- Linux desktop requirements for the real window: GTK 3 (`libgtk-3.so.0`),
  NSS, GBM, XKB, a display server (X11 or Wayland), or the headless path below
- No Rust toolchain, Python packages, database or external service required

Electron is a dev dependency; `npm install` downloads its ~275 MB prebuilt
runtime once.

## Run

```bash
npm install
npm test          # 141 behavioural tests, no display needed
npm start         # opens the app; use a copied vault
```

Headless smoke run (real Electron process, real renderer, no display server).
It opens a throwaway copy of `test/fixtures/smoke-vault`, opens the first note,
types into it, saves, verifies the text on disk, and deletes the copy:

```bash
npm run smoke:headless
```

It prints one `PUMICE_SMOKE_RESULT {...}` line and exits 0 only when the window
loads, the preload bridge and app version reach the renderer, the layout regions
paint with non-zero size, and the full open/edit/save flow is confirmed on disk.
The renderer must report no errors.

On a machine without system GTK 3, point `PUMICE_LOCAL_PREFIX` at an extracted
runtime prefix containing `usr/lib/x86_64-linux-gnu` and `usr/share`:

```bash
PUMICE_LOCAL_PREFIX=/path/to/extracted-prefix npm run smoke:headless
```

That is how this shell was verified in an environment with no display, no Xvfb
and no GTK installed system-wide. The local prefix lives outside the repository;
it is not committed.

Optional screenshot during a successful smoke run:

```bash
PUMICE_SMOKE_SCREENSHOT=/tmp/pumice.png npm run smoke:headless
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Launch the app |
| `npm test` | Run the shell, vault core, session, IPC and renderer tests |
| `npm run test:shell` | Renderer/shell tests only (`*.test.mjs`) |
| `npm run test:vault` | Vault core tests only (`*.test.js`) |
| `npm run smoke` | Load the real window and drive open/edit/save (needs a display) |
| `npm run smoke:headless` | Same smoke run through Chromium's Ozone headless platform |

## What works now

- 1180×780 window with a 760×480 layout floor, warm stone palette, native frame
- Hidden until the renderer is ready to paint, then shown
- Single-instance lock; a second launch focuses the existing window
- Platform lifecycle: quit on window-all-closed outside macOS, recreate on
  macOS activate
- File menu with `Open vault…` (`CmdOrCtrl+O`), close and quit; View menu with
  reload/zoom and developer tools in development; Window menu; native About box
- Sandboxed renderer: `contextIsolation`, `sandbox`, no Node integration, strict
  CSP, no remote content
- **Open a vault** with a native folder picker, list its Markdown notes
  recursively (hidden files and symlinks skipped), and show them in the sidebar
- **Read a note** into a monospace textarea with a dirty badge, Save
  (Ctrl/Cmd+S) and Reload
- **Save atomically** through the vault core: temp file + fsync + rename,
  preserving the existing file mode; a failed write leaves the old note intact
- **Conflict safety**: saving over a note changed or deleted on disk is refused
  and the draft stays in the editor; explicit reload or overwrite are separate
  user actions
- **External-change check** when the window regains focus: clean notes reload
  with a warning, dirty notes keep their text
- Accessible file rows (button role, keyboard activation), labelled editor and
  a polite live status region
- All file access stays in the main process; the renderer only names vault
  paths, which the vault core confines to the opened root

## Known limits

- Plain textarea: no Markdown preview, syntax highlighting or WYSIWYG.
- No search, note creation/deletion, rename, recovery UI or live file watcher.
  External changes are noticed on save and on window focus, not instantly.
- Conflict checking is compare-then-atomic-rename without an OS file lock. A
  third-party write landing between the version check and the rename can be
  overwritten by the save and is not detected afterwards. Conflict handling is
  best-effort, not serializable; it covers edits that happened before the save
  starts.
- `writeMarkdown` requires the note's parent directory to exist; symlinks inside
  the vault are refused rather than followed.
- No packaging, installers, signing or auto-update.
- Linux-only verification here; macOS/Windows lifecycle is unit-tested only.
- No visible desktop was available in this environment, so the window was
  exercised through Electron's headless Ozone platform.

## Next milestone

Search over the open vault, then Markdown preview, note creation and recovery.
External changes, write failures and recovery need explicit tests. Use the
integration seams documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#integration-interface).

## Safety

- The renderer has no filesystem access; all IO goes through the main-process
  vault session, and paths are confined to the selected vault root.
- Writes are atomic and version-checked, so another program's changes are never
  silently overwritten.
- No telemetry, update check, remote assets or network requests at runtime.
- Tests and the smoke run write only to temporary directories; fixture vaults
  are copied into the OS temp dir and removed afterwards.
- No GitHub pushes or deployment are part of this work.
