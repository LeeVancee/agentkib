#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
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
    workspace_id: String,
    session_id: String,
    transcript: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let workspace = root.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        let store = Store::open(&root.path().join("data/agentkib.db")).unwrap();
        let workspace_id = store.add_workspace(&workspace).unwrap().id;
        let native_id = uuid::Uuid::new_v4().to_string();
        let transcript = root
            .path()
            .join("claude/projects/synthetic")
            .join(format!("{native_id}.jsonl"));
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let timestamp = "2026-09-27T00:00:00Z";
        let user_id = uuid::Uuid::new_v4().to_string();
        let user = json!({"type":"user", "uuid":user_id, "parentUuid":null,
            "sessionId":native_id, "cwd":workspace, "timestamp":timestamp,
            "message":{"role":"user","content":"Marker kiwi-8492. Decision: use SQLite."}});
        let assistant = json!({"type":"assistant","uuid":uuid::Uuid::new_v4(),"parentUuid":user_id,
            "sessionId":native_id,"cwd":workspace,"timestamp":timestamp,
            "message":{"role":"assistant","content":[{"type":"text","text":"Agreed: SQLite."}]}});
        fs::write(&transcript, format!("{user}\n{assistant}\n")).unwrap();
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
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("version"), "1.18.32").unwrap();
        fs::write(
            bin.join("opencode"),
            r#"#!/bin/sh
base=$(dirname "$0")
case "$1" in
  --version) cat "$base/version" ;;
  debug) printf '{"model":"synthetic/fixture"}\n' ;;
  import)
    printf 'import\n' >> "$base/imports"
    touch "$base/started"
    while [ ! -f "$base/release" ]; do sleep 0.01; done
    exit 1 ;;
  export) printf '{}\n' ;;
  *) exit 2 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(bin.join("opencode"), fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            workspace_id,
            session_id: sessions[0].id.clone(),
            transcript,
        }
    }

    fn runtime(&self) -> Runtime {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agentkib-runtime"))
            .env("AGENTKIB_BENCHMARK_DATA_DIR", self.root.path().join("data"))
            .env("CLAUDE_CONFIG_DIR", self.root.path().join("claude"))
            .env("HOME", self.root.path().join("home"))
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.root.path().join("bin").display()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(value) = serde_json::from_str(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        Runtime {
            child,
            stdin: Some(stdin),
            responses,
        }
    }

    fn plan(&self, runtime: &mut Runtime) -> Value {
        runtime.send(1,"sessions.prepareHandoff",json!({"request":{
            "session_id":self.session_id,"target_agent":"opencode","format":"markdown","history_budget_tokens":64000
        }}));
        let response = runtime.receive(1);
        assert!(response.get("error").is_none(), "{response}");
        let draft = &response["result"]["draft"];
        runtime.send(2,"sessions.planHandoff",json!({
            "sessionId":self.session_id,"workspaceId":self.workspace_id,
            "filename":draft["filename"],"format":"markdown","targetAgent":"opencode",
            "mode":"native-session","sourceFingerprint":draft["source_fingerprint"],
            "targetFingerprint":draft["target_fingerprint"],"acceptLosses":true,"historyBudgetTokens":64000
        }));
        let response = runtime.receive(2);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    fn wait_import(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.root.path().join("bin/started").exists() {
            assert!(Instant::now() < deadline, "import did not start");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

struct Runtime {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<Value>,
}
impl Runtime {
    fn send(&mut self, id: u64, method: &str, params: Value) {
        writeln!(
            self.stdin.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
    }
    fn receive(&self, id: u64) -> Value {
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(10))
            .expect("Runtime response");
        assert_eq!(response["id"], id, "{response}");
        response
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn continuation(plan: &Value, approve: bool) -> Value {
    json!({"changeSet":plan["change_set"],"launchRequest":plan["launch_request"],"approveHome":approve})
}

#[test]
fn slow_partial_import_is_nonblocking_and_never_repeated_after_restart() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let plan = fixture.plan(&mut runtime);
    runtime.send(3, "sessions.continueHandoff", continuation(&plan, false));
    assert!(runtime.receive(3).get("error").is_some());
    assert!(!fixture.root.path().join("bin/started").exists());
    runtime.send(4, "sessions.continueHandoff", continuation(&plan, true));
    fixture.wait_import();
    let started = Instant::now();
    runtime.send(5, "workspaces.list", json!({}));
    let response = runtime.receive(5);
    assert!(response.get("error").is_none(), "{response}");
    assert!(started.elapsed() < Duration::from_secs(1));
    fs::write(fixture.root.path().join("bin/release"), "").unwrap();
    assert_eq!(
        runtime.receive(4)["result"]["status"],
        "import-outcome-unknown"
    );
    runtime.send(6, "sessions.continueHandoff", continuation(&plan, true));
    assert_eq!(
        runtime.receive(6)["result"]["status"],
        "import-outcome-unknown"
    );
    drop(runtime);
    let mut runtime = fixture.runtime();
    runtime.send(7, "sessions.continueHandoff", continuation(&plan, true));
    assert_eq!(
        runtime.receive(7)["result"]["status"],
        "import-outcome-unknown"
    );
    runtime.send(
        8,
        "sessions.nativeImports",
        json!({"workspaceId":fixture.workspace_id}),
    );
    let list = runtime.receive(8);
    assert_eq!(list["result"].as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list["result"][0]["status"], "outcome-unknown");
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("bin/imports")).unwrap(),
        "import\n"
    );
}

#[test]
fn changed_source_prevents_the_first_external_mutation() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let plan = fixture.plan(&mut runtime);
    let old = fs::read_to_string(&fixture.transcript).unwrap();
    fs::write(
        &fixture.transcript,
        old.replace("kiwi-8492", "changed-marker"),
    )
    .unwrap();
    runtime.send(3, "sessions.continueHandoff", continuation(&plan, true));
    let response = runtime.receive(3);
    assert_eq!(
        response["result"]["status"], "import-outcome-unknown",
        "{response}"
    );
    assert!(!fixture.root.path().join("bin/started").exists());
}

#[test]
fn target_version_drift_preserves_the_review_and_does_not_import() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let plan = fixture.plan(&mut runtime);
    fs::write(fixture.root.path().join("bin/version"), "1.18.33").unwrap();
    runtime.send(3, "sessions.continueHandoff", continuation(&plan, true));
    let response = runtime.receive(3);
    assert_eq!(
        response["result"]["status"], "import-outcome-unknown",
        "{response}"
    );
    assert!(!fixture.root.path().join("bin/started").exists());
    runtime.send(
        4,
        "sessions.nativeImports",
        json!({"workspaceId":fixture.workspace_id}),
    );
    let response = runtime.receive(4);
    assert_eq!(response["result"][0]["status"], "prepared", "{response}");
    assert_eq!(
        response["result"][0]["source_session_id"],
        fixture.session_id
    );
}

#[test]
fn shutdown_cancels_import_and_flushes_each_accepted_request_once() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let plan = fixture.plan(&mut runtime);
    runtime.send(3, "sessions.continueHandoff", continuation(&plan, true));
    fixture.wait_import();
    runtime.send(
        4,
        "sessions.nativeImports",
        json!({"workspaceId":fixture.workspace_id}),
    );
    runtime.stdin.take();
    let first = runtime
        .responses
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let second = runtime
        .responses
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let mut ids = vec![
        first["id"].as_u64().unwrap(),
        second["id"].as_u64().unwrap(),
    ];
    ids.sort();
    assert_eq!(ids, vec![3, 4]);
    assert!(
        runtime
            .responses
            .recv_timeout(Duration::from_secs(5))
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("bin/imports")).unwrap(),
        "import\n"
    );
}
