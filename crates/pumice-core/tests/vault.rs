use pumice_core::{Vault, WriteOptions};

#[test]
fn native_nested_path_is_returned_with_forward_slashes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("a")).unwrap();
    std::fs::write(dir.path().join("a").join("b.md"), "text").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let native = format!("a{}b.md", std::path::MAIN_SEPARATOR);
    let note = vault.read(&native).unwrap();
    assert_eq!(note.relative_path, "a/b.md");
    assert_eq!(
        vault.list(Default::default()).unwrap()[0].relative_path,
        "a/b.md"
    );
    assert_eq!(
        vault
            .write(&native, "new", Default::default())
            .unwrap()
            .relative_path,
        "a/b.md"
    );
}

#[cfg(unix)]
#[test]
fn literal_backslash_path_round_trips_without_overwriting_nested_note() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("a")).unwrap();
    std::fs::write(dir.path().join(r"a\b.md"), "same").unwrap();
    std::fs::write(dir.path().join("a/b.md"), "same").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let list = vault.list(Default::default()).unwrap();
    let paths: Vec<_> = list
        .iter()
        .map(|entry| entry.relative_path.as_str())
        .collect();
    assert!(paths.contains(&r"a\b.md"));
    assert!(paths.contains(&"a/b.md"));
    let note = vault.read(r"a\b.md").unwrap();
    let result = vault
        .write(
            &note.relative_path,
            "changed",
            WriteOptions {
                expected_version: Some(note.version),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join(r"a\b.md")).unwrap(),
        "changed"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a/b.md")).unwrap(),
        "same"
    );
    assert_eq!(result.relative_path, r"a\b.md");
}

#[test]
fn opens_existing_directory_and_rejects_missing_path() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Vault::open(dir.path()).is_ok());
    assert_eq!(
        Vault::open(dir.path().join("missing")).unwrap_err().code,
        "ENOENT"
    );
}

#[test]
fn read_preserves_bytes_and_returns_sha256() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("x.md"), "\u{feff}a\r\nb\r\n").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let note = vault.read("x.md").unwrap();
    assert_eq!(note.content, "\u{feff}a\r\nb\r\n");
    assert_eq!(note.version.len(), 64);
}

#[test]
fn write_preserves_text_and_rejects_external_changes() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let first = vault
        .write("x.md", "one\r\n", WriteOptions::default())
        .unwrap();
    assert_eq!(vault.read("x.md").unwrap().content, "one\r\n");
    std::fs::write(dir.path().join("x.md"), "external").unwrap();
    let e = vault
        .write(
            "x.md",
            "mine",
            WriteOptions {
                expected_version: Some(first.version),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.code, "CONFLICT");
    assert_eq!(e.reason.as_deref(), Some("modified"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("x.md")).unwrap(),
        "external"
    );
}

#[test]
fn list_reports_utf8_and_hides_hidden_and_non_markdown() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("z.MD"), [0xff]).unwrap();
    std::fs::write(dir.path().join("a.md"), "ok").unwrap();
    std::fs::write(dir.path().join(".secret.md"), "hidden").unwrap();
    std::fs::write(dir.path().join("a.txt"), "other").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let list = vault.list(Default::default()).unwrap();
    assert_eq!(
        list.iter()
            .map(|x| x.relative_path.as_str())
            .collect::<Vec<_>>(),
        vec!["a.md", "z.MD"]
    );
    assert_eq!(list[0].utf8, Some(true));
    assert_eq!(list[1].utf8, Some(false));
}

#[test]
fn invalid_utf8_cannot_be_read_or_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad.md");
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(vault.read("bad.md").unwrap_err().code, "INVALID_ENCODING");
    assert_eq!(
        vault
            .write("bad.md", "replacement", Default::default())
            .unwrap_err()
            .code,
        "INVALID_ENCODING"
    );
    assert_eq!(std::fs::read(path).unwrap(), vec![0xff, 0xfe]);
}
#[test]
fn rejects_traversal_and_allows_internal_normalization() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("inside.md"), "inside").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(vault.read("a/../inside.md").unwrap().content, "inside");
    assert_eq!(vault.read("../outside.md").unwrap_err().code, "SECURITY");
    assert_eq!(
        vault
            .write("../outside.md", "oops", Default::default())
            .unwrap_err()
            .code,
        "SECURITY"
    );
    assert_eq!(vault.read("/tmp/a.md").unwrap_err().code, "INVALID_PATH");
}
#[cfg(unix)]
#[test]
fn symlink_escapes_are_refused_and_not_listed() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
    symlink(outside.path(), dir.path().join("escape")).unwrap();
    symlink(
        outside.path().join("secret.md"),
        dir.path().join("alias.md"),
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(vault.read("escape/secret.md").unwrap_err().code, "SECURITY");
    assert_eq!(
        vault
            .write("escape/new.md", "oops", Default::default())
            .unwrap_err()
            .code,
        "SECURITY"
    );
    assert_eq!(vault.read("alias.md").unwrap_err().code, "SECURITY");
    assert!(vault.list(Default::default()).unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("secret.md")).unwrap(),
        "secret"
    );
}
#[test]
fn deleted_conflict_does_not_recreate_note() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let note = vault.write("x.md", "one", Default::default()).unwrap();
    std::fs::remove_file(dir.path().join("x.md")).unwrap();
    let e = vault
        .write(
            "x.md",
            "two",
            WriteOptions {
                expected_version: Some(note.version),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("deleted"));
    assert!(!dir.path().join("x.md").exists());
}

#[test]
fn custom_extensions_are_normalized_and_must_not_be_empty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("x.TXT"), "note").unwrap();
    let vault = Vault::open_with_extensions(dir.path(), vec![" TXT ".into()]).unwrap();
    assert_eq!(vault.read("x.TXT").unwrap().content, "note");
    assert_eq!(
        Vault::open_with_extensions(dir.path(), vec![])
            .unwrap_err()
            .code,
        "INVALID_OPTIONS"
    );
}

#[test]
fn mtime_conflict_and_version_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let first = vault.write("n.md", "one", Default::default()).unwrap();
    let err = vault
        .write(
            "n.md",
            "no",
            WriteOptions {
                expected_mtime_ms: Some(first.mtime_ms + 1.0),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("modified"));
    vault
        .write(
            "n.md",
            "two",
            WriteOptions {
                expected_version: Some(first.version),
                expected_mtime_ms: Some(first.mtime_ms + 1.0),
            },
        )
        .unwrap();
    assert_eq!(vault.read("n.md").unwrap().content, "two");
}
#[cfg(unix)]
#[test]
fn write_preserves_permissions_and_leaves_no_temp_files() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("n.md");
    std::fs::write(&target, "old").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    vault.write("n.md", "new", Default::default()).unwrap();
    assert_eq!(
        std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
