use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug)]
pub struct Vault {
    pub root: PathBuf,
    extensions: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub reason: Option<String>,
    pub expected_version: Option<String>,
    pub actual_version: Option<String>,
    pub expected_mtime_ms: Option<f64>,
    pub actual_mtime_ms: Option<f64>,
}
impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for VaultError {}
fn error(code: &str, path: Option<&str>) -> VaultError {
    VaultError {
        code: code.into(),
        message: code.into(),
        path: path.map(str::to_owned),
        reason: None,
        expected_version: None,
        actual_version: None,
        expected_mtime_ms: None,
        actual_mtime_ms: None,
    }
}
fn ioe(e: std::io::Error, path: Option<&str>) -> VaultError {
    use std::io::ErrorKind;
    #[cfg(unix)]
    let symlink_loop = e.raw_os_error() == Some(libc::ELOOP);
    #[cfg(not(unix))]
    let symlink_loop = false;
    let code = if symlink_loop {
        "SECURITY"
    } else {
        match e.kind() {
            ErrorKind::NotFound | ErrorKind::NotADirectory => "ENOENT",
            ErrorKind::PermissionDenied => "EACCES",
            ErrorKind::IsADirectory => "EISDIR",
            _ => "VAULT_ERROR",
        }
    };
    let mut err = error(code, path);
    err.message = e.to_string();
    err
}

#[cfg(test)]
mod io_error_tests {
    use super::ioe;
    use std::io::{Error, ErrorKind};

