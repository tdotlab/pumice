# Pumice vault storage core — API

Small, GUI-independent Node.js module that performs every filesystem operation
the Pumice desktop app needs for a plain-Markdown vault. It has no Electron, GUI
or third-party dependencies, so it belongs in the desktop **main** process (the
renderer must reach it over IPC).

- Runtime: Node.js >= 20 (tested on Node 24), CommonJS.
- Entry point: `src/index.js` (`require('pumice-vault-core')` once packaged;
  `require('./src/index.js')` from this repository).
- Tests: `npm test` → `node --test test/*.test.js`.

## Quick start (desktop main process)

```js
const { Vault, VaultConflictError, VaultError } = require('./src/index.js');

// 1. The user picks a folder with the native dialog; we only validate/open it.
const vault = await Vault.open('/home/me/Vaults/notes');

// 2. Browse
const notes = await vault.listMarkdown();            // [{ relativePath, size, mtimeMs }]
const note = await vault.readMarkdown('journal/2026-11-26.md');

// 3. Save, refusing to clobber an edit made by another program since the read.
try {
  const saved = await vault.writeMarkdown('journal/2026-11-26.md', nextContent, {
    expectedVersion: note.version
  });
  // saved.version / saved.mtimeMs describe the bytes now on disk.
} catch (err) {
  if (err instanceof VaultConflictError) {
    // err.reason === 'modified' | 'deleted'
    // Reload from disk (vault.readMarkdown) or ask the user to overwrite.
  } else {
    throw err;
  }
}
```

An IPC layer in the main process is a thin wrapper:

```js
ipcMain.handle('vault:open', (_e, dir) => Vault.open(dir));
ipcMain.handle('vault:list', (_e, dir) =>
  withVault(dir).listMarkdown());
ipcMain.handle('vault:read', (_e, dir, rel) =>
  withVault(dir).readMarkdown(rel));
ipcMain.handle('vault:write', (_e, dir, rel, content, expectedVersion) =>
  withVault(dir).writeMarkdown(rel, content, { expectedVersion }));
```

Keep the `Vault` instance cached in the main process rather than re-opening it
per call; `Vault.open` is cheap but the instance holds the validated real root.

## `Vault.open(rootPath, options?) → Promise<Vault>`

Validates that `rootPath` is an existing, readable directory, resolves it with
`realpath` (so a symlinked vault root is accepted and pinned to its real path),
and returns a vault handle. Nothing is created, modified or deleted.

Options:

| option       | default                                  | meaning                                     |
| ------------ | ---------------------------------------- | ------------------------------------------- |
| `extensions` | `['.md', '.markdown', '.mdown', '.mkd']` | Markdown extensions, case-insensitive; `'md'` is normalised to `'.md'`. |

Rejects with `INVALID_PATH` for an empty/non-string path, `ENOENT` for a
missing directory, `ENOTDIR` for a regular file, `EACCES` when unreadable.

## `vault.root` → string

Absolute, symlink-resolved vault root. All paths returned by the API are
relative to it and use `/` separators on every platform.

## `vault.listMarkdown(options?) → Promise<Entry[]>`

Walks the vault and returns regular Markdown files, sorted by `relativePath`.
Each entry is `{ relativePath, size, mtimeMs }`; contents are not read.

| option          | default | meaning                                                |
| --------------- | ------- | ------------------------------------------------------ |
| `recursive`     | `true`  | Recurse into subdirectories.                           |
| `includeHidden` | `false` | Include files/directories whose name starts with `.`.  |

- Symlinks are never listed, followed or recursed into.
- Non-Markdown files, and directories whose name merely ends in `.md`, are not
  listed as notes.
- A note deleted while the walk is running is skipped.

## `vault.readMarkdown(relativePath) → Promise<Note>`

Returns `{ relativePath, content, version, size, mtimeMs }`.

- `content` is the file decoded as UTF-8. `size` is the byte length and
  `version` is the sha256 hex digest of the file bytes (`content` is lossless
  for UTF-8 files; BOMs and CRLF line endings are preserved as-is).
- `relativePath` is the canonical vault-relative path (`notes/../a.md` →
  `a.md`).
- Rejects with `NOT_MARKDOWN`, `INVALID_PATH`, `SECURITY`, `ENOENT`, `EISDIR`.
- Hidden notes can be read by naming them explicitly; hidden filtering only
  affects listing.

## `vault.writeMarkdown(relativePath, content, options?) → Promise<SavedNote>`

Creates or replaces one Markdown note and returns
`{ relativePath, version, size, mtimeMs }` for the bytes now on disk.

Options (optional; use one, `expectedVersion` preferred):

