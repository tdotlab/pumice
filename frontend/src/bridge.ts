export interface NoteSummary { path: string; name: string; size: number; mtimeMs: number; utf8: boolean | null }
export interface Note { path: string; name: string; content: string; version: string; size: number; mtimeMs: number }
export type NoteMetadata = Omit<Note, 'content'>;
export interface Vault { name: string; root: string; files: NoteSummary[] }
export interface BridgeError { code: string; message: string; reason?: string | null; path?: string | null }
export type Result<T> = ({ ok: true } & T) | { ok: false; canceled?: boolean; error?: BridgeError };
export interface VaultBridge {
  openVault(): Promise<Result<{ vault: Vault }>>;
  listNotes(): Promise<Result<{ files: NoteSummary[] }>>;
  readNote(path: string): Promise<Result<{ note: Note }>>;
  writeNote(path: string, content: string, expectedVersion: string | null): Promise<Result<{ note: NoteMetadata }>>;
  statNote(path: string): Promise<Result<{ note: NoteMetadata | null }>>;
}
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function bridgeError(error: unknown): BridgeError {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const e = error as { code: string; message?: string; reason?: string | null; path?: string | null };
    return { ...e, message: e.message ?? e.code };
  }
  return { code: 'BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) };
}

/** Only this adapter invokes native commands. Results are serializable envelopes. */
export function createBridge(invoke: Invoke): VaultBridge {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<Result<T>> {
    try { return await invoke<Result<T>>(command, args); }
    catch (error) { return { ok: false, error: bridgeError(error) }; }
  }
  return {
    openVault: () => call('vault_open'),
    listNotes: () => call('vault_list'),
    readNote: path => call('vault_read', { path }),
    writeNote: (path, content, expectedVersion) => call('vault_write', { path, content, expectedVersion }),
    statNote: path => call('vault_stat', { path }),
  };
}
