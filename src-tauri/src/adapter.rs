use pumice_core::{Vault, VaultError, WriteOptions};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
pub struct Session(Mutex<Option<Vault>>);

fn fail(error: VaultError) -> Value {
    json!({"ok": false, "error": error})
}
fn error(code: &str, message: &str, path: Option<&str>) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message, "path": path, "reason": null}})
}
fn object<T: Serialize>(item: T) -> Value {
    let mut value = serde_json::to_value(item).expect("core note is serializable");
    if let Some(map) = value.as_object_mut() {
        if let Some(path) = map.remove("relativePath") {
            let name = path
                .as_str()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_owned();
            map.insert("name".into(), Value::String(name));
            map.insert("path".into(), path);
        }
    }
    value
}
impl Session {
    fn with_vault<F: FnOnce(&Vault) -> Value>(&self, f: F) -> Value {
        match self.0.lock() {
            Ok(lock) => match lock.as_ref() {
                Some(vault) => f(vault),
                None => error("NO_VAULT", "No vault is open", None),
            },
            Err(_) => error("VAULT_ERROR", "Vault session is unavailable", None),
        }
    }
    pub fn open(&self, root: impl AsRef<std::path::Path>) -> Value {
        let vault = match Vault::open(root) {
            Ok(v) => v,
            Err(e) => return fail(e),
        };
        let files = match vault.list(Default::default()) {
            Ok(v) => v.into_iter().map(object).collect::<Vec<_>>(),
            Err(e) => return fail(e),
        };
        let root = vault.root.to_string_lossy().into_owned();
        let name = vault
            .root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());
        match self.0.lock() {
            Ok(mut lock) => {
                *lock = Some(vault);
                json!({"ok":true,"vault":{"root":root,"name":name,"files":files}})
            }
            Err(_) => error("VAULT_ERROR", "Vault session is unavailable", None),
        }
    }
    pub fn list(&self) -> Value {
        self.with_vault(|v| match v.list(Default::default()) {
            Ok(files) => {
                json!({"ok":true,"files":files.into_iter().map(object).collect::<Vec<_>>()})
            }
            Err(e) => fail(e),
        })
    }
    pub fn read(&self, path: &str) -> Value {
        self.with_vault(|v| match v.read(path) {
            Ok(note) => json!({"ok":true,"note":object(note)}),
            Err(e) => fail(e),
        })
    }
    pub fn stat(&self, path: &str) -> Value {
        self.with_vault(|v| match v.read(path) {
            Ok(note) => {
                let mut note = object(note);
                if let Some(m) = note.as_object_mut() {
                    m.remove("content");
                }
                json!({"ok":true,"note":note})
            }
            Err(e) if e.code == "ENOENT" => json!({"ok":true,"note":null}),
            Err(e) => fail(e),
        })
    }
    pub fn write(&self, path: &str, content: &str, expected_version: Value) -> Value {
        let expected_version = match expected_version {
            Value::String(s) => Some(s),
            Value::Null => None,
            _ => {
                return error(
                    "INVALID_OPTIONS",
                    "expectedVersion must be a version string or explicit null",
                    Some(path),
                )
            }
        };
        self.with_vault(|v| {
            match v.write(
                path,
                content,
                WriteOptions {
                    expected_version,
                    ..Default::default()
                },
            ) {
                Ok(note) => json!({"ok":true,"note":object(note)}),
                Err(e) => fail(e),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_contract_preserves_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/a.md"), "original").unwrap();
        let session = Session::default();
        assert_eq!(session.list()["error"]["code"], "NO_VAULT");
        let opened = session.open(dir.path());
        assert_eq!(opened["ok"], true);
        assert_eq!(opened["vault"]["files"][0]["path"], "notes/a.md");
        assert_eq!(opened["vault"]["files"][0]["name"], "a.md");
        let note = session.read("notes/a.md");
        assert_eq!(note["note"]["content"], "original");
        assert!(note["note"].get("relativePath").is_none());
        assert!(session.stat("notes/a.md")["note"].get("content").is_none());
        assert_eq!(session.stat("missing.md")["note"], Value::Null);
        assert_eq!(session.open(dir.path().join("absent"))["ok"], false);
        assert_eq!(session.read("notes/a.md")["ok"], true); // failed open preserves session
        std::fs::write(dir.path().join("notes/a.md"), "external").unwrap();
        assert_eq!(
            session.write("notes/a.md", "draft", json!(true))["error"]["code"],
            "INVALID_OPTIONS"
        );
        let conflict = session.write("notes/a.md", "draft", note["note"]["version"].clone());
        assert_eq!(conflict["error"]["code"], "CONFLICT");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "external"
        );
        assert_eq!(
            session.write("notes/a.md", "draft", Value::Null)["ok"],
            true
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "draft"
        );
    }
}
