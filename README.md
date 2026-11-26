# Pumice

An experimental desktop editor for plain-Markdown vaults. This is Hermes's
independent Pumice checkout; Mike's checkout is separate.

**Use copied test vaults only.** This early Rust/Tauri rewrite has not been
used on a real vault and is not ready for irreplaceable notes.

## Architecture

- `crates/pumice-core/`: Rust vault library for listing, reading and saving.
- `src-tauri/`: Rust desktop shell, vault session and Tauri IPC boundary.
- `frontend/`: TypeScript, HTML and CSS interface, built with Vite.

The frontend has no direct filesystem API. The Rust core owns file IO; the
native picker chooses the vault. Electron is no longer the intended runtime.

## Run and test

Install a Rust toolchain, Node/npm, a C compiler and Tauri's platform system
dependencies. On Linux these include GTK 3 and WebKitGTK 4.1 development
libraries and pkg-config. Then, at the repository root:

```sh
npm run setup             # install frontend dependencies from its lockfile
npm test                  # frontend and Rust core tests
npm start                 # build the frontend and run the Tauri app
```

A Linux Tauri build and open/edit/save were exercised inside an isolated Docker
container using a temporary vault. Windows and macOS have not been run.
The laptop itself lacks the GUI build dependencies; the container smoke test
does not establish that the app runs directly on the host.

## Scope and limitations

The first workflow opens a vault, lists Markdown notes, edits plain text and
saves. Checked saves detect earlier disk changes and offer reload or an
explicit overwrite. Non-UTF-8 notes are refused rather than silently converted;
line endings are preserved by the editor. No Markdown preview, highlighting,
search, creation, rename, deletion, live watcher, autosave or crash recovery
is implemented.

Writes use a temporary file and replacement, but conflict checks are not an
atomic compare-and-swap: a concurrent write between the check and replacement
can be overwritten. Directory/path checks are likewise not race-free against a
concurrent symlink swap. Neither case should be treated as a security boundary
against a hostile local process. Test only with copies, and keep backups.

This is an early build. The previous Electron implementation is preserved in
Git history.