| option            | meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `expectedVersion` | The `version` from a prior `readMarkdown`. If the current bytes hash differently the write is refused with `CONFLICT` / `reason: 'modified'`; if the note is gone, `CONFLICT` / `reason: 'deleted'`. |
| `expectedMtimeMs` | The `mtimeMs` from a prior read. Refused with `CONFLICT` if the note's mtime differs (or the note is gone). Stricter than versions: touching a file with unchanged content also conflicts. |

With neither option the call is an unconditional create-or-overwrite (use it
for brand-new notes only). The existing note mode (permissions) is preserved;
new notes are created with the process umask applied (`0o666 & ~umask`).

### Atomicity and failure behaviour

1. The existing note is read and checked against the expectation *before*
   anything is written.
2. New bytes go to an exclusive temporary file in the same directory, are
   `fsync`ed, and get the original file's mode.
3. `rename(2)` atomically replaces the target; the directory is `fsync`ed on a
   best-effort basis.
4. Any failure before the rename closes and deletes the temporary file and
   rethrows without touching the existing note: **a failed write always leaves
   the previous contents intact** (covered by a real `EACCES` test).

Concurrent writers cannot interleave bytes: readers and later writers see
either the complete old note or the complete new one.

### Conflict-check scope

The conflict check is a compare-then-replace against the bytes observed at the
start of `writeMarkdown`. There is no OS file lock, so a third-party program
that writes in the small window between the check and the atomic rename can be
overwritten by this save and is not detected afterwards. Within the app's own
serialized saves this is not an issue. Idle detection/refresh should re-read on
window focus.

## `vault.isMarkdown(relativePath) → boolean`

Extension check using the vault's configured extension list.

## Errors

All deliberate failures are instances of `VaultError` with a stable `code`:

| code             | raised for                                                                 |
| ---------------- | ------------------------------------------------------------------------- |
| `INVALID_PATH`   | non-string/empty path, absolute path, NUL byte                             |
| `SECURITY`       | path resolves outside the vault root, or a symlink is involved             |
| `CONFLICT`       | external change detected (`VaultConflictError`, `.reason` is `modified` or `deleted`) |
| `NOT_MARKDOWN`   | target extension is not in the vault's Markdown list                       |
| `ENOENT`         | vault, note or parent directory does not exist                             |
| `ENOTDIR`        | vault path (or a path component) is not a directory                        |
| `EISDIR`         | target is a directory                                                       |
| `INVALID_TARGET` | target is a special file (FIFO, socket, device)                             |
| `INVALID_CONTENT`| note content is not a string                                                |
| `INVALID_OPTIONS`| malformed `extensions` / expectation arguments                             |
| other `errno`    | read/write failures are wrapped with the underlying `err.code` in `code` and the original error in `cause` |

`VaultConflictError` also exposes `expectedVersion`, `actualVersion`,
`expectedMtimeMs`, `actualMtimeMs` where applicable; `VaultSecurityError` is
the `SECURITY` subtype.

## Security model

- **Containment.** Every note path must be non-absolute and, after
  `path.resolve(root, ...)`, remain strictly inside the vault root. `..`
  components that normalise back inside the vault are allowed; any escape is
  `SECURITY`.
- **Symlinks.** Symlinks are refused, not followed: reads and writes reject a
  symlinked final component (even when it points inside the vault), a symlinked
  parent directory that resolves outside the vault is `SECURITY`, and listing
  skips symlinks and never recurses through symlinked directories. Final
  components are opened with `O_NOFOLLOW` to narrow swap races.
- **No writes outside the vault.** Temporary files are created next to the
  target, never in a shared temp directory; failed writes clean them up.
- **Hidden files** are hidden from listing by default (`includeHidden: true`
  opts in), but the API never treats a name starting with `.` as special
  otherwise.

## Desktop integration

The app consumes this API only in the main process, through
`src/main/vault-session.js`:

- `VaultSession` holds the one open vault (`open`, `close`, `list`, `read`,
  `write`, `stat`) and adds `path`/`name` display metadata.
- `src/main/vault-ipc.js` exposes it on the `vault:` IPC channels and converts
  errors to `{ ok: false, error: { code, reason, message, path } }` envelopes,
  because Electron does not preserve custom error properties across IPC.
- The renderer's `writeNote` passes the `version` from the last read as
  `expectedVersion`; only an explicit, user-confirmed **Overwrite** sends
  `null`.

`stat(relPath)` is an app-level convenience: it reads and hashes the current
file (returning `null` when it no longer exists) so the editor can compare
versions on window focus without holding file handles open.

## Out of scope (this milestone)

File watching, search indexing, folder create/rename/delete, attachments, and
any GUI code. The API is deliberately small; extend it in the main-process
module rather than letting the renderer touch the filesystem.
