use crate::adapter::Session;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

// Fail closed until the editor has explicitly reported its state. Native close
// never decides to discard: the synchronous renderer guard alone may destroy
// the window after an explicit confirmation.
pub struct Dirty(pub AtomicBool);
impl Default for Dirty {
    fn default() -> Self {
        Self(AtomicBool::new(true))
    }
}
#[tauri::command]
pub fn set_dirty(state: State<'_, Dirty>, dirty: bool) {
    state.0.store(dirty, Ordering::SeqCst);
}

#[tauri::command]
pub async fn vault_open(app: AppHandle, session: State<'_, Session>) -> Result<Value, String> {
    // Async commands run off the GUI thread; blocking dialogs must not be
    // invoked directly from a window event on the main thread.
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(json!({"ok":false,"canceled":true}));
    };
    Ok(match selected.into_path() {
        Ok(root) => session.open(root),
        Err(_) => {
            json!({"ok":false,"error":{"code":"INVALID_PATH","message":"The selected folder is not a local path","path":null,"reason":null}})
        }
    })
}

#[tauri::command]
pub fn vault_list(session: State<'_, Session>) -> Value {
    session.list()
}

#[tauri::command]
pub fn vault_read(session: State<'_, Session>, path: String) -> Value {
    session.read(&path)
}

#[tauri::command]
pub fn vault_stat(session: State<'_, Session>, path: String) -> Value {
    session.stat(&path)
}

// Value, not Option<String>: the IPC deserializer rejects an omitted required
// field, while explicit null means the user confirmed an unchecked overwrite.
#[tauri::command]
pub fn vault_write(
    session: State<'_, Session>,
    path: String,
    content: String,
    expected_version: Value,
) -> Value {
    session.write(&path, &content, expected_version)
}