    #[test]
    fn maps_portable_error_kinds_without_raw_os_codes() {
        for (kind, code) in [
            (ErrorKind::NotFound, "ENOENT"),
            (ErrorKind::NotADirectory, "ENOENT"),
            (ErrorKind::PermissionDenied, "EACCES"),
            (ErrorKind::IsADirectory, "EISDIR"),
            (ErrorKind::Other, "VAULT_ERROR"),
        ] {
            assert_eq!(
                ioe(Error::from(kind), Some("note.md")).code,
                code,
                "{kind:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlink_loop_is_security_error() {
        assert_eq!(
            ioe(Error::from_raw_os_error(libc::ELOOP), None).code,
            "SECURITY"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_error_codes_are_not_interpreted_as_unix_errno() {
        for (raw, code) in [
            (2, "ENOENT"),
            (3, "ENOENT"),
            (5, "EACCES"),
            (21, "VAULT_ERROR"),
        ] {
            assert_eq!(ioe(Error::from_raw_os_error(raw), None).code, code, "{raw}");
        }
    }
}
fn mtime(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub relative_path: String,
    pub content: String,
    pub version: String,
    pub size: u64,
    pub mtime_ms: f64,
}
impl Vault {
    pub fn open_with_extensions(
        path: impl AsRef<Path>,
        extensions: Vec<String>,
    ) -> Result<Self, VaultError> {
        let mut vault = Self::open(path)?;
        if extensions.is_empty() || extensions.iter().any(|e| e.trim().is_empty()) {
            return Err(error("INVALID_OPTIONS", None));
        }
        vault.extensions = extensions
            .into_iter()
            .map(|e| e.trim().trim_start_matches('.').to_lowercase())
            .collect();
        Ok(vault)
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self, VaultError> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() || path.to_string_lossy().contains('\0') {
            return Err(error("INVALID_PATH", None));
        }
        let root = fs::canonicalize(path).map_err(|e| ioe(e, None))?;
        if !root.is_dir() {
            return Err(error("ENOTDIR", None));
        }
        Ok(Self {
            root,
            extensions: vec!["md".into(), "markdown".into(), "mdown".into(), "mkd".into()],
        })
    }
    fn resolve(&self, path: &str) -> Result<(PathBuf, String), VaultError> {
        if path.is_empty() || path.contains('\0') || Path::new(path).is_absolute() {
            return Err(error("INVALID_PATH", Some(path)));
        }
        let mut relative = PathBuf::new();
        for c in Path::new(path).components() {
            match c {
                Component::Normal(v) => relative.push(v),
                Component::CurDir => {}
                Component::ParentDir => {
                    if !relative.pop() {
                        return Err(error("SECURITY", Some(path)));
                    }
                }
                _ => return Err(error("INVALID_PATH", Some(path))),
            }
        }
        if relative.as_os_str().is_empty() {
            return Err(error("SECURITY", Some(path)));
        }
        let api = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !relative
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| self.extensions.contains(&e.to_lowercase()))
            .unwrap_or(false)
        {
            return Err(error("NOT_MARKDOWN", Some(&api)));
        }
        Ok((self.root.join(relative), api))
    }
    fn existing(&self, target: &Path, api: &str) -> Result<(Vec<u8>, fs::Metadata), VaultError> {
        let meta = fs::symlink_metadata(target).map_err(|e| ioe(e, Some(api)))?;
        if meta.file_type().is_symlink() {
            return Err(error("SECURITY", Some(api)));
        }
        if meta.is_dir() {
            return Err(error("EISDIR", Some(api)));
        }
        if !meta.is_file() {
            return Err(error("INVALID_TARGET", Some(api)));
        }
        let real = fs::canonicalize(target).map_err(|e| ioe(e, Some(api)))?;
        if !real.starts_with(&self.root) || real == self.root {
            return Err(error("SECURITY", Some(api)));
        }
        let mut opts = fs::OpenOptions::new();
        opts.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.custom_flags(libc::O_NOFOLLOW);
        }
        let mut f = opts.open(target).map_err(|e| ioe(e, Some(api)))?;
        let meta = f.metadata().map_err(|e| ioe(e, Some(api)))?;
        if !meta.is_file() {
            return Err(error("INVALID_TARGET", Some(api)));
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).map_err(|e| ioe(e, Some(api)))?;
        Ok((bytes, meta))
    }
    pub fn read(&self, path: &str) -> Result<Note, VaultError> {
        let (target, api) = self.resolve(path)?;
        let (bytes, meta) = self.existing(&target, &api)?;
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| error("INVALID_ENCODING", Some(&api)))?
            .to_owned();
        Ok(Note {
            relative_path: api,
            content,
            version: hash(&bytes),
            size: bytes.len() as u64,
            mtime_ms: mtime(&meta),
        })
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WriteOptions {
    pub expected_version: Option<String>,
    pub expected_mtime_ms: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub relative_path: String,
    pub version: String,
    pub size: u64,
    pub mtime_ms: f64,
}
impl Vault {
    pub fn write(
        &self,
        path: &str,
        content: &str,
        options: WriteOptions,
    ) -> Result<WriteResult, VaultError> {
        use std::io::Write;
        let (target, api) = self.resolve(path)?;
        let parent = target.parent().unwrap();
        let parent_real = fs::canonicalize(parent).map_err(|e| ioe(e, Some(&api)))?;
        if !parent_real.starts_with(&self.root) {
            return Err(error("SECURITY", Some(&api)));
        }
        let existing = match self.existing(&target, &api) {
            Ok(v) => Some(v),
            Err(e) if e.code == "ENOENT" => None,
            Err(e) => return Err(e),
        };
        if let Some((bytes, _)) = &existing {
            if std::str::from_utf8(bytes).is_err() {
                return Err(error("INVALID_ENCODING", Some(&api)));
            }
        }
        let actual_version = existing.as_ref().map(|(bytes, _)| hash(bytes));
        let actual_mtime = existing.as_ref().map(|(_, meta)| mtime(meta));
        let conflict = if let Some(ref expected) = options.expected_version {
            actual_version.as_ref() != Some(expected)
        } else if let Some(expected) = options.expected_mtime_ms {
            actual_mtime != Some(expected)
        } else {
            false
        };
        if conflict {
            let mut e = error("CONFLICT", Some(&api));
            e.reason = Some(
                if existing.is_some() {
                    "modified"
                } else {
                    "deleted"
                }
                .into(),
            );
            e.expected_version = options.expected_version;
            e.expected_mtime_ms = if e.expected_version.is_none() {
                options.expected_mtime_ms
            } else {
                None
            };
            e.actual_version = if e.expected_version.is_some() {
                actual_version
            } else {
                None
            };
            e.actual_mtime_ms = actual_mtime;
            return Err(e);
        }
        let mut builder = tempfile::Builder::new();
        builder.prefix(".pumice-").suffix(".tmp");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(if existing.is_some() {
                0o600
            } else {
                0o666
            }));
        }
        let mut temp = builder
            .tempfile_in(parent)
            .map_err(|e| ioe(e, Some(&api)))?;
        temp.write_all(content.as_bytes())
            .map_err(|e| ioe(e, Some(&api)))?;
        if let Some((_, meta)) = existing {
            temp.as_file()
                .set_permissions(meta.permissions())
                .map_err(|e| ioe(e, Some(&api)))?;
        }
        temp.as_file().sync_all().map_err(|e| ioe(e, Some(&api)))?;
        temp.persist(&target)
            .map_err(|e| ioe(e.error, Some(&api)))?;
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        let meta = fs::metadata(&target).map_err(|e| ioe(e, Some(&api)))?;
        Ok(WriteResult {
            relative_path: api,
            version: hash(content.as_bytes()),
            size: content.len() as u64,
            mtime_ms: mtime(&meta),
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ListOptions {
    pub recursive: bool,
    pub include_hidden: bool,
}
impl Default for ListOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            include_hidden: false,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub relative_path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub utf8: Option<bool>,
}
impl Vault {
    pub fn list(&self, options: ListOptions) -> Result<Vec<ListEntry>, VaultError> {
        let mut entries = Vec::new();
        self.walk(&self.root, "", &options, &mut entries, true)?;
        entries.sort_by(|a, b| {
            a.relative_path
                .encode_utf16()
                .cmp(b.relative_path.encode_utf16())
        });
        Ok(entries)
    }
    fn walk(
        &self,
        dir: &Path,
        base: &str,
        options: &ListOptions,
        out: &mut Vec<ListEntry>,
        root: bool,
    ) -> Result<(), VaultError> {
        let read = match fs::read_dir(dir) {
            Ok(v) => v,
            Err(e) => return if root { Err(ioe(e, None)) } else { Ok(()) },
        };
        for entry in read {
            let entry = entry.map_err(|e| ioe(e, None))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !options.include_hidden && name.starts_with('.') {
                continue;
            }
            let rel = if base.is_empty() {
                name.clone()
            } else {
                format!("{base}/{name}")
            };
            let target = entry.path();
            let meta = match fs::symlink_metadata(&target) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(ioe(e, Some(&rel))),
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if options.recursive {
                    self.walk(&target, &rel, options, out, false)?;
                }
                continue;
            }
            if !meta.is_file()
                || !target
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| self.extensions.contains(&e.to_lowercase()))
                    .unwrap_or(false)
            {
                continue;
            }
            let utf8 = match self.existing(&target, &rel) {
                Ok((bytes, _)) => Some(std::str::from_utf8(&bytes).is_ok()),
                Err(e) if e.code == "SECURITY" || e.code == "ENOENT" => continue,
                Err(_) => None,
            };
            out.push(ListEntry {
                relative_path: rel,
                size: meta.len(),
                mtime_ms: mtime(&meta),
                utf8,
            });
        }
        Ok(())
    }
}
