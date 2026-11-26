# Pumice frontend

TypeScript/Vite renderer. Run `npm ci`, `npm test`, and `npm run build` in this directory. The desktop shell serves Vite in development and `dist/` in production.

`src/bridge.ts` defines the renderer/native contract. All commands return the existing `{ok:true,...}` / `{ok:false,error:{code,message,reason}}` envelopes. Commands: `vault_open`, `vault_list`, `vault_read` (`{path}`), `vault_stat` (`{path}`), `vault_write` (`{path,content,expectedVersion}`). `expectedVersion` is always present: a string for checked saves, null only following overwrite confirmation. Open returns a vault with `name`, `root`, and `files`; read/write/stat return `note` (stat may return null). The native layer owns filesystem access and the folder picker.

The native close guard starts blocked and remains blocked. The frontend installs a listener before enabling the editor; it checks local dirty/saving state and uses an in-document confirmation before `window.destroy`, requiring `core:window:allow-destroy`. The same dialog mechanism protects note/vault switching, reload and overwrite. Linux real-window close and note switching were exercised on a temporary fixture; other platforms and forced termination remain unverified. CSP is configured in the Tauri app rather than duplicated in HTML.
