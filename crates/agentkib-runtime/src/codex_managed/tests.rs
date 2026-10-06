use super::*;
use std::os::unix::fs::PermissionsExt;
fn fixture() -> (tempfile::TempDir, Service, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir(root.join("home")).unwrap();
    std::fs::create_dir(root.join("project")).unwrap();
    std::fs::create_dir_all(root.join("project/skill")).unwrap();
    std::fs::write(root.join("project/skill/SKILL.md"), "# Fixture skill").unwrap();
    std::fs::write(root.join("project/context.txt"), "context").unwrap();
    let store = Store::open(&root.join("agentkib.db")).unwrap();
    let workspace = store.add_workspace(&root.join("project")).unwrap();
    let exe = root.join("codex");
    let mock = root.join("codex-mock.py");
    std::fs::write(&mock, include_str!("../../tests/fixtures/codex_mock.py")).unwrap();
    // Keep version probing independent of macOS system Python startup latency;
    // the app-server protocol remains exercised by the real Python subprocess.
    std::fs::write(&exe,format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'codex-cli 0.155.1'; exit 0; fi\nexec /usr/bin/python3 '{}' \"$@\"\n",mock.display())).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let service = Service {
        streams: None,
        ledger: Some(Ledger::open(root.join("ledger/executions.sqlite")).unwrap()),
        runners: BTreeMap::new(),
        test_root: Some(root.into()),
        test_executable: Some(exe),
    };
    (temp, service, workspace.id)
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// Build ownership and native metadata directly; catalog checks must never start
// a native process, including the mock app-server used by control tests.
struct PairedCatalogFixture {
    temp: tempfile::TempDir,
    store: Store,
    record: Record,
    database: rusqlite::Connection,
}
impl PairedCatalogFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("home")).unwrap();
        std::fs::create_dir(temp.path().join("project")).unwrap();
        let store = Store::open(&temp.path().join("agentkib.db")).unwrap();
        let workspace = store.add_workspace(&temp.path().join("project")).unwrap();
        let record = serde_json::from_value(json!({
            "id":"private-managed-owner",
            "workspace_id":workspace.id,
            "workspace":temp.path().join("project").canonicalize().unwrap(),
            "home":temp.path().join("home").canonicalize().unwrap(),
            "native_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "title":"private-ledger-title",
            "created_at":"2026-10-06T00:00:00Z",
            "released":false,
            "adopted":false,
            "source_session_id":"private-owner-source",
            "snapshot":{"status":"idle","private":"private-owner-snapshot"}
        }))
        .unwrap();
        let database = rusqlite::Connection::open(temp.path().join("home/state_1.sqlite")).unwrap();
        database.execute_batch(
            "CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, thread_source TEXT)",
        ).unwrap();
        Self {
            temp,
            store,
            record,
            database,
        }
    }
    fn add_native(&self, native: &str, source: &str) {
        let path = self
            .temp
            .path()
            .join("home")
            .join(format!("{native}.jsonl"));
        std::fs::write(&path, format!("{}\n", json!({
            "type":"session_meta",
            "payload":{"id":native,"cwd":self.record.workspace,"source":source,"thread_source":"user"}
        }))).unwrap();
        self.database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, 'Native title', ?4, 'user')",
                rusqlite::params![
                    native,
                    path.to_string_lossy(),
                    self.record.workspace.to_string_lossy(),
                    source
                ],
            )
            .unwrap();
    }
    fn sync(&self) {
        let provider = agentkib_conversations::CodexProvider::from_home(self.record.home.clone());
        self.store
            .sync_conversation_sessions(
                &self.record.workspace_id,
                agentkib_core::AgentKind::Codex,
                &provider.list_sessions(&self.record.workspace).unwrap(),
            )
            .unwrap();
    }
    fn ledger_path(&self) -> PathBuf {
        self.temp.path().join("codex-managed/executions.sqlite")
    }
    fn save_owner(&self, record: &Record) {
        Ledger::open(self.ledger_path())
            .unwrap()
            .save(record)
            .unwrap();
    }
    fn save_inactive_owners(&self, count: usize) {
        Ledger::open(self.ledger_path()).unwrap();
        let mut connection = rusqlite::Connection::open(self.ledger_path()).unwrap();
        let transaction = connection.transaction().unwrap();
        let mut record = self.record.clone();
        record.native_id = None;
        record.released = true;
        record.adopted = true;
        {
            let mut statement = transaction
                .prepare("INSERT INTO managed_sessions VALUES (?1, ?2)")
                .unwrap();
            for index in 0..count {
                record.id = format!("inactive-owner-{index}");
                statement
                    .execute(rusqlite::params![
                        record.id,
                        serde_json::to_string(&record).unwrap()
                    ])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }
    fn catalog(&self) -> Value {
        crate::RemoteSessionSource {
            data_dir: self.temp.path().to_owned(),
        }
        .catalog_with_codex_home(Some(&self.record.home))
        .unwrap()
    }
    fn local_catalog(&self) -> Vec<Value> {
        Service {
            ledger: Some(Ledger::open(self.ledger_path()).unwrap()),
            test_root: Some(self.temp.path().to_owned()),
            ..Default::default()
        }
        .catalog()
        .unwrap()
    }
}

#[test]
fn paired_catalog_preserves_only_owned_executions_and_keeps_native_ids() {
    use agentkib_conversations::SessionOrigin;
    let fixture = PairedCatalogFixture::new();
    let native = fixture.record.native_id.as_deref().unwrap();
    fixture.add_native(native, "exec");
    fixture.add_native(&id(), "exec");
    fixture.add_native(&id(), "cli");
    fixture.add_native(&id(), "subagent");
    fixture.sync();
    fixture.save_owner(&fixture.record);
    let native_id = fixture
        .store
        .conversation_id(agentkib_core::AgentKind::Codex, native)
        .unwrap();
    let catalog = fixture.catalog();
    let records = catalog["sessions"].as_array().unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(
        records
            .iter()
            .find(|record| record["id"] == native_id)
            .unwrap()["origin"],
        "interactive"
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["origin"] == "execution")
            .count(),
        1
    );
    // The existing frontend's visibility contract retains the native owner alias
    // and ordinary CLI conversation while excluding executions and auxiliaries.
    assert_eq!(
        records
            .iter()
            .filter(|record| record["origin"] != "execution" && record["origin"] != "auxiliary")
            .count(),
        2
    );
    let encoded = catalog.to_string();
    for private in [
        fixture.record.id.as_str(),
        fixture.record.title.as_str(),
        "private-owner-source",
        "private-owner-snapshot",
        "executionMode",
        "indexedSessionIds",
    ] {
        assert!(!encoded.contains(private), "private field: {private}");
    }
    assert_eq!(
        fixture
            .store
            .get_conversation_session(&native_id)
            .unwrap()
            .unwrap()
            .origin,
        SessionOrigin::Execution
    );
    assert_eq!(fixture.catalog(), catalog);
    fixture
        .store
        .exclude_workspace(&fixture.record.workspace_id)
        .unwrap();
    assert_eq!(fixture.catalog()["sessions"], json!([]));
    assert_eq!(fixture.catalog()["workspaces"], json!([]));
    std::fs::write(
        fixture.temp.path().join("preferences.json"),
        r#"{"session_index_enabled":false}"#,
    )
    .unwrap();
    assert_eq!(
        crate::RemoteSessionSource {
            data_dir: fixture.temp.path().to_owned()
        }
        .catalog_with_codex_home(Some(&fixture.record.home))
        .unwrap_err()
        .to_string(),
        "index-disabled"
    );
}

