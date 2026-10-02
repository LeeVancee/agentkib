//! Real Runtime/RPC integration with a synthetic extension peer and profile.
//! This exercises the bridge contract, not Cursor UI or an installed extension.
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use agentkib_conversations::{NativeSessionSummary, SessionAvailability, SessionOrigin};
use agentkib_core::AgentKind;
use agentkib_store::Store;
use serde_json::{Value, json};

struct Fixture {
    root: tempfile::TempDir,
    workspace: PathBuf,
    workspace_id: String,
    source_id: String,
    source: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let workspace = root.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(root.path().join("home")).unwrap();
        let store = Store::open(&root.path().join("data/agentkib.db")).unwrap();
        let workspace_id = store.add_workspace(&workspace).unwrap().id;
        let native_id = uuid::Uuid::new_v4().to_string();
        let source = root
            .path()
            .join("claude/projects/synthetic")
            .join(format!("{native_id}.jsonl"));
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let user_id = uuid::Uuid::new_v4().to_string();
        let user = json!({"type":"user","uuid":user_id,"parentUuid":null,"sessionId":native_id,
            "cwd":workspace,"timestamp":"2026-09-27T00:00:00Z",
            "message":{"role":"user","content":"Marker kiwi-8492. Decision: use SQLite."}});
        let assistant = json!({"type":"assistant","uuid":uuid::Uuid::new_v4(),"parentUuid":user_id,
            "sessionId":native_id,"cwd":workspace,"timestamp":"2026-09-27T00:00:01Z",
            "message":{"role":"assistant","content":[{"type":"text","text":"Agreed: SQLite."}]}});
        fs::write(&source, format!("{user}\n{assistant}\n")).unwrap();
        let sessions = store
            .sync_conversation_sessions(
                &workspace_id,
                AgentKind::ClaudeCode,
                &[NativeSessionSummary {
                    native_ref: native_id,
                    agent: AgentKind::ClaudeCode,
                    title: Some("Synthetic".into()),
                    origin: SessionOrigin::default(),
                    spawned_by_session_id: None,
                    forked_from_session_id: None,
                    created_at: None,
                    updated_at: None,
                    message_count: Some(2),
                    git_branch: None,
                    archived: false,
                    sidechain: false,
                    availability: SessionAvailability::Readable,
                }],
            )
            .unwrap();
        // Each child has independent application data, HOME and MCP port.
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        fs::write(
            root.path().join("data/preferences.json"),
            json!({"mcp_network":{
            "port":port,"lan_enabled":false,"lan_risk_accepted":false}})
            .to_string(),
        )
        .unwrap();
        Self {
            root,
            workspace,
            workspace_id,
            source_id: sessions[0].id.clone(),
            source,
        }
    }

    fn runtime(&self) -> Runtime {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agentkib-runtime"))
            .env_clear()
            .env("AGENTKIB_BENCHMARK_DATA_DIR", self.root.path().join("data"))
            .env("CLAUDE_CONFIG_DIR", self.root.path().join("claude"))
            .env("HOME", self.root.path().join("home"))
            .env("USERPROFILE", self.root.path().join("home"))
            .env("APPDATA", self.root.path().join("appdata"))
            .env("LOCALAPPDATA", self.root.path().join("localappdata"))
            .env("PATH", "")
            .current_dir(&self.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        let mut runtime = Runtime {
            child,
            stdin,
            responses,
            pending: BTreeMap::new(),
            next_id: 1,
        };
        runtime.ok(
            agentkib_protocol::HANDSHAKE_METHOD,
            json!({"protocolVersion":agentkib_protocol::PROTOCOL_VERSION,
            "client":{"name":"cursor-bridge-fixture","version":"0.0.0"}}),
        );
        runtime.ok("runtime.info", json!({}));
        runtime
    }

    fn bridge_request(&self, action: &str) -> Value {
        json!({"action":action,"workspaceId":self.workspace_id})
    }
}

