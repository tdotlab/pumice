# Pumice

An independent experiment building a lightweight desktop shell for
plain-Markdown vaults, informed by Mike's Pumice crew roles. Mike's checkout is
a separate project and remains untouched.

## Status

This repository now contains a runnable **desktop shell**: one window, startup
and single-instance handling, an application menu, a basic vault/editor layout,
a minimal preload bridge, and an automated Electron smoke test.

It does **not** read, write, list or search any vault yet. The vault module owns
that work. The "Open vault" action currently reports intent to the future vault
module; it does not open a folder dialog and never touches disk.

Do not test on an irreplaceable vault. No production vaults were used here.

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
npm test          # 50 behavioural tests, no display needed
npm start         # opens the shell window
```

Headless smoke run (real Electron process, real renderer, no display server):

```bash
npm run smoke:headless
```

It prints one `PUMICE_SMOKE_RESULT {...}` line and exits 0 only when the window
loads, the preload bridge and app version reach the renderer, all layout regions
paint with non-zero size, the status bar sits below the editor, and the renderer
reported no errors.

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
| `npm start` | Launch the desktop shell |
| `npm test` | Run all behavioural tests with Node's built-in test runner |
| `npm run smoke` | Load the real window and validate it (needs a display) |
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
- Accessible shell landmarks (vault sidebar, editor, status bar), labelled
  controls and a polite live status region
- Renderer view model ready for vault data: vault name, Markdown file list,
  empty states, status messages with `ready`/`warning`/`error` states

## Next milestone (vault worker)

Open a copied test vault, browse and edit Markdown, save without corrupting
notes, then add search. External changes, write failures and recovery need
explicit tests. Use the integration seams documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#integration-interface).

## Safety

- The shell has no filesystem access from the renderer and performs no vault IO
  in the main process.
- No telemetry, update check, remote assets or network requests at runtime.
- Tests write nothing outside temporary process memory.
- No GitHub pushes or deployment are part of this work.