#[test]
fn paired_catalog_deduplicates_verified_native_aliases_and_rejects_ambiguous_owners() {
    let fixture = PairedCatalogFixture::new();
    let native = fixture.record.native_id.as_deref().unwrap();
    fixture.add_native(native, "exec");
    fixture.add_native(&native.to_uppercase(), "exec");
    fixture.sync();
    fixture.save_owner(&fixture.record);
    let indexed_ids: BTreeSet<_> = fixture
        .store
        .list_conversation_sessions(&fixture.record.workspace_id)
        .unwrap()
        .into_iter()
        .map(|record| record.id)
        .collect();
    assert_eq!(indexed_ids.len(), 2);
    let catalog = fixture.catalog();
    assert_eq!(catalog["sessions"].as_array().unwrap().len(), 1);
    assert!(indexed_ids.contains(catalog["sessions"][0]["id"].as_str().unwrap()));
    assert_eq!(catalog["sessions"][0]["origin"], "interactive");

    for another_workspace in [false, true] {
        let mut conflict = fixture.record.clone();
        conflict.id = "other-private-owner".into();
        if another_workspace {
            let path = fixture.temp.path().join("another-project");
            std::fs::create_dir(&path).unwrap();
            let workspace = fixture.store.add_workspace(&path).unwrap();
            conflict.workspace_id = workspace.id;
            conflict.workspace = path.canonicalize().unwrap();
        }
        fixture.save_owner(&conflict);
        let catalog = fixture.catalog();
        assert_eq!(catalog["sessions"].as_array().unwrap().len(), 2);
        assert!(
            catalog["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|record| record["origin"] == "execution")
        );
    }
}

#[test]
fn paired_catalog_deduplicates_interactive_native_aliases_too() {
    let fixture = PairedCatalogFixture::new();
    let native = fixture.record.native_id.as_deref().unwrap();
    fixture.add_native(native, "cli");
    fixture.add_native(&native.to_uppercase(), "cli");
    fixture.sync();
    fixture.save_owner(&fixture.record);
    let catalog = fixture.catalog();
    assert_eq!(catalog["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["sessions"][0]["origin"], "interactive");
}

#[test]
fn paired_catalog_projects_unique_ownership_at_record_limit() {
    for owner_first in [true, false] {
        let fixture = PairedCatalogFixture::new();
        let native = fixture.record.native_id.as_deref().unwrap();
        fixture.add_native(native, "exec");
        fixture.add_native(&native.to_uppercase(), "exec");
        let ordinary_native = id();
        fixture.add_native(&ordinary_native, "cli");
        fixture.sync();
        if owner_first {
            fixture.save_owner(&fixture.record);
        }
        fixture.save_inactive_owners(19_999);
        if !owner_first {
            fixture.save_owner(&fixture.record);
        }
        let ledger = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
        assert_eq!(
            ledger
                .query_row("SELECT COUNT(*) FROM managed_sessions", [], |row| {
                    row.get::<_, usize>(0)
                })
                .unwrap(),
            20_000
        );
        drop(ledger);
        let aliases: BTreeSet<_> = [native, &native.to_uppercase()]
            .into_iter()
            .map(|native| {
                fixture
                    .store
                    .conversation_id(agentkib_core::AgentKind::Codex, native)
                    .unwrap()
            })
            .collect();
        let ordinary_id = fixture
            .store
            .conversation_id(agentkib_core::AgentKind::Codex, &ordinary_native)
            .unwrap();
        let catalog = fixture.catalog();
        let sessions = catalog["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2, "owner_first={owner_first}");
        assert_eq!(
            sessions
                .iter()
                .filter(|session| aliases.contains(session["id"].as_str().unwrap()))
                .count(),
            1,
            "owner_first={owner_first}"
        );
        assert!(sessions.iter().any(|session| session["id"] == ordinary_id));
        assert!(sessions.iter().all(|session| {
            session["origin"] == "interactive" && session["availability"] == "readable"
        }));
    }
}

#[test]
fn paired_catalog_skips_managed_projection_when_ownership_exceeds_record_limit() {
    use agentkib_conversations::SessionOrigin;
    use agentkib_core::AgentKind;
    for total in [20_002, 20_001] {
        for case in [
            "conflict-owner-outside-range",
            "unique-owner-first",
            "unique-owner-last",
            "conflict-owners-in-range",
        ] {
            let fixture = PairedCatalogFixture::new();
            let native = fixture.record.native_id.as_deref().unwrap();
            fixture.add_native(native, "exec");
            fixture.add_native(&native.to_uppercase(), "exec");
            let ordinary_native = id();
            fixture.add_native(&ordinary_native, "cli");
            fixture.sync();
            let provider =
                agentkib_conversations::CodexProvider::from_home(fixture.record.home.clone());
            let mut other_agent = provider
                .list_sessions(&fixture.record.workspace)
                .unwrap()
                .into_iter()
                .find(|session| session.native_ref == ordinary_native)
                .unwrap();
            other_agent.agent = AgentKind::ClaudeCode;
            fixture
                .store
                .sync_conversation_sessions(
                    &fixture.record.workspace_id,
                    other_agent.agent,
                    &[other_agent],
                )
                .unwrap();

            let mut old_created_owner = fixture.record.clone();
            old_created_owner.released = true;
            let mut new_adopted_owner = fixture.record.clone();
            new_adopted_owner.id = "new-adopted-owner".into();
            new_adopted_owner.adopted = true;
            let has_conflict = case.starts_with("conflict-");
            if case == "unique-owner-first" {
                fixture.save_owner(&new_adopted_owner);
            } else if case == "conflict-owner-outside-range" {
                fixture.save_owner(&old_created_owner);
            }
            fixture.save_inactive_owners(total - if has_conflict { 2 } else { 1 });
            if case == "conflict-owners-in-range" {
                fixture.save_owner(&old_created_owner);
            }
            if case != "unique-owner-first" {
                fixture.save_owner(&new_adopted_owner);
            }
            let ledger = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
            assert_eq!(
                ledger
                    .query_row("SELECT COUNT(*) FROM managed_sessions", [], |row| {
                        row.get::<_, usize>(0)
                    })
                    .unwrap(),
                total,
                "{total}: {case}"
            );
            if case == "conflict-owner-outside-range" {
                // At 20,002 rows the released created owner precedes exactly
                // 20,000 inactive records and the live adopted owner. The old
                // bounded read therefore cannot see the conflicting owner.
                assert!(
                    !ledger
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM (SELECT id FROM managed_sessions ORDER BY rowid DESC LIMIT 20000) WHERE id=?1)",
                            [&old_created_owner.id],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap(),
                    "{total}: {case}"
                );
            }
            drop(ledger);

            let indexed = fixture
                .store
                .list_conversation_sessions(&fixture.record.workspace_id)
                .unwrap();
            let indexed_ids: BTreeSet<_> =
                indexed.iter().map(|session| session.id.as_str()).collect();
            let execution_ids: BTreeSet<_> = indexed
                .iter()
                .filter(|session| session.origin == SessionOrigin::Execution)
                .map(|session| session.id.as_str())
                .collect();
            assert_eq!(indexed_ids.len(), 4);
            assert_eq!(execution_ids.len(), 2);
            let catalog = fixture.catalog();
            let sessions = catalog["sessions"].as_array().unwrap();
            for session in sessions {
                let expected = if execution_ids.contains(session["id"].as_str().unwrap()) {
                    "execution"
                } else {
                    "interactive"
                };
                assert_eq!(session["origin"], expected, "{total}: {case}");
                assert_eq!(session["availability"], "readable", "{total}: {case}");
            }
            assert_eq!(
                sessions
                    .iter()
                    .map(|session| session["id"].as_str().unwrap())
                    .collect::<BTreeSet<_>>(),
                indexed_ids,
                "{total}: {case}"
            );
        }
    }
}

#[test]
fn local_catalog_projects_unique_aliases_at_record_limit() {
    for owner_first in [true, false] {
        let fixture = PairedCatalogFixture::new();
        let native = fixture.record.native_id.as_deref().unwrap();
        fixture.add_native(native, "exec");
        fixture.add_native(&native.to_uppercase(), "exec");
        fixture.sync();
        if owner_first {
            fixture.save_owner(&fixture.record);
        }
        fixture.save_inactive_owners(19_999);
        if !owner_first {
            fixture.save_owner(&fixture.record);
        }
        let count = rusqlite::Connection::open(fixture.ledger_path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM managed_sessions", [], |row| {
                row.get::<_, usize>(0)
            })
            .unwrap();
        assert_eq!(count, 20_000, "owner_first={owner_first}");
        let expected_aliases: BTreeSet<_> = [native, &native.to_uppercase()]
            .into_iter()
            .map(|native| {
                fixture
                    .store
                    .conversation_id(agentkib_core::AgentKind::Codex, native)
                    .unwrap()
            })
            .collect();
        let catalog = fixture.local_catalog();
        assert_eq!(catalog.len(), 1, "owner_first={owner_first}");
        assert_eq!(catalog[0]["id"], fixture.record.id);
        assert_eq!(catalog[0]["executionMode"], "codex-managed");
        assert_eq!(
            catalog[0]["indexedSessionIds"],
            json!(expected_aliases),
            "owner_first={owner_first}"
        );
    }
}

#[test]
fn local_catalog_omits_aliases_beyond_record_limit_and_preserves_reads() {
    use agentkib_conversations::SessionOrigin;
    use agentkib_core::AgentKind;
    for total in [20_001, 20_002] {
        for case in [
            "conflicting-owner-old",
            "conflicting-owner-new",
            "unique-owner-old",
            "unique-owner-new",
        ] {
            let fixture = PairedCatalogFixture::new();
            let native = fixture.record.native_id.as_deref().unwrap();
            fixture.add_native(native, "exec");
            fixture.add_native(&native.to_uppercase(), "exec");
            let ordinary_native = id();
            fixture.add_native(&ordinary_native, "cli");
            let ordinary_path = fixture.record.home.join(format!("{ordinary_native}.jsonl"));
            std::fs::write(
                &ordinary_path,
                format!(
                    "{}{}\n",
                    std::fs::read_to_string(&ordinary_path).unwrap(),
                    json!({"type":"event_msg","payload":{"type":"user_message","message":"ordinary transcript stays readable"}})
                ),
            )
            .unwrap();

            // Always keep a separate, newest managed entry in the bounded
            // directory so truncation cannot make the alias check vacuous.
            let mut retained = fixture.record.clone();
            retained.id = "retained-managed-entry".into();
            retained.native_id = Some(id());
            retained.title = "Retained managed title".into();
            fixture.add_native(retained.native_id.as_deref().unwrap(), "exec");
            fixture.sync();

            let mut owner = fixture.record.clone();
            owner.released = true;
            let mut conflict = fixture.record.clone();
            conflict.id = "conflicting-managed-owner".into();
            conflict.native_id = Some(native.to_uppercase());
            conflict.adopted = true;
            match case {
                "conflicting-owner-old" => fixture.save_owner(&conflict),
                "conflicting-owner-new" | "unique-owner-old" => fixture.save_owner(&owner),
                "unique-owner-new" => {}
                _ => unreachable!(),
            }
            fixture.save_inactive_owners(
                total
                    - if case.starts_with("conflicting-") {
                        3
                    } else {
                        2
                    },
            );
            match case {
                "conflicting-owner-old" | "unique-owner-new" => fixture.save_owner(&owner),
                "conflicting-owner-new" => fixture.save_owner(&conflict),
                "unique-owner-old" => {}
                _ => unreachable!(),
            }
            fixture.save_owner(&retained);
            let count = rusqlite::Connection::open(fixture.ledger_path())
                .unwrap()
                .query_row("SELECT COUNT(*) FROM managed_sessions", [], |row| {
                    row.get::<_, usize>(0)
                })
                .unwrap();
            assert_eq!(count, total, "{total}: {case}");

            let catalog = fixture.local_catalog();
            let mut expected_ids = BTreeSet::from([retained.id.as_str()]);
            match case {
                "conflicting-owner-old" | "unique-owner-new" => {
                    expected_ids.insert(&owner.id);
                }
                "conflicting-owner-new" => {
                    expected_ids.insert(&conflict.id);
                }
                "unique-owner-old" => {}
                _ => unreachable!(),
            }
            assert_eq!(
                catalog
                    .iter()
                    .map(|entry| entry["id"].as_str().unwrap())
                    .collect::<BTreeSet<_>>(),
                expected_ids,
                "{total}: {case}"
            );
            assert!(
                catalog.iter().all(|entry| {
                    entry["indexedSessionIds"] == json!([])
                        && entry["executionMode"] == "codex-managed"
                        && entry["availability"] == "readable"
                }),
                "{total}: {case}: {catalog:?}"
            );
            assert_eq!(
                catalog
                    .iter()
                    .find(|entry| entry["id"] == retained.id)
                    .unwrap()["title"],
                retained.title,
                "{total}: {case}"
            );

            let indexed = fixture
                .store
                .list_conversation_sessions(&fixture.record.workspace_id)
                .unwrap();
            let ordinary_id = fixture
                .store
                .conversation_id(AgentKind::Codex, &ordinary_native)
                .unwrap();
            let paired = fixture.catalog();
            let sessions = paired["sessions"].as_array().unwrap();
            assert_eq!(sessions.len(), indexed.len(), "{total}: {case}");
            for session in &indexed {
                let entry = sessions
                    .iter()
                    .find(|entry| entry["id"] == session.id)
                    .unwrap();
                assert_eq!(entry["origin"], json!(session.origin), "{total}: {case}");
                assert_eq!(entry["availability"], "readable", "{total}: {case}");
            }
            assert_eq!(
                fixture
                    .store
                    .get_conversation_session(&ordinary_id)
                    .unwrap()
                    .unwrap()
                    .origin,
                SessionOrigin::Interactive,
                "{total}: {case}"
            );
            let provider =
                agentkib_conversations::CodexProvider::from_home(fixture.record.home.clone());
            let events = provider.read_events(&ordinary_native, None, 10).unwrap();
            assert_eq!(events.events.len(), 1, "{total}: {case}");
            assert_eq!(
                events.events[0].content.as_deref(),
                Some("ordinary transcript stays readable"),
                "{total}: {case}"
            );
        }
    }
}

#[test]
fn local_catalog_rejects_conflicts_from_unavailable_workspaces() {
    for case in [
        "unregistered",
        "workspace-mismatch",
        "missing-workspace-path",
    ] {
        for conflict_first in [true, false] {
            let fixture = PairedCatalogFixture::new();
            let native = fixture.record.native_id.as_deref().unwrap();
            fixture.add_native(native, "exec");
            fixture.sync();
            let mut conflict = fixture.record.clone();
            conflict.id = "unavailable-workspace-owner".into();
            conflict.native_id = Some(native.to_uppercase());
            match case {
                "unregistered" => conflict.workspace_id = "unregistered-workspace".into(),
                "workspace-mismatch" | "missing-workspace-path" => {
                    let path = fixture.temp.path().join("another-project");
                    std::fs::create_dir(&path).unwrap();
                    let workspace = fixture.store.add_workspace(&path).unwrap();
                    conflict.workspace_id = workspace.id;
                    if case == "missing-workspace-path" {
                        conflict.workspace = path.canonicalize().unwrap();
                        std::fs::rename(path, fixture.temp.path().join("removed-project")).unwrap();
                    }
                }
                _ => unreachable!(),
            }
            if conflict_first {
                fixture.save_owner(&conflict);
                fixture.save_owner(&fixture.record);
            } else {
                fixture.save_owner(&fixture.record);
                fixture.save_owner(&conflict);
            }
            let catalog = fixture.local_catalog();
            assert_eq!(catalog.len(), 1, "{case}: conflict_first={conflict_first}");
            assert_eq!(catalog[0]["id"], fixture.record.id);
            assert_eq!(
                catalog[0]["indexedSessionIds"],
                json!([]),
                "{case}: conflict_first={conflict_first}"
            );
        }
    }
}

#[test]
fn local_catalog_ignores_released_adopted_conflicts() {
    for inactive_first in [true, false] {
        let fixture = PairedCatalogFixture::new();
        let native = fixture.record.native_id.as_deref().unwrap();
        fixture.add_native(native, "exec");
        fixture.sync();
        let mut owner = fixture.record.clone();
        owner.released = true;
        let mut inactive = fixture.record.clone();
        inactive.id = "released-adopted-conflict".into();
        inactive.native_id = Some(native.to_uppercase());
        inactive.released = true;
        inactive.adopted = true;
        if inactive_first {
            fixture.save_owner(&inactive);
            fixture.save_owner(&owner);
        } else {
            fixture.save_owner(&owner);
            fixture.save_owner(&inactive);
        }
        let indexed_id = fixture
            .store
            .conversation_id(agentkib_core::AgentKind::Codex, native)
            .unwrap();
        let catalog = fixture.local_catalog();
        assert_eq!(catalog.len(), 1, "inactive_first={inactive_first}");
        assert_eq!(catalog[0]["id"], owner.id);
        assert_eq!(
            catalog[0]["indexedSessionIds"],
            json!([indexed_id]),
            "inactive_first={inactive_first}"
        );
    }
}

#[test]
fn managed_catalogs_skip_non_regular_native_aliases_without_blocking_ordinary_sessions() {
    for case in ["missing", "directory", "symlink", "fifo"] {
        let fixture = PairedCatalogFixture::new();
        let native = fixture.record.native_id.as_deref().unwrap();
        fixture.add_native(native, "exec");
        let ordinary_native = id();
        fixture.add_native(&ordinary_native, "cli");
        let path = fixture.record.home.join(format!("{native}.jsonl"));
        match case {
            "missing" => std::fs::remove_file(&path).unwrap(),
            "directory" => {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            "symlink" => {
                let target = fixture.record.home.join("regular.jsonl");
                std::fs::rename(&path, &target).unwrap();
                std::os::unix::fs::symlink(target, &path).unwrap();
            }
            "fifo" => {
                std::fs::remove_file(&path).unwrap();
                assert!(
                    std::process::Command::new("mkfifo")
                        .arg(&path)
                        .status()
                        .unwrap()
                        .success()
                );
            }
            _ => unreachable!(),
        }
        fixture.sync();
        fixture.save_owner(&fixture.record);
        let native_id = fixture
            .store
            .conversation_id(agentkib_core::AgentKind::Codex, native)
            .unwrap();
        let ordinary_id = fixture
            .store
            .conversation_id(agentkib_core::AgentKind::Codex, &ordinary_native)
            .unwrap();
        // Bound the assertion so a FIFO-open regression fails without hanging
        // the suite; both catalogs run against the same isolated ownership data.
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let paired = fixture.catalog();
            let mut service = Service {
                ledger: Some(Ledger::open(fixture.ledger_path()).unwrap()),
                test_root: Some(fixture.temp.path().to_owned()),
                ..Default::default()
            };
            sender.send((paired, service.catalog().unwrap())).unwrap();
        });
        let (paired, managed) = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("catalog blocked on {case}"));
        worker.join().unwrap();
        let sessions = paired["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2, "{case}");
        let execution = sessions
            .iter()
            .find(|session| session["id"] == native_id)
            .unwrap();
        assert_eq!(execution["origin"], "execution", "{case}");
        assert_eq!(execution["availability"], "metadata-only", "{case}");
        let ordinary = sessions
            .iter()
            .find(|session| session["id"] == ordinary_id)
            .unwrap();
        assert_eq!(ordinary["origin"], "interactive", "{case}");
        assert_eq!(ordinary["availability"], "readable", "{case}");
        assert_eq!(managed.len(), 1, "{case}");
        assert_eq!(managed[0]["indexedSessionIds"], json!([]), "{case}");
    }
}

#[test]
fn missing_managed_home_keeps_ordinary_catalog_and_control_error_order() {
    let fixture = PairedCatalogFixture::new();
    fixture.add_native(fixture.record.native_id.as_deref().unwrap(), "exec");
    fixture.sync();
    fixture.save_owner(&fixture.record);
    let provider = agentkib_conversations::CodexProvider::from_home(fixture.record.home.clone());
    let mut ordinary = provider
        .list_sessions(&fixture.record.workspace)
        .unwrap()
        .remove(0);
    ordinary.agent = agentkib_core::AgentKind::ClaudeCode;
    ordinary.origin = agentkib_conversations::SessionOrigin::Interactive;
    fixture
        .store
        .sync_conversation_sessions(&fixture.record.workspace_id, ordinary.agent, &[ordinary])
        .unwrap();
    let mut service = Service {
        ledger: Some(Ledger::open(fixture.ledger_path()).unwrap()),
        test_root: Some(fixture.temp.path().to_owned()),
        ..Default::default()
    };
    std::fs::rename(
        &fixture.record.home,
        fixture.temp.path().join("removed-home"),
    )
    .unwrap();
    let catalog = fixture.catalog();
    assert_eq!(catalog["sessions"].as_array().unwrap().len(), 2);
    assert!(
        catalog["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["agent"] == "codex" && record["origin"] == "execution")
    );
    assert!(
        catalog["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["agent"] == "claude-code" && record["origin"] == "interactive")
    );
    let managed = service.catalog().unwrap();
    assert_eq!(managed.len(), 1);
    assert_eq!(managed[0]["indexedSessionIds"], json!([]));
    let mut invalid = fixture.record.clone();
    invalid.workspace = fixture.temp.path().join("wrong-project");
    assert_eq!(
        service.validate_access(&invalid).unwrap_err().to_string(),
        "session-workspace-mismatch"
    );
    rusqlite::Connection::open(fixture.ledger_path())
        .unwrap()
        .execute("DELETE FROM managed_sessions", [])
        .unwrap();
    assert!(service.catalog().unwrap().is_empty());
}

#[test]
fn paired_catalog_requires_matching_header_workspace_home_and_live_ownership() {
    for case in [
        "header-id",
        "header-cwd",
        "header-cwd-missing",
        "owner-native",
        "owner-workspace",
        "owner-home",
        "released-adopted",
        "released-created",
        "auxiliary",
    ] {
        let fixture = PairedCatalogFixture::new();
        let native = fixture.record.native_id.as_deref().unwrap();
        fixture.add_native(
            native,
            if case == "auxiliary" {
                "subagent"
            } else {
                "exec"
            },
        );
        fixture.sync();
        let mut owner = fixture.record.clone();
        match case {
            "owner-native" => owner.native_id = Some(id()),
            "owner-workspace" => owner.workspace = fixture.temp.path().join("wrong-project"),
            "owner-home" => owner.home = fixture.temp.path().join("wrong-home"),
            "released-adopted" => {
                owner.released = true;
                owner.adopted = true;
            }
            "released-created" => owner.released = true,
            _ => {}
        }
        fixture.save_owner(&owner);
        if case.starts_with("header-") {
            let path = fixture.record.home.join(format!("{native}.jsonl"));
            let mut header: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            match case {
                "header-id" => header["payload"]["id"] = json!(id()),
                "header-cwd" => {
                    header["payload"]["cwd"] = json!(fixture.temp.path().join("wrong-project"))
                }
                "header-cwd-missing" => {
                    header["payload"].as_object_mut().unwrap().remove("cwd");
                }
                _ => unreachable!(),
            }
            std::fs::write(&path, header.to_string()).unwrap();
        }
        let catalog = fixture.catalog();
        let expected = match case {
            "released-created" => "interactive",
            "auxiliary" => "auxiliary",
            _ => "execution",
        };
        assert_eq!(catalog["sessions"][0]["origin"], expected, "{case}");
    }
}

#[test]
fn paired_catalog_does_not_create_or_migrate_ownership_data() {
    let fixture = PairedCatalogFixture::new();
    fixture.add_native(fixture.record.native_id.as_deref().unwrap(), "exec");
    fixture.sync();
    assert_eq!(fixture.catalog()["sessions"][0]["origin"], "execution");
    assert!(!fixture.ledger_path().parent().unwrap().exists());

    std::fs::create_dir(fixture.ledger_path().parent().unwrap()).unwrap();
    let ledger = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
    ledger
        .execute_batch("CREATE TABLE managed_sessions(id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        .unwrap();
    drop(ledger);
    assert_eq!(fixture.catalog()["sessions"][0]["origin"], "execution");
    let ledger = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
    ledger
        .execute(
            "INSERT INTO managed_sessions VALUES (?1, ?2)",
            rusqlite::params![
                fixture.record.id,
                serde_json::to_string(&fixture.record).unwrap()
            ],
        )
        .unwrap();
    drop(ledger);
    std::fs::set_permissions(
        fixture.ledger_path(),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    std::fs::set_permissions(
        fixture.ledger_path().parent().unwrap(),
        std::fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    let before = std::fs::read(fixture.ledger_path()).unwrap();
    let files = || -> BTreeSet<_> {
        std::fs::read_dir(fixture.ledger_path().parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect()
    };
    let files_before = files();
    assert_eq!(fixture.catalog()["sessions"][0]["origin"], "interactive");
    assert_eq!(std::fs::read(fixture.ledger_path()).unwrap(), before);
    assert_eq!(files(), files_before);
    assert_eq!(
        std::fs::metadata(fixture.ledger_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert_eq!(
        std::fs::metadata(fixture.ledger_path().parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750
    );
    let ledger = rusqlite::Connection::open_with_flags(
        fixture.ledger_path(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        ledger
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

fn paired_catalog_ledger_failure_fixture() -> (PairedCatalogFixture, String, Ledger) {
    let fixture = PairedCatalogFixture::new();
    fixture.add_native(fixture.record.native_id.as_deref().unwrap(), "exec");
    let ordinary_native = id();
    fixture.add_native(&ordinary_native, "cli");
    let ordinary_path = fixture.record.home.join(format!("{ordinary_native}.jsonl"));
    std::fs::write(
        &ordinary_path,
        format!(
            "{}{}\n",
            std::fs::read_to_string(&ordinary_path).unwrap(),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"ordinary transcript stays readable"}})
        ),
    )
    .unwrap();
    fixture.sync();
    let ledger = Ledger::open(fixture.ledger_path()).unwrap();
    ledger.save(&fixture.record).unwrap();
    // Use a rollback journal so SQLite's read-only WAL sidecar creation does
    // not obscure the assertion that catalog failures never repair this file.
    rusqlite::Connection::open(fixture.ledger_path())
        .unwrap()
        .execute_batch("PRAGMA journal_mode=DELETE")
        .unwrap();
    (fixture, ordinary_native, ledger)
}

fn assert_paired_catalog_survives_ledger_failure(
    fixture: &PairedCatalogFixture,
    ordinary_native: &str,
    ledger: &Ledger,
    unreadable_owner: &str,
) {
    use agentkib_conversations::SessionOrigin;
    use agentkib_core::AgentKind;
    // This fallback belongs only to the paired directory. Durable reads used
    // by managed controls must still report their underlying failure.
    assert!(Ledger::existing_records(&fixture.ledger_path()).is_err());
    assert!(ledger.get(unreadable_owner).is_err());

    std::fs::set_permissions(
        fixture.ledger_path(),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    std::fs::set_permissions(
        fixture.ledger_path().parent().unwrap(),
        std::fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    let before = std::fs::read(fixture.ledger_path()).unwrap();
    let files = || -> BTreeSet<_> {
        std::fs::read_dir(fixture.ledger_path().parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect()
    };
    let files_before = files();
    let indexed = fixture
        .store
        .list_conversation_sessions(&fixture.record.workspace_id)
        .unwrap();
    assert_eq!(indexed.len(), 2);
    let managed_native_id = fixture
        .store
        .conversation_id(
            AgentKind::Codex,
            fixture.record.native_id.as_deref().unwrap(),
        )
        .unwrap();
    let ordinary_id = fixture
        .store
        .conversation_id(AgentKind::Codex, ordinary_native)
        .unwrap();
    assert_eq!(
        indexed
            .iter()
            .find(|session| session.id == managed_native_id)
            .unwrap()
            .origin,
        SessionOrigin::Execution
    );
    assert_eq!(
        indexed
            .iter()
            .find(|session| session.id == ordinary_id)
            .unwrap()
            .origin,
        SessionOrigin::Interactive
    );

    let catalog = fixture.catalog();
    assert_eq!(catalog["sessions"], json!(indexed));
    assert_eq!(catalog["workspaces"].as_array().unwrap().len(), 1);
    let encoded = catalog.to_string();
    for private in [
        fixture.record.id.as_str(),
        fixture.record.title.as_str(),
        "private-owner-source",
        "private-owner-snapshot",
        "private-invalid-owner",
        "private-invalid-sqlite-payload",
        "executionMode",
        "indexedSessionIds",
    ] {
        assert!(!encoded.contains(private), "private field: {private}");
    }
    assert_eq!(
        json!(
            fixture
                .store
                .list_conversation_sessions(&fixture.record.workspace_id)
                .unwrap()
        ),
        json!(indexed)
    );
    let provider = agentkib_conversations::CodexProvider::from_home(fixture.record.home.clone());
    let events = provider.read_events(ordinary_native, None, 10).unwrap();
    assert_eq!(events.events.len(), 1);
    assert_eq!(
        events.events[0].content.as_deref(),
        Some("ordinary transcript stays readable")
    );
    assert_eq!(std::fs::read(fixture.ledger_path()).unwrap(), before);
    assert_eq!(files(), files_before);
    assert_eq!(
        std::fs::metadata(fixture.ledger_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert_eq!(
        std::fs::metadata(fixture.ledger_path().parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750
    );
}

#[test]
fn paired_catalog_survives_ledger_missing_managed_sessions_table() {
    let (fixture, ordinary_native, ledger) = paired_catalog_ledger_failure_fixture();
    rusqlite::Connection::open(fixture.ledger_path())
        .unwrap()
        .execute_batch("DROP TABLE managed_sessions")
        .unwrap();
    assert_paired_catalog_survives_ledger_failure(
        &fixture,
        &ordinary_native,
        &ledger,
        &fixture.record.id,
    );
}

#[test]
fn paired_catalog_survives_ledger_corrupt_sqlite() {
    let (fixture, ordinary_native, ledger) = paired_catalog_ledger_failure_fixture();
    std::fs::write(fixture.ledger_path(), "private-invalid-sqlite-payload").unwrap();
    assert_paired_catalog_survives_ledger_failure(
        &fixture,
        &ordinary_native,
        &ledger,
        &fixture.record.id,
    );
}

#[test]
fn paired_catalog_survives_ledger_corrupt_record_after_valid_owner() {
    let (fixture, ordinary_native, ledger) = paired_catalog_ledger_failure_fixture();
    let connection = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
    connection
        .execute_batch("DELETE FROM managed_sessions")
        .unwrap();
    connection
        .execute(
            "INSERT INTO managed_sessions VALUES (?1, ?2)",
            rusqlite::params![
                "private-invalid-owner",
                r#"{"private":"private-invalid-owner-payload""#
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO managed_sessions VALUES (?1, ?2)",
            rusqlite::params![
                fixture.record.id,
                serde_json::to_string(&fixture.record).unwrap()
            ],
        )
        .unwrap();
    assert_eq!(
        connection
            .prepare("SELECT id FROM managed_sessions ORDER BY rowid DESC")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        vec![fixture.record.id.clone(), "private-invalid-owner".into()]
    );
    drop(connection);
    assert!(ledger.get(&fixture.record.id).unwrap().is_some());
    assert!(ledger.list().is_err());
    assert_paired_catalog_survives_ledger_failure(
        &fixture,
        &ordinary_native,
        &ledger,
        "private-invalid-owner",
    );
}

#[test]
fn paired_catalog_survives_ledger_exclusive_lock() {
    let (fixture, ordinary_native, ledger) = paired_catalog_ledger_failure_fixture();
    let locked = rusqlite::Connection::open(fixture.ledger_path()).unwrap();
    // WAL permits concurrent readers; a DELETE-journal exclusive transaction
    // deterministically exercises the catalog's bounded database-lock failure.
    locked
        .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE")
        .unwrap();
    assert!(ledger.receipt("private-request", "device-a").is_err());
    assert_paired_catalog_survives_ledger_failure(
        &fixture,
        &ordinary_native,
        &ledger,
        &fixture.record.id,
    );
    locked.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn platform_override_requires_a_complete_isolated_fixture() {
    let (_temp, mut service, _) = fixture();
    assert!(service.platform_supported());
    let executable = service.test_executable.take().unwrap();
    assert!(!service.platform_supported());
    assert_eq!(
        service
            .request(json!({"operation":"options"}), "boot", true)
            .unwrap()["reason"],
        "platform-unsupported"
    );
    assert_eq!(
        service
            .request(json!({"operation":"create"}), "boot", true)
            .unwrap_err()
            .to_string(),
        "platform-unsupported"
    );
    service.test_executable = Some(executable);
    let root = service.test_root.take().unwrap();
    assert!(!service.platform_supported());
    service.test_root = Some(root);
    service.test_executable = Some(PathBuf::from("/usr/bin/python3"));
    assert!(!service.platform_supported());
    service.test_executable = Some(service.test_root.as_ref().unwrap().join("codex"));
    service.ledger = None;
    assert!(!service.platform_supported());
}

#[test]
fn options_uses_the_same_isolated_executable_and_home_as_requests() {
    let (_temp, mut service, _) = fixture();
    let options = service
        .request(json!({"operation":"options"}), "boot", true)
        .unwrap();
    assert_eq!(options["available"], true);
    assert_eq!(options["models"][0]["id"], "mock-model");
    assert!(
        service
            .request(json!({"operation":"options"}), "boot", false)
            .is_err()
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn production_service_on_unsupported_platform_never_opens_user_environment() {
    let mut service = Service::default();
    assert!(!service.platform_supported());
    assert_eq!(
        service
            .request(json!({"operation":"options"}), "boot", true)
            .unwrap()["reason"],
        "platform-unsupported"
    );
    assert_eq!(
        service
            .request(json!({"operation":"create"}), "boot", true)
            .unwrap_err()
            .to_string(),
        "platform-unsupported"
    );
    assert!(service.ledger.is_none());
    assert!(service.runners.is_empty());
}

fn create(service: &mut Service, workspace: &str) -> Value {
    let result=service.request(json!({"operation":"create","workspaceId":workspace,"requestId":id(),"model":"mock-model","effort":"medium"}),"boot",true).unwrap();
    assert_eq!(result["accepted"], true, "fixture create: {result}");
    result
}

#[test]
fn catalog_exposes_only_verified_native_index_aliases() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let record = service.ledger().unwrap().get(session).unwrap().unwrap();
    let native = record.native_id.as_ref().unwrap();
    let unrelated = id();
    let transcript = temp.path().join("home/session.jsonl");
    let unrelated_transcript = temp.path().join("home/unrelated.jsonl");
    let header = |native: &str| {
        json!({
            "type": "session_meta", "payload": {"id": native, "cwd": record.workspace, "source":"exec", "thread_source":"user"}
        })
        .to_string()
    };
    std::fs::write(&transcript, header(native)).unwrap();
    std::fs::write(&unrelated_transcript, header(&unrelated)).unwrap();
    let database = rusqlite::Connection::open(temp.path().join("home/state_1.sqlite")).unwrap();
    database
        .execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, thread_source TEXT)")
        .unwrap();
    for (native, path) in [(native, &transcript), (&unrelated, &unrelated_transcript)] {
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 'exec', 'user')",
                rusqlite::params![
                    native,
                    path.to_string_lossy(),
                    record.workspace.to_string_lossy(),
                    record.title
                ],
            )
            .unwrap();
    }
    let indexed = service
        .store()
        .unwrap()
        .conversation_id(agentkib_core::AgentKind::Codex, native)
        .unwrap();
    let catalog = service.catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0]["id"], session);
    assert_eq!(catalog[0]["origin"], "interactive");
    assert_eq!(catalog[0]["indexedSessionIds"], json!([indexed]));
    let provider = agentkib_conversations::CodexProvider::from_home(temp.path().join("home"));
    let indexed_records = provider.list_sessions(&record.workspace).unwrap();
    assert!(
        indexed_records
            .iter()
            .all(|record| { record.origin == agentkib_conversations::SessionOrigin::Execution })
    );

    // A recovered managed entry keeps its directory identity even when the
    // underlying native transcript is classified as an execution record.
    let session = session.to_owned();
    drop(service);
    let mut service = Service {
        ledger: Some(Ledger::open(temp.path().join("ledger/executions.sqlite")).unwrap()),
        test_root: Some(temp.path().into()),
        test_executable: Some(temp.path().join("codex")),
        ..Default::default()
    };
    let recovered = service.catalog().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0]["id"], session);
    assert_eq!(recovered[0]["origin"], "interactive");
    assert_eq!(recovered[0]["indexedSessionIds"], json!([indexed]));

    // A database row or matching title cannot alias a different native thread.
    std::fs::write(&transcript, header(&unrelated)).unwrap();
    assert_eq!(
        service.catalog().unwrap()[0]["indexedSessionIds"],
        json!([])
    );
}

#[test]
fn native_context_reads_one_thread_without_turn_history_or_writer_handoff() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let context = service.context(session).unwrap();
    assert_eq!(context["available"], true);
    assert_eq!(context["projectId"], "mock-project");
    assert_eq!(context["branchAtCreation"], "mock-branch");
    let calls = std::fs::read_to_string(temp.path().join("home/read-calls.jsonl")).unwrap();
    let read: Value = serde_json::from_str(calls.lines().next().unwrap()).unwrap();
    assert_eq!(read["includeTurns"], false);
    assert_eq!(
        context["cwd"],
        service
            .store()
            .unwrap()
            .workspace_path(&workspace)
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(live(&mut service, session)["sendEnabled"], true);
}

#[test]
fn native_context_rejects_directory_outside_authorized_workspace() {
    let (temp, _service, _workspace) = fixture();
    let allowed = temp.path().join("project").canonicalize().unwrap();
    let outside = temp.path().join("home").canonicalize().unwrap();
    assert!(native_context(&json!({"cwd":outside}), &allowed).is_err());
    assert_eq!(
        native_context(&json!({"cwd":allowed}), &allowed).unwrap()["available"],
        true
    );
}
fn live(service: &mut Service, session: &str) -> Value {
    service
        .request(
            json!({"operation":"live","sessionId":session,"experimentalEnabled":true}),
            "boot",
            false,
        )
        .unwrap()
}
fn wait(service: &mut Service, session: &str, status: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        let result = live(service, session);
        if result["status"] == status {
            return result;
        }
        assert!(Instant::now() < until, "wanted {status}, got {result}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn send(service: &mut Service, session: &str, text: &str, request: &str) -> Result<Value> {
    let current = live(service, session);
    service.request(json!({"operation":"send","sessionId":session,"requestId":request,"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"text":text}),"boot",false)
}
#[test]
fn creates_sends_and_recovers_after_restart_without_replaying() {
    let (temp, mut service, workspace) = fixture();
    let request = id();
    let input = json!({"operation":"create","workspaceId":workspace,"requestId":request});
    let created = service.request(input.clone(), "boot", true).unwrap();
    let session = created["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(session.len(), 64);
    assert_eq!(created["live"]["executionMode"], "codex-managed");
    assert_eq!(created["live"]["workspaceId"], workspace);
    assert_eq!(service.request(input, "boot", true).unwrap(), created);
    let req = id();
    assert_eq!(
        send(&mut service, &session, "hello", &req).unwrap()["accepted"],
        true
    );
    let snapshot = wait(&mut service, &session, "idle");
    assert_eq!(snapshot["sendEnabled"], true);
    let page = service
        .request(
            json!({"operation":"events","sessionId":session}),
            "boot",
            false,
        )
        .unwrap();
    assert!(
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["content"] == "reply")
    );
    drop(service);
    let root = temp.path();
    let mut service = Service {
        streams: None,
        ledger: Some(Ledger::open(root.join("ledger/executions.sqlite")).unwrap()),
        runners: BTreeMap::new(),
        test_root: Some(root.into()),
        test_executable: Some(root.join("codex")),
    };
    assert_eq!(live(&mut service, &session)["reason"], "recovery-required");
    let reconciled = service
        .request(
            json!({"operation":"reconcile","sessionId":session,"requestId":id()}),
            "boot-2",
            true,
        )
        .unwrap();
    assert_eq!(reconciled["reconciled"], true);
    assert_eq!(reconciled["live"]["status"], "idle");
    let released = service
        .request(
            json!({"operation":"release","sessionId":session,"requestId":id()}),
            "boot-2",
            true,
        )
        .unwrap();
    assert_eq!(released["released"], true);
    assert_eq!(live(&mut service, &session)["sendEnabled"], false);
}

#[test]
fn native_callbacks_deliver_text_and_completion_without_live_polling() {
    let (_temp, mut service, workspace) = fixture();
    let (tx, rx) = std::sync::mpsc::channel();
    let hub = crate::session_stream::Hub::new("boot".into(), move |event| tx.send(event).is_ok());
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let baseline = hub.subscribe(session, None).unwrap();
    send(&mut service, session, "hello", &id()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut delta_id = None;
    let mut completed_id = None;
    let mut idle = false;
    while Instant::now() < deadline && !(delta_id.is_some() && completed_id.is_some() && idle) {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        assert_eq!(event["subscriptionId"], baseline["subscriptionId"]);
        match event["type"].as_str() {
            Some("text-delta") => {
                assert_eq!(event["payload"]["text"], "reply");
                delta_id = event["payload"]["itemId"].as_str().map(str::to_owned);
            }
            Some("item-upsert") if event["payload"]["kind"] == "agent-message" => {
                completed_id = event["payload"]["id"].as_str().map(str::to_owned)
            }
            Some("state") if event["payload"]["status"] == "idle" => idle = true,
            _ => {}
        }
    }
    assert_eq!(delta_id, completed_id);
    assert!(idle);
}

#[test]
fn running_tools_are_pushed_and_retained_without_writing_completed_history() {
    let (_temp, mut service, workspace) = fixture();
    let (tx, rx) = std::sync::mpsc::channel();
    let hub = crate::session_stream::Hub::new("boot".into(), move |event| tx.send(event).is_ok());
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let subscription = hub.subscribe(session, None).unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    for (kind, final_status) in [
        ("commandExecution", "completed"),
        ("mcpToolCall", "failed"),
        ("fileChange", "completed"),
        ("webSearch", "completed"),
    ] {
        let turn = format!("turn-{kind}");
        let item_id = format!("tool-{kind}");
        state
            .event(
                json!({"method":"turn/started","params":{"turn":{"id":turn}}}),
                &ledger,
            )
            .unwrap();
        let mut item = json!({"id":item_id,"type":kind,"status":"inProgress"});
        state
            .event(
                json!({"method":"item/started","params":{"turnId":"stale-turn","item":item}}),
                &ledger,
            )
            .unwrap();
        assert!(!state.items.contains_key(&item_id));
        state
            .event(
                json!({"method":"item/started","params":{"turnId":turn,"item":item}}),
                &ledger,
            )
            .unwrap();

        // No completion is sent until the existing observer receives the
        // running tool, as with a command or MCP call waiting on external work.
        let deadline = Instant::now() + Duration::from_secs(2);
        let running = loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            assert_eq!(event["subscriptionId"], subscription["subscriptionId"]);
            if event["type"] == "item-upsert" && event["payload"]["id"] == item_id {
                break event["payload"].clone();
            }
        };
        assert_eq!(running["turn_id"], turn);
        assert_eq!(running["kind"], "tool-summary");
        assert_eq!(running["tool_name"], kind);
        assert_eq!(running["tool_status"], "inProgress");
        assert!(
            ledger.events(session, None, 100).unwrap()["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| event["id"] != item_id)
        );
        let baseline = hub.subscribe(session, None).unwrap();
        hub.unsubscribe(baseline["subscriptionId"].as_str().unwrap());
        assert_eq!(
            baseline["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|event| event["id"] == item_id),
            Some(&running)
        );

        item["status"] = json!(final_status);
        state
            .event(
                json!({"method":"item/completed","params":{"turnId":turn,"item":item}}),
                &ledger,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if event["type"] == "item-upsert" && event["payload"]["id"] == item_id {
                assert_eq!(event["payload"]["tool_status"], final_status);
                break;
            }
        }
        let completed = hub.subscribe(session, None).unwrap();
        hub.unsubscribe(completed["subscriptionId"].as_str().unwrap());
        let matching = completed["events"][0]["payload"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["id"] == item_id)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0]["tool_status"], final_status);
        let history = ledger.events(session, None, 100).unwrap();
        let stored = history["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["id"] == item_id)
            .collect::<Vec<_>>();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["tool_status"], final_status);
    }
}

#[test]
fn completed_items_preserve_stream_preview_and_existing_persisted_summary_budget() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    let limit = crate::session_stream::MAX_ITEM_TEXT_BYTES;
    for (kind, method) in [
        ("agentMessage", "item/agentMessage/delta"),
        ("plan", "item/plan/delta"),
    ] {
        for (index, (content, expected_bytes, truncated)) in [
            ("x".repeat(40_000), 40_000, false),
            ("界".repeat(40_000), 120_000, false),
            ("x".repeat(limit + 1), limit, true),
            (format!("{}界", "x".repeat(limit - 2)), limit - 2, true),
        ]
        .into_iter()
        .enumerate()
        {
            let turn = format!("turn-{kind}-{index}");
            let item_id = format!("answer-{kind}-{index}");
            state
                .event(
                    json!({"method":"turn/started","params":{"turn":{"id":turn}}}),
                    &ledger,
                )
                .unwrap();
            state
                .event(json!({"method":method,"params":{"turnId":turn,"itemId":item_id,"delta":content}}), &ledger)
                .unwrap();
            let streamed = hub.subscribe(session, None).unwrap();
            hub.unsubscribe(streamed["subscriptionId"].as_str().unwrap());
            let streamed_item = streamed["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == item_id)
                .unwrap();
            assert_eq!(streamed_item["content"], &content[..expected_bytes]);
            assert_eq!(streamed_item["truncated"], truncated);
            state
                .event(json!({"method":"item/completed","params":{"turnId":turn,"item":{"id":item_id,"type":kind,"text":content}}}), &ledger)
                .unwrap();
            state
                .event(
                    json!({"method":"turn/completed","params":{"turn":{"id":turn}}}),
                    &ledger,
                )
                .unwrap();
            let completed = hub.subscribe(session, streamed["cursor"].as_str()).unwrap();
            hub.unsubscribe(completed["subscriptionId"].as_str().unwrap());
            let item = &completed["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|event| event["type"] == "item-upsert" && event["payload"]["id"] == item_id)
                .unwrap()["payload"];
            assert_eq!(item["content"], streamed_item["content"]);
            assert_eq!(item["truncated"], truncated);
            let restored = hub.subscribe(session, None).unwrap();
            hub.unsubscribe(restored["subscriptionId"].as_str().unwrap());
            let restored_item = restored["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == item_id)
                .unwrap();
            assert_eq!(restored_item, item);
            let history = ledger.events(session, None, 100).unwrap();
            let stored = history["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == item_id)
                .unwrap();
            assert_eq!(
                stored["content"],
                content.chars().take(32768).collect::<String>()
            );
            assert_eq!(stored["truncated"], content.len() > 128 * 1024);
        }
    }
}

#[test]
fn control_republication_uses_final_state_and_rechecks_the_ledger_without_new_events() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let request = id();
    ledger
        .claim(
            &request,
            session,
            "fixture",
            None,
            &json!({"operation":"send"}),
        )
        .unwrap();
    ledger.dispatch(&request).unwrap();
    let detached = {
        let mut state = service.runners[session].state.lock().unwrap();
        state.revision = 50;
        state
            .event(
                json!({"method":"turn/started","params":{"turn":{"id":"turn"}}}),
                &ledger,
            )
            .unwrap();
        state.snapshot("boot", true)
    };
    assert_eq!(detached["status"], "running");
    {
        let mut state = service.runners[session].state.lock().unwrap();
        state
            .event(
                json!({"method":"turn/completed","params":{"turn":{"id":"turn"}}}),
                &ledger,
            )
            .unwrap();
    }
    assert!(service.republish_live(session).unwrap());
    let guarded = hub.subscribe(session, None).unwrap();
    let live = &guarded["events"][0]["payload"]["live"];
    assert_eq!(live["status"], "idle");
    assert_eq!(live["sendEnabled"], false);
    let revision = live["revision"].clone();
    assert!(revision.as_u64() > detached["revision"].as_u64());

    // The last native completion preceded its receipt. Clearing the durable
    // fence must publish controls even though no new native event/revision exists.
    ledger.finish(&request, &json!({"accepted":true})).unwrap();
    assert!(service.republish_live(session).unwrap());
    let enabled = hub.subscribe(session, None).unwrap();
    let live = &enabled["events"][0]["payload"]["live"];
    assert_eq!(live["revision"], revision);
    assert_eq!(live["status"], "idle");
    assert_eq!(live["sendEnabled"], true);
    assert_ne!(enabled["cursor"], guarded["cursor"]);
    assert!(service.republish_live(session).unwrap());
    assert_eq!(
        hub.subscribe(session, None).unwrap()["cursor"],
        enabled["cursor"]
    );

    service
        .request(
            json!({"operation":"release","sessionId":session,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    assert!(!service.republish_live(session).unwrap());
    let resumed = service.request(json!({"operation":"resume","sessionId":session,"requestId":id(),"runtimeBootId":"boot","experimentalEnabled":true,"handoffConfirmed":true}), "boot", false).unwrap();
    assert_eq!(resumed["accepted"], true);
    assert!(service.republish_live(session).unwrap());
    let replacement = hub.subscribe(session, None).unwrap();
    let live = &replacement["events"][0]["payload"]["live"];
    assert!(live["revision"].as_u64() < revision.as_u64());
    assert_eq!(live["status"], "idle");
    assert_eq!(live["sendEnabled"], true);
}

#[test]
fn native_metadata_pushes_invalidate_only_changed_control_domains() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let runner = service.runners.get(session).unwrap();
    let native = runner
        .state
        .lock()
        .unwrap()
        .record
        .native_id
        .clone()
        .unwrap();
    let mut baseline = hub.subscribe(session, None).unwrap();
    hub.unsubscribe(baseline["subscriptionId"].as_str().unwrap());
    for (method, field, value, domain) in [
        (
            "thread/settings/updated",
            "threadSettings",
            json!({"model":"new-model","effort":"high"}),
            "settings",
        ),
        (
            "thread/tokenUsage/updated",
            "tokenUsage",
            json!({"total":{"totalTokens":73}}),
            "usage",
        ),
        (
            "thread/goal/updated",
            "goal",
            json!({"objective":"continue","status":"active","tokenBudget":1000}),
            "goal",
        ),
        ("thread/goal/cleared", "goal", Value::Null, "goal"),
    ] {
        let mut params = json!({"threadId":native});
        params[field] = value;
        let event = json!({"method":method,"params":params});
        for changed in [true, false] {
            runner
                .state
                .lock()
                .unwrap()
                .event(event.clone(), &ledger)
                .unwrap();
            let replay = hub.subscribe(session, baseline["cursor"].as_str()).unwrap();
            hub.unsubscribe(replay["subscriptionId"].as_str().unwrap());
            let invalidations: Vec<_> = replay["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["type"] == "invalidate")
                .map(|event| event["payload"]["domains"].clone())
                .collect();
            assert_eq!(
                invalidations,
                if changed {
                    vec![json!([domain])]
                } else {
                    vec![]
                },
                "{method}"
            );
            baseline = replay;
        }
    }
    // Read-side goal counter reconciliation must not create a request loop.
    {
        let mut state = runner.state.lock().unwrap();
        state.record.goal = Some(json!({"objective":"continue","tokensUsed":42}));
        state.save(&ledger).unwrap();
    }
    let replay = hub.subscribe(session, baseline["cursor"].as_str()).unwrap();
    assert!(
        replay["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["type"] != "invalidate")
    );
}

#[test]
fn settings_usage_goals_and_resources_require_native_confirmation() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();

    let initial = service
        .request(
            json!({"operation":"settings-state","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(initial["available"], true);
    assert_eq!(initial["settings"]["current"]["model"], "mock-model");
    assert_eq!(initial["settings"]["defaults"]["model"], "mock-model");
    assert_eq!(initial["settings"]["writable"]["serviceTier"], true);
    assert_eq!(initial["settings"]["writable"]["mode"]["available"], true);
    assert_eq!(initial["collaborationModes"][0]["id"], "plan");

    let current = live(&mut service, session);
    let changed = service
        .request(
            json!({"operation":"settings","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"model":"mock-model","effort":"medium","serviceTier":"fast","policyId":"full-access-on-request"}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(changed["completed"], true);
    let settings = service
        .request(
            json!({"operation":"settings-state","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert!(settings["settings"]["current"]["serviceTier"].is_null());
    assert_eq!(settings["settings"]["selected"]["serviceTier"], "fast");
    assert_eq!(settings["settings"]["applicationStatus"], "pending");
    assert!(settings["settings"]["current"]["mode"].is_null());
    assert_eq!(
        settings["settings"]["selected"]["policyId"],
        "full-access-on-request"
    );

    let resources = service
        .request(
            json!({"operation":"resources","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(resources["available"], true);
    assert_eq!(resources["skills"].as_array().unwrap().len(), 1);
    assert_eq!(resources["plugins"], json!([]));
    assert_eq!(
        resources["contextReferences"]["supportedTypes"],
        json!(["computerPath", "skill"])
    );

    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
    let calls = std::fs::read_to_string(temp.path().join("home/turn-calls.jsonl")).unwrap();
    let call: Value = serde_json::from_str(calls.lines().last().unwrap()).unwrap();
    assert_eq!(call["model"], "mock-model");
    assert_eq!(call["effort"], "medium");
    assert_eq!(call["serviceTier"], "fast");
    assert_eq!(call["approvalPolicy"], "never");
    assert_eq!(call["approvalsReviewer"], "user");
    assert_eq!(call["sandboxPolicy"]["type"], "dangerFullAccess");
    let usage = service
        .request(
            json!({"operation":"usage","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(usage["available"], true);
    assert_eq!(usage["tokenUsage"]["modelContextWindow"], 258000);

    let revision = live(&mut service, session)["revision"].clone();
    let set = service
        .request(
            json!({"operation":"goal-set","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":revision,"experimentalEnabled":true,"goal":{"objective":"verify native goal","tokenBudget":2000}}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(set["completed"], true);
    let goal = service
        .request(
            json!({"operation":"goal","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(goal["goal"]["objective"], "verify native goal");
    assert_eq!(goal["goal"]["status"], "active");

    for (operation, expected) in [("goal-pause", "paused"), ("goal-resume", "active")] {
        let revision = live(&mut service, session)["revision"].clone();
        let result = service
            .request(
                json!({"operation":operation,"sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":revision,"experimentalEnabled":true}),
                "boot",
                false,
            )
            .unwrap();
        assert_eq!(result["completed"], true);
        let goal = service
            .request(
                json!({"operation":"goal","sessionId":session}),
                "boot",
                true,
            )
            .unwrap();
        assert_eq!(goal["goal"]["status"], expected);
    }
    let revision = live(&mut service, session)["revision"].clone();
    let cleared = service
        .request(
            json!({"operation":"goal-clear","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":revision,"experimentalEnabled":true}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(cleared["completed"], true);
    assert!(
        service
            .request(
                json!({"operation":"goal","sessionId":session}),
                "boot",
                true
            )
            .unwrap()["goal"]
            .is_null()
    );
}

#[test]
fn controlled_resource_references_are_revalidated_and_bounded() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let resources = service
        .request(
            json!({"operation":"resources","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    let skill = resources["skills"][0]["id"].as_str().unwrap();
    let current = live(&mut service, session);
    let result = service
        .request(
            json!({"operation":"send","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"text":"with context","resourceRefs":[{"kind":"file","relativePath":"context.txt"},{"kind":"directory","relativePath":"skill"},{"kind":"skill","id":skill}]}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(result["accepted"], true);
    wait(&mut service, session, "idle");

    let record = service.ledger().unwrap().get(session).unwrap().unwrap();
    let history: Value = serde_json::from_str(
        &std::fs::read_to_string(
            temp.path()
                .join("home")
                .join(format!("{}.json", record.native_id.unwrap())),
        )
        .unwrap(),
    )
    .unwrap();
    let content = history[0]["items"][0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 4);
    assert_eq!(content[1]["type"], "mention");
    assert_eq!(content[2]["type"], "mention");
    assert_eq!(content[3]["type"], "skill");

    let refs = (0..32)
        .map(|_| json!({"kind":"file","relativePath":"context.txt"}))
        .collect::<Vec<_>>();
    let current = live(&mut service, session);
    let accepted = service
        .request(
            json!({"operation":"send","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"text":"bounded refs","resourceRefs":refs}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(accepted["accepted"], true);
    wait(&mut service, session, "idle");

    let refs = (0..33)
        .map(|_| json!({"kind":"file","relativePath":"context.txt"}))
        .collect::<Vec<_>>();
    let current = live(&mut service, session);
    let rejected = service
        .request(
            json!({"operation":"send","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"text":"too many refs","resourceRefs":refs}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(rejected["controlOutcome"], "not-dispatched");

    std::os::unix::fs::symlink(temp.path().join("home"), temp.path().join("project/escape"))
        .unwrap();
    let current = live(&mut service, session);
    let rejected = service
        .request(
            json!({"operation":"send","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"text":"escape","resourceRefs":[{"kind":"directory","relativePath":"escape"}]}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(rejected["controlOutcome"], "not-dispatched");
}
#[test]
fn approvals_and_questions_require_exact_turn_and_native_resolution() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    send(&mut service, session, "approval", &id()).unwrap();
    let state = wait(&mut service, session, "awaiting-approval");
    assert_eq!(state["approvals"][0]["supported"], true);
    let rejected=service.request(json!({"operation":"approve","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":state["revision"],"experimentalEnabled":true,"turnId":"wrong","approvalId":90,"decision":"accept"}),"boot",false).unwrap();
    assert_eq!(rejected["controlOutcome"], "not-dispatched");
    let ok=service.request(json!({"operation":"approve","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":state["revision"],"experimentalEnabled":true,"turnId":state["turnId"],"approvalId":90,"decision":"decline"}),"boot",false).unwrap();
    assert_eq!(ok["accepted"], true);
    wait(&mut service, session, "idle");
    send(&mut service, session, "question", &id()).unwrap();
    let state = wait(&mut service, session, "waiting-input");
    let ok=service.request(json!({"operation":"answer","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":state["revision"],"experimentalEnabled":true,"turnId":state["turnId"],"questionId":91,"answers":{"choice":["A"]}}),"boot",false).unwrap();
    assert_eq!(ok["accepted"], true);
    wait(&mut service, session, "idle");
}
#[test]
fn rejects_arbitrary_permissions_and_unsupported_model_before_start() {
    let (_temp, mut service, workspace) = fixture();
    assert!(service.request(json!({"operation":"create","workspaceId":workspace,"requestId":id(),"cwd":"/","sandbox":"danger-full-access"}),"boot",true).is_err());
    let result=service.request(json!({"operation":"create","workspaceId":workspace,"requestId":id(),"model":"not-offered"}),"boot",true).unwrap();
    assert_eq!(result["controlOutcome"], "not-dispatched");
    assert!(service.runners.is_empty());
}
#[test]
fn stop_targets_only_current_turn() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    send(&mut service, session, "hold", &id()).unwrap();
    let snapshot = wait(&mut service, session, "running");
    let result=service.request(json!({"operation":"stop","sessionId":session,"requestId":id(),"runtimeBootId":"boot","expectedRevision":snapshot["revision"],"experimentalEnabled":true,"turnId":snapshot["turnId"]}),"boot",false).unwrap();
    assert_eq!(result["accepted"], true);
    wait(&mut service, session, "idle");
}
#[test]
fn native_history_is_required_to_resolve_a_lost_send() {
    let t = json!({"id":"thread","turns":[{"id":"turn","status":"completed","items":[{"type":"userMessage","id":"native","clientId":"request"}]}]});
    assert!(reconciles("request", &json!({"operation":"send"}), &t));
    assert!(!reconciles("other", &json!({"operation":"send"}), &t));
    assert!(!reconciles(
        "request",
        &json!({"operation":"approve","turnId":"other"}),
        &t
    ));
    assert!(!reconciles(
        "request",
        &json!({"operation":"approve","turnId":"turn"}),
        &t
    ));
}
#[test]
fn lost_send_receipt_is_reconciled_without_replaying_prompt() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert!(send(&mut service, session, "lost-receipt", &id()).is_err());
    assert_eq!(live(&mut service, session)["sendEnabled"], false);
    // The mock persisted the exact client message identity before closing transport.
    let result = service
        .request(
            json!({"operation":"reconcile","sessionId":session,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(result["reconciled"], true);
    assert_eq!(result["live"]["sendEnabled"], true);
}

#[test]
fn managed_receipts_query_matches_device_and_original_boot() {
    let (_temp, mut service, workspace) = fixture();
    let request = id();
    let created=service.request(json!({"operation":"create","workspaceId":workspace,"requestId":request,"deviceId":"device-a"}),"original-boot",true).unwrap();
    let receipt = service
        .receipt(json!({"requestId":request,"deviceId":"device-a"}))
        .unwrap();
    assert_eq!(receipt["status"], "accepted");
    assert_eq!(receipt["sessionId"], created["sessionId"]);
    assert_eq!(receipt["operation"], "create");
    assert_eq!(receipt["runtimeBootId"], "original-boot");
    assert_eq!(
        service
            .receipt(json!({"requestId":request,"deviceId":"device-b"}))
            .unwrap()["found"],
        false
    );
}

fn operation(service: &mut Service, session: &str, name: &str, mut params: Value) -> Value {
    let current = live(service, session);
    params["operation"] = json!(name);
    params["sessionId"] = json!(session);
    params["requestId"] = json!(id());
    params["runtimeBootId"] = json!("boot");
    params["expectedRevision"] = current["revision"].clone();
    params["experimentalEnabled"] = json!(true);
    service.request(params, "boot", false).unwrap()
}
#[test]
fn completion_capabilities_follow_native_execution_state() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let capabilities = service.capabilities(session, "boot", true).unwrap();
    assert_eq!(capabilities["features"]["send"]["available"], true);
    assert_eq!(capabilities["features"]["steer"]["available"], false);
    assert_eq!(capabilities["features"]["queue-add"]["available"], false);
    for op in ["steer", "queue-add"] {
        assert_eq!(
            capabilities["features"][op]["reason"],
            "session-requires-running-turn"
        );
    }
    assert_eq!(capabilities["features"]["stop"]["reason"], "no-active-turn");
    assert_eq!(
        capabilities["features"]["resume"]["reason"],
        "session-already-managed"
    );
    assert_eq!(
        capabilities["features"]["unarchive"]["reason"],
        "session-not-archived"
    );
    assert_eq!(
        capabilities["features"]["queue-start"],
        json!({"available":false,"reason":"native-operation-not-integrated"})
    );
    assert_eq!(
        capabilities["features"]["worktree-create"]["available"],
        false
    );
    send(&mut service, session, "hold", &id()).unwrap();
    let capabilities = service.capabilities(session, "boot", true).unwrap();
    assert_eq!(capabilities["features"]["send"]["available"], false);
    assert_eq!(capabilities["features"]["steer"]["available"], true);
    assert_eq!(capabilities["features"]["queue-add"]["available"], true);
    for op in ["send", "rename", "settings", "archive", "fork"] {
        assert_eq!(
            capabilities["features"][op],
            json!({"available":false,"reason":"session-busy"})
        );
    }
    let disabled = service.capabilities(session, "boot", false).unwrap();
    for op in ["send", "rename", "settings", "steer", "queue-add", "resume"] {
        assert_eq!(
            disabled["features"][op],
            json!({"available":false,"reason":"control-disabled"})
        );
    }
}
#[test]
fn capability_reasons_preserve_native_archive_and_release_state() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(&mut service, session, "archive", json!({}))["accepted"],
        true
    );
    let capabilities = service.capabilities(session, "boot", true).unwrap();
    assert_eq!(capabilities["features"]["unarchive"]["available"], true);
    for op in ["send", "rename", "settings", "resume"] {
        assert_eq!(
            capabilities["features"][op],
            json!({"available":false,"reason":"session-archived"})
        );
    }
    operation(&mut service, session, "unarchive", json!({}));
    let capabilities = service.capabilities(session, "boot", true).unwrap();
    assert_eq!(capabilities["features"]["resume"]["available"], true);
    assert_eq!(
        capabilities["features"]["send"],
        json!({"available":false,"reason":"session-released"})
    );
}
#[test]
fn native_queue_and_steer_use_request_identity_and_turn_precondition() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(
            &mut service,
            session,
            "queue-add",
            json!({"text":"no idle queue"})
        )["accepted"],
        false
    );
    send(&mut service, session, "hold", &id()).unwrap();
    let turn = live(&mut service, session)["turnId"].clone();
    assert_eq!(
        operation(
            &mut service,
            session,
            "steer",
            json!({"text":"wrong","turnId":"old"})
        )["accepted"],
        false
    );
    assert_eq!(
        operation(
            &mut service,
            session,
            "steer",
            json!({"text":"add","turnId":turn})
        )["accepted"],
        true
    );
    let added = operation(&mut service, session, "queue-add", json!({"text":"next"}));
    let queue_id = added["result"]["queuedSubmission"]["id"].clone();
    assert!(queue_id.is_string());
    assert_eq!(
        operation(
            &mut service,
            session,
            "queue-update",
            json!({"text":"edited","queuedSubmissionId":queue_id})
        )["accepted"],
        true
    );
    let list = service
        .request(
            json!({"operation":"queue-list","sessionId":session}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(list["data"][0]["input"][0]["text"], "edited");
    assert_eq!(
        operation(
            &mut service,
            session,
            "queue-delete",
            json!({"queuedSubmissionId":queue_id})
        )["accepted"],
        true
    );
}
#[test]
fn released_session_requires_explicit_resume_and_keeps_native_id() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
    let native = service
        .ledger()
        .unwrap()
        .get(session)
        .unwrap()
        .unwrap()
        .native_id;
    service
        .request(
            json!({"operation":"release","sessionId":session,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(
        operation(&mut service, session, "resume", json!({}))["accepted"],
        false
    );
    let resumed = operation(
        &mut service,
        session,
        "resume",
        json!({"handoffConfirmed":true}),
    );
    assert_eq!(resumed["accepted"], true, "resume rejected: {resumed}");
    assert_eq!(
        service
            .ledger()
            .unwrap()
            .get(session)
            .unwrap()
            .unwrap()
            .native_id,
        native
    );
    assert_eq!(live(&mut service, session)["sendEnabled"], true);
}
#[test]
fn metadata_changes_and_archive_do_not_fake_a_loaded_writer() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(&mut service, session, "rename", json!({"name":"Renamed"}))["accepted"],
        true
    );
    assert_eq!(service.catalog().unwrap()[0]["title"], "Renamed");
    assert_eq!(
        operation(
            &mut service,
            session,
            "settings",
            json!({"model":"mock-model","effort":"medium"})
        )["accepted"],
        true
    );
    assert_eq!(
        operation(
            &mut service,
            session,
            "settings",
            json!({"model":"not-offered"})
        )["accepted"],
        false
    );
    assert_eq!(
        operation(&mut service, session, "archive", json!({}))["accepted"],
        true
    );
    assert_eq!(live(&mut service, session)["status"], "archived");
    assert_eq!(
        operation(&mut service, session, "unarchive", json!({}))["requiresResume"],
        true
    );
    assert_eq!(live(&mut service, session)["sendEnabled"], false);
}
#[test]
fn host_default_model_preserves_mode_as_pending_until_native_event() {
    let (_temp, mut service, workspace) = fixture();
    let created = service
        .request(
            json!({"operation":"create","workspaceId":workspace,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let record = ledger.get(session).unwrap().unwrap();
    assert_eq!(record.model.as_deref(), Some("mock-model"));
    assert_eq!(record.effort.as_deref(), Some("medium"));
    let rejected = operation(
        &mut service,
        session,
        "settings",
        json!({"mode":"invented"}),
    );
    assert_eq!(rejected["accepted"], false);
    assert_eq!(rejected["controlOutcome"], "not-dispatched");

    service
        .request(
            json!({"operation":"release","sessionId":session,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    // Resume cannot confirm the mode, but preserves the next-turn selection.
    let mut record = ledger.get(session).unwrap().unwrap();
    record.model = None;
    record.effort = None;
    record.mode = Some("plan".into());
    ledger.save(&record).unwrap();
    let resumed = operation(
        &mut service,
        session,
        "resume",
        json!({"handoffConfirmed":true}),
    );
    assert_eq!(resumed["accepted"], true, "resume rejected: {resumed}");
    let record = ledger.get(session).unwrap().unwrap();
    assert_eq!(record.model.as_deref(), Some("mock-model"));
    assert_eq!(record.effort.as_deref(), Some("medium"));
    assert_eq!(record.mode.as_deref(), Some("plan"));
    assert_eq!(
        state::settings_projection(&record)["applicationStatus"],
        "pending"
    );
}
#[test]
fn input_mapping_rejects_rpc_injection_and_relative_images() {
    let req = |input| {
        serde_json::from_value::<Request>(json!({"operation":"send","input":input})).unwrap()
    };
    assert!(
        completion::input(&req(
            json!([{"type":"skill","path":"/tmp/x","name":"evil"}])
        ))
        .is_err()
    );
    assert!(completion::input(&req(json!([{"type":"localImage","path":"../image.png"}]))).is_err());
    assert_eq!(
        completion::input(&req(
            json!([{"type":"text","text":"hello","text_elements":[]}])
        ))
        .unwrap(),
        json!([{"type":"text","text":"hello"}])
    );
}

#[test]
fn completed_turn_is_not_an_approval_resolution_acknowledgement() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    send(&mut service, session, "hold", &id()).unwrap();
    let ledger = service.ledger().unwrap();
    let runner = service.runners.get(session).unwrap();
    let mut state = runner.state.lock().unwrap();
    let native = state.record.native_id.clone();
    let turn = state.turn.clone();
    let cwd = state.record.workspace.clone();
    state.event(json!({"method":"item/commandExecution/requestApproval","id":777,"params":{"threadId":native,"turnId":turn,"itemId":"cmd","cwd":cwd,"command":"true"}}),&ledger).unwrap();
    state.event(json!({"method":"turn/completed","params":{"threadId":native,"turn":{"id":turn,"status":"completed"}}}),&ledger).unwrap();
    assert!(state.approvals.is_empty());
    assert!(
        !state
            .resolved_requests
            .contains(&format!("{}:777", turn.as_deref().unwrap()))
    );
    state
        .event(
            json!({"method":"serverRequest/resolved","params":{"threadId":native,"requestId":777}}),
            &ledger,
        )
        .unwrap();
    assert!(
        state
            .resolved_requests
            .contains(&format!("{}:777", turn.as_deref().unwrap()))
    );
}
#[test]
fn native_inspection_recovers_a_proven_message_without_replaying() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let request = id();
    send(&mut service, session, "hello", &request).unwrap();
    wait(&mut service, session, "idle");
    // A lost transport reply is represented by the original durable request ID.
    let ledger = service.ledger().unwrap();
    rusqlite::Connection::open(_temp.path().join("ledger/executions.sqlite"))
        .unwrap()
        .execute(
            "UPDATE managed_commands SET phase='dispatched' WHERE request_id=?1",
            [&request],
        )
        .unwrap();
    {
        let mut state = service.runners.get(session).unwrap().state.lock().unwrap();
        state.fail("control-outcome-unconfirmed");
        state.save(&ledger).unwrap();
    }
    assert_eq!(
        service.inspect(session, "boot").unwrap()["reconciled"],
        true
    );
    assert_eq!(live(&mut service, session)["sendEnabled"], true);
}

#[test]
fn inspection_uses_exact_late_resolution_only_in_same_runtime() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    send(&mut service, session, "approval", &id()).unwrap();
    let current = wait(&mut service, session, "awaiting-approval");
    let request = id();
    let ack=service.request(json!({"operation":"approve","sessionId":session,"requestId":request,"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"approvalId":90,"turnId":current["turnId"],"nativeDecision":"accept"}),"boot",false).unwrap();
    assert_eq!(ack["accepted"], true);
    wait(&mut service, session, "idle");
    rusqlite::Connection::open(_temp.path().join("ledger/executions.sqlite"))
        .unwrap()
        .execute(
            "UPDATE managed_commands SET phase='dispatched' WHERE request_id=?1",
            [&request],
        )
        .unwrap();
    let ledger = service.ledger().unwrap();
    {
        let mut state = service.runners.get(session).unwrap().state.lock().unwrap();
        state.fail("control-outcome-unconfirmed");
        state.save(&ledger).unwrap();
    }
    assert_eq!(
        service.inspect(session, "different-boot").unwrap()["reconciled"],
        false
    );
    assert_eq!(
        service.inspect(session, "boot").unwrap()["reconciled"],
        true
    );
    assert_eq!(live(&mut service, session)["sendEnabled"], true);
}

#[test]
fn release_preserves_unknown_approval_and_answer_evidence_until_inspected() {
    for (operation_name, prompt, waiting, native_request) in [
        ("approve", "approval", "awaiting-approval", 90),
        ("answer", "question", "waiting-input", 91),
    ] {
        let (temp, mut service, workspace) = fixture();
        let created = create(&mut service, &workspace);
        let session = created["sessionId"].as_str().unwrap();
        send(&mut service, session, prompt, &id()).unwrap();
        let current = wait(&mut service, session, waiting);
        let request = id();
        let mut input = json!({"operation":operation_name,"sessionId":session,"requestId":request,"runtimeBootId":"boot","expectedRevision":current["revision"],"experimentalEnabled":true,"turnId":current["turnId"]});
        if operation_name == "approve" {
            input["approvalId"] = json!(native_request);
            input["nativeDecision"] = json!("accept");
        } else {
            input["questionId"] = json!(native_request);
            input["answers"] = json!({"choice":["A"]});
        }
        assert_eq!(
            service.request(input, "boot", false).unwrap()["accepted"],
            true
        );
        wait(&mut service, session, "idle");
        let ledger = service.ledger().unwrap();
        let native = ledger.get(session).unwrap().unwrap().native_id;
        // The native response arrived but its durable acknowledgement was lost.
        rusqlite::Connection::open(temp.path().join("ledger/executions.sqlite"))
            .unwrap()
            .execute(
                "UPDATE managed_commands SET phase='dispatched',result=NULL WHERE request_id=?1",
                [&request],
            )
            .unwrap();
        let release_id = id();
        let release = json!({"operation":"release","sessionId":session,"requestId":release_id,"deviceId":"browser"});
        let rejected = service.request(release.clone(), "boot", true).unwrap();
        assert_eq!(rejected["accepted"], false);
        assert_eq!(rejected["controlOutcome"], "not-dispatched");
        assert_eq!(rejected["reason"], "control-outcome-unconfirmed");
        assert_eq!(
            ledger.receipt(&release_id, "browser").unwrap()["status"],
            "not-dispatched"
        );
        assert!(service.runners.get(session).unwrap().client.connected());
        assert!(!ledger.get(session).unwrap().unwrap().released);
        assert!(ledger.has_unknown(session).unwrap());
        assert_eq!(
            service.inspect(session, "different-boot").unwrap()["reconciled"],
            false
        );
        assert_eq!(
            service.inspect(session, "boot").unwrap()["reconciled"],
            true
        );
        assert!(!ledger.has_unknown(session).unwrap());
        // A retry of the rejected command remains rejected; a new explicit
        // release is required after reconciliation and can then be resumed.
        assert_eq!(service.request(release, "boot", true).unwrap(), rejected);
        assert!(service.runners.contains_key(session));
        assert_eq!(
            service
                .request(
                    json!({"operation":"release","sessionId":session,"requestId":id()}),
                    "boot",
                    true
                )
                .unwrap()["released"],
            true
        );
        assert_eq!(
            operation(
                &mut service,
                session,
                "resume",
                json!({"handoffConfirmed":true})
            )["accepted"],
            true
        );
        assert_eq!(ledger.get(session).unwrap().unwrap().native_id, native);
    }
}

#[test]
fn released_adopted_session_capabilities_return_to_follower() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    service
        .request(
            json!({"operation":"release","sessionId":session,"requestId":id()}),
            "boot",
            true,
        )
        .unwrap();
    // Newly created tasks retain their managed identity when released.
    assert_eq!(
        service.capabilities(session, "boot", true).unwrap()["executionMode"],
        "codex-managed"
    );
    let ledger = service.ledger().unwrap();
    let mut record = ledger.get(session).unwrap().unwrap();
    record.adopted = true;
    ledger.save(&record).unwrap();
    assert!(!service.owns(session).unwrap());
    let caps = service.capabilities(session, "boot", true).unwrap();
    assert_eq!(caps["executionMode"], "codex-follower");
    assert_eq!(caps["status"], "native-host-required");
    assert_eq!(caps["features"]["steer"]["available"], false);
    assert_eq!(caps["features"]["resume"]["available"], true);
}

#[test]
fn plan_selection_is_pending_and_native_turn_uses_host_instructions() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"plan"}))["accepted"],
        true
    );
    assert_eq!(
        live(&mut service, session)["settings"]["applicationStatus"],
        "pending"
    );
    assert!(!temp.path().join("home/turn-calls.jsonl").exists());
    assert_eq!(
        service.capabilities(session, "boot", true).unwrap()["features"]["goal-set"],
        json!({"available":false,"reason":"settings-not-applied"})
    );
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"unsafe pending","intent":"start"}})
        )["accepted"],
        false
    );
    assert!(!temp.path().join("home/goal-calls.jsonl").exists());
    assert_eq!(
        operation(
            &mut service,
            session,
            "settings",
            json!({"resetDefaults":true})
        )["accepted"],
        true
    );
    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
    let calls = std::fs::read_to_string(temp.path().join("home/turn-calls.jsonl")).unwrap();
    let call: Value = serde_json::from_str(calls.lines().last().unwrap()).unwrap();
    assert_eq!(call["collaborationMode"]["mode"], "plan");
    assert!(call["collaborationMode"]["settings"]["developer_instructions"].is_null());
    assert_eq!(
        call["collaborationMode"]["settings"]["model"],
        call["model"]
    );
    assert_eq!(
        call["collaborationMode"]["settings"]["reasoning_effort"],
        call["effort"]
    );
    assert_eq!(
        live(&mut service, session)["settings"]["current"]["mode"],
        "plan"
    );
    assert_eq!(
        live(&mut service, session)["streamText"],
        "# Native plan\nInspect, then implement."
    );
    let events = service
        .ledger()
        .unwrap()
        .events(session, None, 100)
        .unwrap();
    assert!(events.to_string().contains("Native plan"));

    assert_eq!(
        live(&mut service, session)["settings"]["applicationStatus"],
        "confirmed"
    );
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"default"}))["accepted"],
        true
    );
    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
    assert_eq!(
        live(&mut service, session)["settings"]["current"]["mode"],
        "default"
    );
}

#[test]
fn goal_update_preserves_paused_state_and_budget_omission_is_distinct_from_null() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"initial","tokenBudget":2000,"intent":"start"}})
        )["accepted"],
        true
    );
    assert_eq!(
        operation(&mut service, session, "goal-pause", json!({}))["accepted"],
        true
    );
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"updated","intent":"update"}})
        )["accepted"],
        true
    );
    let snapshot = live(&mut service, session);
    assert_eq!(snapshot["goal"]["status"], "paused");
    assert_eq!(snapshot["goal"]["tokenBudget"], 2000);
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"updated","tokenBudget":null,"intent":"update"}})
        )["accepted"],
        true
    );
    assert!(live(&mut service, session)["goal"]["tokenBudget"].is_null());
    let calls = std::fs::read_to_string(temp.path().join("home/goal-calls.jsonl")).unwrap();
    let rows: Vec<Value> = calls
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(rows[2].get("status").is_none());
    assert!(rows[2].get("tokenBudget").is_none());
    assert!(rows[3]["tokenBudget"].is_null());
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"plan"}))["accepted"],
        true
    );
    assert_eq!(
        operation(&mut service, session, "goal-resume", json!({}))["accepted"],
        false
    );
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"still paused","intent":"update"}})
        )["accepted"],
        true
    );
    assert_eq!(live(&mut service, session)["goal"]["status"], "paused");
}

#[test]
fn missing_modes_or_native_confirmation_never_claims_plan_applied() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    std::fs::write(temp.path().join("home/disable-modes"), "").unwrap();
    let settings = service
        .request(
            json!({"operation":"settings-state","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(settings["settings"]["writable"]["mode"]["available"], false);
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"plan"}))["accepted"],
        false
    );
    std::fs::remove_file(temp.path().join("home/disable-modes")).unwrap();
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"plan"}))["accepted"],
        true
    );
    std::fs::write(temp.path().join("home/suppress-settings-event"), "").unwrap();
    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
    assert_eq!(
        live(&mut service, session)["settings"]["applicationStatus"],
        "pending"
    );
}

#[test]
fn goal_capabilities_follow_native_status_and_legal_immediate_limits() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    for (status, pause, resume) in [
        ("active", true, false),
        ("paused", false, true),
        ("blocked", false, true),
        ("complete", false, false),
        ("budgetLimited", false, true),
        ("usageLimited", false, true),
    ] {
        {
            let mut state = service.runners[session].state.lock().unwrap();
            state.record.goal =
                Some(json!({"objective":"goal","status":status,"tokenBudget":1,"tokensUsed":2}));
            state.save(&ledger).unwrap();
        }
        let caps = service.capabilities(session, "boot", true).unwrap();
        assert_eq!(
            caps["features"]["goal-pause"]["available"], pause,
            "{status}"
        );
        assert_eq!(
            caps["features"]["goal-resume"]["available"], resume,
            "{status}"
        );
    }
    let req: Request = serde_json::from_value(
        json!({"operation":"goal-set","goal":{"objective":"goal","tokenBudget":1}}),
    )
    .unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    state.record.goal =
        Some(json!({"objective":"goal","status":"budgetLimited","tokenBudget":1,"tokensUsed":2}));
    assert!(completion::mutation_confirmed(&req, &state));
    let resume: Request = serde_json::from_value(json!({"operation":"goal-resume"})).unwrap();
    assert!(completion::mutation_confirmed(&resume, &state));
    state.record.goal.as_mut().unwrap()["objective"] = json!("other goal");
    assert!(!completion::mutation_confirmed(&req, &state));
}

#[test]
fn native_goal_event_after_mutation_is_not_rewound_to_receipt() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    std::fs::write(temp.path().join("home/goal-fast-event"), "").unwrap();
    let receipt = operation(
        &mut service,
        session,
        "goal-set",
        json!({"goal":{"objective":"native budget","tokenBudget":1}}),
    );
    assert_eq!(receipt["accepted"], true);
    assert_eq!(
        live(&mut service, session)["goal"]["status"],
        "budgetLimited"
    );
    assert_eq!(live(&mut service, session)["goal"]["tokensUsed"], 2);
}

#[test]
fn old_cli_keeps_basic_operations_but_does_not_claim_plan_validation() {
    let (_temp, mut service, workspace) = fixture();
    let path = service.test_executable.as_ref().unwrap();
    let source = std::fs::read_to_string(path)
        .unwrap()
        .replace("codex-cli 0.155.1", "codex-cli 0.155.0-alpha.16.3");
    std::fs::write(path, source).unwrap();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let settings = service
        .request(
            json!({"operation":"settings-state","sessionId":session}),
            "boot",
            true,
        )
        .unwrap();
    assert_eq!(settings["settings"]["writable"]["mode"]["available"], false);
    assert_eq!(
        operation(&mut service, session, "settings", json!({"mode":"plan"}))["accepted"],
        false
    );
    send(&mut service, session, "hello", &id()).unwrap();
    wait(&mut service, session, "idle");
}

#[test]
fn selected_goal_read_preserves_newer_event_and_unchanged_reads_keep_revision() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    assert_eq!(
        operation(
            &mut service,
            session,
            "goal-set",
            json!({"goal":{"objective":"read race"}})
        )["accepted"],
        true
    );
    let marker = temp.path().join("home/goal-read-event");
    std::fs::write(&marker, "").unwrap();
    let query = json!({"operation":"goal","sessionId":session});
    let raced = service.request(query.clone(), "boot", true).unwrap();
    assert_eq!(raced["goal"]["status"], "blocked");
    std::fs::remove_file(marker).unwrap();
    let repeated = service.request(query, "boot", true).unwrap();
    assert_eq!(repeated["revision"], raced["revision"]);
}

fn hydrated_thread(native: &str, turns: Value) -> Value {
    json!({"id":native,"status":{"type":"idle"},"turns":turns})
}

fn hydration_turn(turn: &str, item: &str, text: &str) -> Value {
    json!({"id":turn,"status":"completed","items":[{"id":item,"type":"agentMessage","text":text}]})
}

#[test]
fn hydration_publishes_one_ordered_baseline_without_replaying_history_as_output() {
    let (_temp, mut service, workspace) = fixture();
    let (tx, rx) = std::sync::mpsc::channel();
    let hub = crate::session_stream::Hub::new("boot".into(), move |event| tx.send(event).is_ok());
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    let native = state.record.native_id.clone().unwrap();
    let newer = hydration_turn("newer-turn", "newer", "newer text");
    state
        .hydrate(&hydrated_thread(&native, json!([newer])), &ledger)
        .unwrap();
    let subscribed = hub.subscribe(session, None).unwrap();
    let older = hydration_turn("older-turn", "older", "older text");
    let history = hydrated_thread(&native, json!([older, newer]));
    let request = id();
    ledger
        .claim(
            &request,
            session,
            "fixture",
            None,
            &json!({"operation":"send"}),
        )
        .unwrap();
    ledger.dispatch(&request).unwrap();
    for _ in 0..2 {
        let revision = state.revision;
        state.hydrate(&history, &ledger).unwrap();
        let event = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event["subscriptionId"], subscribed["subscriptionId"]);
        assert_eq!(event["type"], "snapshot");
        let payload = &event["payload"];
        assert_eq!(
            payload["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["older", "newer"]
        );
        assert_eq!(payload["replaceItems"], true);
        assert_eq!(payload["preserveItemsOutsideCoverage"], true);
        assert_eq!(
            payload["authoritativeTurnIds"],
            json!(["older-turn", "newer-turn"])
        );
        assert_eq!(payload["live"]["executionMode"], "codex-managed");
        assert_eq!(payload["live"]["revision"], revision + 1);
        assert_eq!(payload["live"]["sendEnabled"], false);
        assert_eq!(
            ledger.get(session).unwrap().unwrap().snapshot["revision"],
            revision + 1
        );
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        let refreshed = hub
            .subscribe(session, subscribed["cursor"].as_str())
            .unwrap();
        hub.unsubscribe(refreshed["subscriptionId"].as_str().unwrap());
        assert_eq!(refreshed["events"][0]["type"], "snapshot");
        assert_eq!(refreshed["events"][0]["payload"]["items"], payload["items"]);
    }
    ledger.finish(&request, &json!({"accepted":true})).unwrap();
    state
        .event(
            json!({"method":"turn/started","params":{"turn":{"id":"live-turn"}}}),
            &ledger,
        )
        .unwrap();
    state.event(json!({"method":"item/completed","params":{"turnId":"live-turn","item":{"id":"live-item","type":"agentMessage","text":"real output"}}}), &ledger).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if event["type"] == "item-upsert" {
            assert_eq!(event["payload"]["id"], "live-item");
            break;
        }
    }
    let live = hub.subscribe(session, None).unwrap();
    assert_eq!(
        live["events"][0]["payload"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["older", "newer", "live-item"]
    );
    assert_eq!(
        ledger.events(session, None, 100).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn hydration_bounds_history_and_preserves_rollback_beyond_the_item_cache() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    let native = state.record.native_id.clone().unwrap();
    let turns: Vec<_> = (0..120)
        .map(|i| hydration_turn(&format!("turn-{i}"), &format!("item-{i}"), "history"))
        .collect();
    state
        .hydrate(&hydrated_thread(&native, json!(turns)), &ledger)
        .unwrap();
    let before = hub.subscribe(session, None).unwrap();
    let payload = &before["events"][0]["payload"];
    assert_eq!(payload["items"].as_array().unwrap().len(), 100);
    assert_eq!(payload["items"][0]["id"], "item-20");
    assert_eq!(payload["items"][99]["id"], "item-119");
    assert_eq!(
        payload["authoritativeTurnIds"].as_array().unwrap().len(),
        100
    );
    assert!(
        !payload["authoritativeTurnIds"]
            .as_array()
            .unwrap()
            .contains(&json!("turn-0"))
    );
    assert_eq!(payload["preserveItemsOutsideCoverage"], true);
    let page = ledger.events(session, None, 100).unwrap();
    assert_eq!(page["events"].as_array().unwrap().len(), 100);
    assert_eq!(
        ledger
            .events(session, page["next_cursor"].as_str(), 100)
            .unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        20
    );
    state
        .hydrate(&hydrated_thread(&native, json!(&turns[1..119])), &ledger)
        .unwrap();
    let after = hub.subscribe(session, before["cursor"].as_str()).unwrap();
    let payload = &after["events"][0]["payload"];
    assert_eq!(payload["removedTurnIds"], json!(["turn-0", "turn-119"]));
    let reconnect = hub.subscribe(session, None).unwrap();
    assert_eq!(
        reconnect["events"][0]["payload"]["removedTurnIds"],
        payload["removedTurnIds"]
    );
}

#[test]
fn hydration_partial_and_truncated_turns_never_claim_complete_coverage() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    let native = state.record.native_id.clone().unwrap();
    let items: Vec<_> = (0..110)
        .map(|i| json!({"id":format!("item-{i}"),"type":"agentMessage","text":"history"}))
        .collect();
    state
        .hydrate(
            &hydrated_thread(
                &native,
                json!([{"id":"long-turn","status":"completed","items":items},{"id":"unread-turn"}]),
            ),
            &ledger,
        )
        .unwrap();
    let snapshot = hub.subscribe(session, None).unwrap();
    assert_eq!(
        snapshot["events"][0]["payload"]["authoritativeTurnIds"],
        json!([])
    );
    hub.unsubscribe(snapshot["subscriptionId"].as_str().unwrap());
    let text = format!(
        "{}界",
        "x".repeat(crate::session_stream::MAX_ITEM_TEXT_BYTES - 2)
    );
    let items: Vec<_> = (0..10)
        .map(|i| json!({"id":format!("large-{i}"),"type":"agentMessage","text":text}))
        .collect();
    state
        .hydrate(
            &hydrated_thread(
                &native,
                json!([{"id":"large-turn","status":"inProgress","items":items}]),
            ),
            &ledger,
        )
        .unwrap();
    let snapshot = hub.subscribe(session, None).unwrap();
    let payload = &snapshot["events"][0]["payload"];
    assert!(
        serde_json::to_vec(&payload["items"]).unwrap().len()
            <= crate::session_stream::MAX_ITEMS_BYTES
    );
    assert_eq!(payload["authoritativeTurnIds"], json!([]));
    assert!(
        payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["truncated"] == true)
    );
    assert_eq!(payload["preserveItemsOutsideCoverage"], true);
    assert_eq!(state.items["large-9"]["text"], text);
}

#[test]
fn hydrate_response_precedes_following_live_notifications_on_resume_and_reconcile() {
    for operation in ["resume", "reconcile"] {
        let (temp, mut service, workspace) = fixture();
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        service.set_streams(hub.clone());
        let created = create(&mut service, &workspace);
        let session = created["sessionId"].as_str().unwrap();
        if operation == "resume" {
            service
                .request(
                    json!({"operation":"release","sessionId":session,"requestId":id()}),
                    "boot",
                    true,
                )
                .unwrap();
        }
        let baseline = hub.subscribe(session, None).unwrap();
        std::fs::write(temp.path().join("home/hydrate-response-live"), "").unwrap();
        let result = service.request(json!({"operation":operation,"sessionId":session,"requestId":id(),"runtimeBootId":"boot","experimentalEnabled":true,"handoffConfirmed":true}), "boot", true).unwrap();
        assert_eq!(
            result[if operation == "resume" {
                "accepted"
            } else {
                "reconciled"
            }],
            true
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let state = service.runners[session].state.lock().unwrap();
            if state.stream == "live after response" {
                assert_eq!(state.status, "running");
                assert_eq!(state.turn.as_deref(), Some("after-hydration"));
                break;
            }
            drop(state);
            assert!(
                Instant::now() < deadline,
                "live event was overwritten after {operation}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let replay = hub.subscribe(session, baseline["cursor"].as_str()).unwrap();
        assert_eq!(replay["events"][0]["type"], "snapshot");
        let payload = &replay["events"][0]["payload"];
        assert_eq!(payload["live"]["status"], "running");
        assert_eq!(payload["items"][0]["id"], "after-hydration-item");
        assert_eq!(payload["items"][0]["content"], "live after response");
    }
}

#[test]
fn hydrated_active_text_accepts_continuing_deltas_and_empty_turns_are_authoritative() {
    let (_temp, mut service, workspace) = fixture();
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    service.set_streams(hub.clone());
    let created = create(&mut service, &workspace);
    let session = created["sessionId"].as_str().unwrap();
    let ledger = service.ledger().unwrap();
    let mut state = service.runners[session].state.lock().unwrap();
    let native = state.record.native_id.clone().unwrap();
    let mut thread = hydrated_thread(
        &native,
        json!([
            {"id":"empty","status":"completed","items":[]},
            {"id":"missing","status":"completed"},
            {"id":"active","status":"inProgress","items":[{"id":"text","type":"agentMessage","text":"prefix🙂"}]}
        ]),
    );
    thread["status"]["type"] = json!("active");
    state.hydrate(&thread, &ledger).unwrap();
    let initial = hub.subscribe(session, None).unwrap();
    let coverage = initial["events"][0]["payload"]["authoritativeTurnIds"]
        .as_array()
        .unwrap();
    assert!(coverage.contains(&json!("empty")));
    assert!(!coverage.contains(&json!("missing")));
    assert_eq!(
        initial["events"][0]["payload"]["live"]["streamText"],
        "prefix🙂"
    );
    state.event(json!({"method":"item/agentMessage/delta","params":{"turnId":"active","itemId":"text","delta":" suffix"}}), &ledger).unwrap();
    let updated = hub.subscribe(session, initial["cursor"].as_str()).unwrap();
    let delta = updated["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "text-delta")
        .unwrap();
    assert_eq!(delta["payload"]["text"], " suffix");
    assert_eq!(delta["payload"]["offset"], 8);
    let restored = hub.subscribe(session, None).unwrap();
    assert_eq!(
        restored["events"][0]["payload"]["items"][0]["content"],
        "prefix🙂 suffix"
    );
}