struct Runtime {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<Value>,
    pending: BTreeMap<u64, Value>,
    next_id: u64,
}
impl Runtime {
    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.stdin.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        id
    }
    fn receive(&mut self, id: u64, timeout: Duration) -> Value {
        if let Some(v) = self.pending.remove(&id) {
            return v;
        }
        let start = Instant::now();
        loop {
            let value = self
                .responses
                .recv_timeout(timeout.saturating_sub(start.elapsed()))
                .expect("bounded Runtime response");
            if let Some(other) = value["id"].as_u64() {
                if other == id {
                    return value;
                }
                assert!(
                    self.pending.insert(other, value).is_none(),
                    "duplicate RPC response"
                );
            }
        }
    }
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.receive(id, Duration::from_secs(15))
    }
    fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.rpc(method, params);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }
    fn stop(&mut self) {
        self.stdin.take();
        let start = Instant::now();
        while self.child.try_wait().unwrap().is_none() {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "Runtime did not cancel owned socket on EOF"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn public_bridge_rejects_unknown_actions_fields_and_workspaces() {
    let f = Fixture::new();
    let mut runtime = f.runtime();
    for request in [
        f.bridge_request("execute"),
        json!({"action":"status","workspaceId":f.workspace_id,"arbitrary":true}),
        json!({"action":"status","workspaceId":"missing-workspace"}),
    ] {
        assert!(runtime.rpc("cursor.bridge", request).get("error").is_some());
    }
    let status = runtime.ok("cursor.bridge", f.bridge_request("status"));
    assert_eq!(status["bindings"], json!([]));
    assert_eq!(status["supported"], cfg!(target_os = "macos"));
    runtime.stop();
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unverified_platform_cannot_connect_or_preview_cursor_ide() {
    let f = Fixture::new();
    let mut runtime = f.runtime();
    let response = runtime.rpc("cursor.bridge", f.bridge_request("connect"));
    assert!(response.get("error").is_some(), "{response}");
    let response = runtime.rpc(
        "sessions.prepareHandoff",
        json!({"request":{
        "session_id":f.source_id,"target_agent":"cursor","target_surface":"cursor-ide",
        "binding_id":uuid::Uuid::new_v4(),"format":"markdown","history_budget_tokens":64000}}),
    );
    assert!(response.get("error").is_some(), "{response}");
    assert!(
        !f.root
            .path()
            .join("data/cursor-bridge/profiles-v1.json")
            .exists()
    );
    runtime.stop();
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use rusqlite::{Connection, params};
    use std::os::unix::net::UnixStream;

    struct Profile {
        db: PathBuf,
        app: PathBuf,
        storage: PathBuf,
    }
    impl Profile {
        fn new(f: &Fixture) -> Self {
            let app = f.root.path().join("Cursor.app/resources/app");
            let storage = f
                .root
                .path()
                .join("profile/User/globalStorage/agentkib.cursor-bridge");
            fs::create_dir_all(&app).unwrap();
            fs::create_dir_all(&storage).unwrap();
            fs::write(
                app.join("package.json"),
                r#"{"name":"Cursor","version":"3.22.12"}"#,
            )
            .unwrap();
            let db = storage.parent().unwrap().join("state.vscdb");
            Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=1; CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB); CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency INTEGER,checkpointAt INTEGER,subagentTypeName TEXT,value TEXT);").unwrap();
            Self { db, app, storage }
        }
        fn hello(&self, f: &Fixture) -> Value {
            json!({"protocol":1,"extension_version":"0.1.0","workspace":f.workspace,
                "global_storage":self.storage,"app_root":self.app,"session_id":"fixture-window","extension_mode":1})
        }
        // Same observed v18 shape as the codec's frozen official export fixture.
        // Only this synthetic extension peer writes its private profile database.
        fn store(&self, f: &Fixture, request: &Value, native: &str, blobs: bool) {
            let export: Value =
                serde_json::from_str(request["args"]["payload"].as_str().unwrap()).unwrap();
            let path = f.workspace.to_str().unwrap();
            let mut uri = String::from("file://");
            for byte in path.bytes() {
                if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
                    uri.push(byte as char)
                } else {
                    uri.push_str(&format!("%{byte:02X}"))
                }
            }
            let workspace = json!({"id":"observed-fixture-workspace","uri":{"scheme":"file","external":uri,"fsPath":path}});
            let header = json!({"composerId":native,"name":export["name"],"workspaceIdentifier":workspace,"type":"head"});
            let composer = json!({"composerId":native,"_v":18,"workspaceIdentifier":workspace,"conversationState":format!("~{}",export["conversationState"].as_str().unwrap())});
            let db = Connection::open(&self.db).unwrap();
            db.execute("INSERT OR REPLACE INTO composerHeaders VALUES (?1,'observed-fixture-workspace',1790770000000,1790770000001,0,0,1,0,NULL,?2)",params![native,header.to_string()]).unwrap();
            db.execute(
                "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1,?2)",
                params![format!("composerData:{native}"), composer.to_string()],
            )
            .unwrap();
            if blobs {
                for (id, value) in export["blobs"].as_object().unwrap() {
                    db.execute(
                        "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1,?2)",
                        params![
                            format!("agentKv:blob:{id}"),
                            STANDARD.decode(value.as_str().unwrap()).unwrap()
                        ],
                    )
                    .unwrap();
                }
            }
        }
        fn count(&self) -> u64 {
            Connection::open(&self.db)
                .unwrap()
                .query_row("SELECT count(*) FROM composerHeaders", [], |r| r.get(0))
                .unwrap()
        }
    }

    struct Peer {
        reader: BufReader<UnixStream>,
        hello: Value,
        requests: Vec<Value>,
    }
    impl Peer {
        fn pair(f: &Fixture, p: &Profile, runtime: &mut Runtime, binding: Option<&str>) -> Self {
            let mut request = f.bridge_request("connect");
            if let Some(binding) = binding {
                request["bindingId"] = json!(binding)
            }
            let challenge = runtime.ok("cursor.bridge", request);
            let challenge: Value =
                serde_json::from_str(challenge["challenge"].as_str().unwrap()).unwrap();
            let mut hello = p.hello(f);
            hello["ticket"] = challenge["ticket"].clone();
            let mut reader = Self::connect(&challenge, &hello);
            let hello = Self::read(&mut reader);
            assert_eq!(hello["protocol"], 1);
            assert!(hello["credential"].is_string());
            Self {
                reader,
                hello,
                requests: vec![],
            }
        }
        fn reconnect(f: &Fixture, p: &Profile, credential: &str) -> Self {
            let endpoint: Value = serde_json::from_slice(
                &fs::read(f.root.path().join("data/cursor-bridge/endpoint-v1.json")).unwrap(),
            )
            .unwrap();
            let mut hello = p.hello(f);
            hello["credential"] = json!(credential);
            let mut reader = Self::connect(&endpoint, &hello);
            let hello = Self::read(&mut reader);
            assert_eq!(hello["protocol"], 1);
            assert!(hello["credential"].is_null());
            Self {
                reader,
                hello,
                requests: vec![],
            }
        }
        fn connect(challenge: &Value, hello: &Value) -> BufReader<UnixStream> {
            let mut stream = UnixStream::connect(challenge["socket"].as_str().unwrap()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            writeln!(stream, "{hello}").unwrap();
            BufReader::new(stream)
        }
        fn read(reader: &mut BufReader<UnixStream>) -> Value {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0, "socket closed");
            serde_json::from_str(&line).unwrap()
        }
        fn next(&mut self, action: &str) -> Value {
            let request = Self::read(&mut self.reader);
            assert_eq!(request["action"], action, "{request}");
            assert_eq!(request["protocol"], 1);
            assert_eq!(request["boot_id"], self.hello["boot_id"]);
            assert_eq!(request["binding_id"], self.hello["binding_id"]);
            assert_eq!(request["lease"], self.hello["lease"]);
            assert!(uuid::Uuid::parse_str(request["request_id"].as_str().unwrap()).is_ok());
            self.requests.push(request.clone());
            request
        }
        fn reply(&mut self, request: &Value) {
            writeln!(
                self.reader.get_mut(),
                "{}",
                json!({"protocol":1,"boot_id":request["boot_id"],
                "lease":request["lease"],"request_id":request["request_id"],"result":{"ok":true}})
            )
            .unwrap();
        }
        fn open(&mut self, native: &str) {
            let request = self.next("open");
            assert_eq!(request["args"], json!({"native_id":native}));
            self.reply(&request);
        }
    }
    fn plan(f: &Fixture, runtime: &mut Runtime, peer: &Peer) -> Value {
        let binding = &peer.hello["binding_id"];
        let preview=runtime.ok("sessions.prepareHandoff",json!({"request":{
            "session_id":f.source_id,"target_agent":"cursor","target_surface":"cursor-ide","binding_id":binding,
            "format":"markdown","history_budget_tokens":64000}}));
        let draft = &preview["draft"];
        assert_eq!(draft["mode"], "native-session", "{preview}");
        let plan=runtime.ok("sessions.planHandoff",json!({"sessionId":f.source_id,"workspaceId":f.workspace_id,
            "filename":"cursor-fixture.md","format":"markdown","targetAgent":"cursor","targetSurface":"cursor-ide",
            "bindingId":binding,"mode":draft["mode"],"sourceFingerprint":draft["source_fingerprint"],
            "targetFingerprint":draft["target_fingerprint"],"acceptLosses":true,"historyBudgetTokens":64000,"archiveId":draft["archive_id"]}));
        assert_eq!(plan["change_set"]["changes"].as_array().unwrap().len(), 1);
        plan
    }
    fn continuation(plan: &Value) -> Value {
        json!({"changeSet":plan["change_set"],"launchRequest":plan["launch_request"],"approveHome":true})
    }
    fn responsive(runtime: &mut Runtime) {
        let start = Instant::now();
        let id = runtime.send("runtime.info", json!({}));
        let response = runtime.receive(id, Duration::from_secs(1));
        assert!(response.get("error").is_none(), "{response}");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn public_import_exact_readback_idempotence_and_cursor_as_source() {
        let f = Fixture::new();
        let original = fs::read(&f.source).unwrap();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut peer = Peer::pair(&f, &p, &mut runtime, None);
        let plan = plan(&f, &mut runtime, &peer);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        let request = peer.next("import");
        assert_eq!(request["workspace"], json!(f.workspace));
        let payload = request["args"]["payload"].as_str().unwrap();
        assert_eq!(
            request["args"]["payload_hash"],
            agentkib_core::hash_content(payload.as_bytes())
        );
        let native = uuid::Uuid::new_v4().to_string();
        p.store(&f, &request, &native, true);
        peer.reply(&request);
        peer.open(&native);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(10))["result"]["status"],
            "launched"
        );
        assert_eq!(
            runtime.ok("sessions.continueHandoff", continuation(&plan))["status"],
            "launched"
        );
        assert_eq!(
            peer.requests
                .iter()
                .filter(|r| r["action"] == "import")
                .count(),
            1
        );
        assert_eq!(peer.requests.len(), 2);
        assert_eq!(p.count(), 1);
        // Two selectable windows on one physical profile must remain one source.
        let second_peer = Peer::pair(&f, &p, &mut runtime, None);
        assert_ne!(second_peer.hello["binding_id"], peer.hello["binding_id"]);
        // A stale extension hint might remember only one credential. Runtime must
        // still require explicit window selection based on its own two bindings.
        let endpoint: Value = serde_json::from_slice(
            &fs::read(f.root.path().join("data/cursor-bridge/endpoint-v1.json")).unwrap(),
        )
        .unwrap();
        let mut hello = p.hello(&f);
        hello["credential"] = peer.hello["credential"].clone();
        let mut rejected = Peer::connect(&endpoint, &hello);
        let mut line = String::new();
        assert_eq!(rejected.read_line(&mut line).unwrap(), 0);
        assert!(line.is_empty());
        let status = runtime.ok("cursor.bridge", f.bridge_request("status"));
        assert_eq!(status["bindings"].as_array().unwrap().len(), 2);
        let binding = peer.hello["binding_id"].as_str().unwrap();
        let mut recovered = Peer::pair(&f, &p, &mut runtime, Some(binding));
        assert_eq!(recovered.hello["binding_id"], peer.hello["binding_id"]);
        let reopen = runtime.send("sessions.launchHandoff", plan["launch_request"].clone());
        recovered.open(&native);
        let response = runtime.receive(reopen, Duration::from_secs(5));
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(recovered.requests.len(), 1);
        assert_eq!(p.count(), 1);
        let indexed = runtime.ok(
            "workspace.refreshSessions",
            json!({"workspaceId":f.workspace_id,"force":true}),
        );
        let cursor = indexed
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["agent"] == "cursor")
            .collect::<Vec<_>>();
        assert_eq!(cursor.len(), 1, "{indexed}");
        let session = &cursor[0]["id"];
        let listed = runtime.ok("workspace.sessions", json!({"workspaceId":f.workspace_id}));
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["id"] == *session)
        );
        let events = runtime.ok("session.events", json!({"sessionId":session,"limit":100}));
        let observed = events["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["kind"].clone(), e["content"].clone()))
            .collect::<Vec<_>>();
        assert_eq!(
            observed,
            vec![
                (
                    json!("user-message"),
                    json!(agentkib_conversations::import_notice())
                ),
                (
                    json!("user-message"),
                    json!("Marker kiwi-8492. Decision: use SQLite.")
                ),
                (json!("agent-message"), json!("Agreed: SQLite.")),
            ]
        );
        assert_eq!(events["warnings"], json!([]));
        assert!(events["next_cursor"].is_null());
        let capability = runtime.ok("sessions.sourceCapability", json!({"sessionId":session}));
        assert_eq!(capability["source_surface"], "cursor-ide", "{capability}");
        for target in ["claude-code", "codex", "opencode", "hermes", "open-claw"] {
            let preview = runtime.ok(
                "sessions.prepareHandoff",
                json!({"request":{"session_id":session,
                "target_agent":target,"format":"markdown","history_budget_tokens":64000}}),
            );
            let serialized = preview.to_string();
            assert!(
                serialized.contains("Marker kiwi-8492. Decision: use SQLite."),
                "{preview}"
            );
            assert!(serialized.contains("Agreed: SQLite."), "{preview}");
        }
        assert_eq!(fs::read(&f.source).unwrap(), original);
        runtime.stop();
    }

    #[test]
    fn disconnect_revokes_old_credential_then_ticket_recovers_original_operation() {
        let f = Fixture::new();
        let original = fs::read(&f.source).unwrap();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut peer = Peer::pair(&f, &p, &mut runtime, None);
        let binding = peer.hello["binding_id"].as_str().unwrap().to_owned();
        let credential = peer.hello["credential"].clone();
        let plan = plan(&f, &mut runtime, &peer);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        let request = peer.next("import");
        let native = uuid::Uuid::new_v4().to_string();
        p.store(&f, &request, &native, true);
        peer.reply(&request);
        peer.open(&native);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(10))["result"]["status"],
            "launched"
        );
        let indexed = runtime.ok(
            "workspace.refreshSessions",
            json!({"workspaceId":f.workspace_id,"force":true}),
        );
        let session = indexed
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["agent"] == "cursor")
            .unwrap()["id"]
            .clone();
        let before = runtime.ok("session.events", json!({"sessionId":session,"limit":100}));
        assert_eq!(before["events"].as_array().unwrap().len(), 3);
        let result = runtime.ok(
            "cursor.bridge",
            json!({
                "action":"disconnect","workspaceId":f.workspace_id,"bindingId":binding,
            }),
        );
        assert_eq!(result["disconnected"], true);
        let mut line = String::new();
        assert_eq!(peer.reader.read_line(&mut line).unwrap(), 0);
        let status = runtime.ok("cursor.bridge", f.bridge_request("status"));
        assert_eq!(status["bindings"].as_array().unwrap().len(), 1);
        assert_eq!(status["bindings"][0]["id"], binding);
        assert_eq!(status["bindings"][0]["connected"], false);
        let endpoint: Value = serde_json::from_slice(
            &fs::read(f.root.path().join("data/cursor-bridge/endpoint-v1.json")).unwrap(),
        )
        .unwrap();
        let mut hello = p.hello(&f);
        hello["credential"] = credential;
        let mut revoked = Peer::connect(&endpoint, &hello);
        assert_eq!(revoked.read_line(&mut line).unwrap(), 0);
        assert!(line.is_empty());
        assert_eq!(
            runtime.ok("sessions.sourceCapability", json!({"sessionId":session}))["status"],
            "unavailable"
        );
        assert!(
            runtime
                .rpc("session.events", json!({"sessionId":session,"limit":100}))
                .get("error")
                .is_some()
        );
        let mut recovered = Peer::pair(&f, &p, &mut runtime, Some(&binding));
        assert_eq!(recovered.hello["binding_id"], binding);
        assert_ne!(recovered.hello["credential"], peer.hello["credential"]);
        let id = runtime.send("sessions.launchHandoff", plan["launch_request"].clone());
        recovered.open(&native);
        let response = runtime.receive(id, Duration::from_secs(5));
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(recovered.requests.len(), 1);
        assert_eq!(p.count(), 1);
        assert_eq!(
            runtime.ok("session.events", json!({"sessionId":session,"limit":100})),
            before
        );
        assert_eq!(fs::read(&f.source).unwrap(), original);
        runtime.stop();
    }

    #[test]
    fn late_blobs_wait_for_authoritative_readback_without_blocking_runtime() {
        let f = Fixture::new();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut peer = Peer::pair(&f, &p, &mut runtime, None);
        let plan = plan(&f, &mut runtime, &peer);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        let request = peer.next("import");
        let native = uuid::Uuid::new_v4().to_string();
        p.store(&f, &request, &native, false);
        peer.reply(&request);
        responsive(&mut runtime);
        assert!(
            !runtime.pending.contains_key(&id),
            "import claimed success before blobs were persisted"
        );
        peer.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let mut premature = String::new();
        let error = peer.reader.read_line(&mut premature).unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        assert!(
            premature.is_empty(),
            "open sent before authoritative blobs existed"
        );
        peer.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        p.store(&f, &request, &native, true);
        peer.open(&native);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(10))["result"]["status"],
            "launched"
        );
        assert_eq!(p.count(), 1);
        runtime.stop();
    }

    #[test]
    fn lost_import_response_reconciles_after_restart_without_redispatch() {
        let f = Fixture::new();
        let original = fs::read(&f.source).unwrap();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut peer = Peer::pair(&f, &p, &mut runtime, None);
        let binding = peer.hello["binding_id"].as_str().unwrap().to_owned();
        let credential = peer.hello["credential"].as_str().unwrap().to_owned();
        let plan = plan(&f, &mut runtime, &peer);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        let request = peer.next("import");
        let native = uuid::Uuid::new_v4().to_string();
        p.store(&f, &request, &native, true);
        peer.reader
            .get_mut()
            .shutdown(std::net::Shutdown::Both)
            .unwrap();
        assert_eq!(
            runtime.receive(id, Duration::from_secs(10))["result"]["status"],
            "import-outcome-unknown"
        );
        runtime.stop();
        drop(runtime);
        drop(peer);
        let mut runtime = f.runtime();
        let mut peer = Peer::reconnect(&f, &p, &credential);
        assert_eq!(peer.hello["binding_id"], binding);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        // The first and only new extension command must be open, never import.
        peer.open(&native);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(10))["result"]["status"],
            "launched"
        );
        assert_eq!(peer.requests.len(), 1);
        assert_eq!(p.count(), 1);
        assert_eq!(fs::read(&f.source).unwrap(), original);
        runtime.stop();
    }

    #[test]
    fn slow_import_is_responsive_and_eof_cancels_socket() {
        let f = Fixture::new();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut peer = Peer::pair(&f, &p, &mut runtime, None);
        let plan = plan(&f, &mut runtime, &peer);
        runtime.send("sessions.continueHandoff", continuation(&plan));
        peer.next("import");
        responsive(&mut runtime);
        runtime.stop();
        let mut line = String::new();
        assert_eq!(peer.reader.read_line(&mut line).unwrap(), 0);
        assert_eq!(p.count(), 0);
    }

    #[test]
    fn replacing_window_cancels_old_call_without_removing_new_lease() {
        let f = Fixture::new();
        let p = Profile::new(&f);
        let mut runtime = f.runtime();
        let mut old = Peer::pair(&f, &p, &mut runtime, None);
        let binding = old.hello["binding_id"].as_str().unwrap().to_owned();
        let plan = plan(&f, &mut runtime, &old);
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        let request = old.next("import");
        let native = uuid::Uuid::new_v4().to_string();
        p.store(&f, &request, &native, true);
        let mut replacement = Peer::reconnect(&f, &p, old.hello["credential"].as_str().unwrap());
        assert_eq!(replacement.hello["binding_id"], binding);
        assert_ne!(old.hello["lease"], replacement.hello["lease"]);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(5))["result"]["status"],
            "import-outcome-unknown"
        );
        let id = runtime.send("sessions.continueHandoff", continuation(&plan));
        replacement.open(&native);
        assert_eq!(
            runtime.receive(id, Duration::from_secs(5))["result"]["status"],
            "launched"
        );
        assert_eq!(replacement.requests.len(), 1);
        assert_eq!(p.count(), 1);
        runtime.stop();
    }

    #[test]
    fn hello_rejects_unknown_version_workspace_auth_and_host_mode() {
        for variant in ["version", "workspace", "auth", "protocol", "extension-mode"] {
            let f = Fixture::new();
            let p = Profile::new(&f);
            let mut runtime = f.runtime();
            let result = runtime.ok("cursor.bridge", f.bridge_request("connect"));
            let challenge: Value =
                serde_json::from_str(result["challenge"].as_str().unwrap()).unwrap();
            let mut hello = p.hello(&f);
            hello["ticket"] = challenge["ticket"].clone();
            match variant {
                "version" => fs::write(
                    p.app.join("package.json"),
                    r#"{"name":"Cursor","version":"99.0.0"}"#,
                )
                .unwrap(),
                "workspace" => {
                    let other = f.root.path().join("other");
                    fs::create_dir(&other).unwrap();
                    hello["workspace"] = json!(other)
                }
                "auth" => {
                    hello.as_object_mut().unwrap().remove("ticket");
                    hello["credential"] = json!("invalid-fixture-credential")
                }
                "protocol" => hello["protocol"] = json!(2),
                "extension-mode" => hello["extension_mode"] = json!(2),
                _ => unreachable!(),
            }
            let mut reader = Peer::connect(&challenge, &hello);
            let mut line = String::new();
            let result = reader.read_line(&mut line);
            assert!(
                matches!(result, Ok(0))
                    || result.as_ref().is_err_and(|error| {
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                        )
                    }),
                "rejected hello received {line}"
            );
            assert!(line.is_empty());
            assert_eq!(p.count(), 0);
            assert_eq!(
                runtime.ok("cursor.bridge", f.bridge_request("status"))["bindings"],
                json!([])
            );
            runtime.stop();
        }
    }
}
