use super::*;
use std::time::{Duration, Instant};

pub(crate) fn fixture() -> (tempfile::TempDir, Service, String) {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir(root.join("home")).unwrap();
    fs::create_dir(root.join("project")).unwrap();
    let workspace = Store::open(&root.join("agentkib.db"))
        .unwrap()
        .add_workspace(&root.join("project"))
        .unwrap();
    let mock = root.join("mock.py");
    fs::write(&mock, r#"import sys,json,pathlib
root=pathlib.Path(__file__).parent
with (root/'starts').open('a') as f: f.write(json.dumps(sys.argv[1:])+'\n')
sid=next(a.split('=',1)[1] for a in sys.argv if a.startswith('--session-id=') or a.startswith('--resume='))
def emit(value):
 value['session_id']=sid
 print(json.dumps(value),flush=True)
for line in sys.stdin:
 value=json.loads(line)
 if value.get('type')=='control_request':
  emit({'type':'control_response','response':{'subtype':'success','request_id':value['request_id']}})
 elif value.get('type')=='user':
  with (root/'users').open('a') as f: f.write(json.dumps(value)+'\n')
  if value['message']['content']!='wait':
   emit({'type':'assistant','message':{'content':[{'type':'text','text':'reply'}]}})
   emit({'type':'result','subtype':'success','is_error':False,'result':'reply'})
"#).unwrap();
    let executable = root.join("claude");
    fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '%s\\n' '2.1.285 (Claude Code)'; exit 0; fi\nexec /usr/bin/python3 '{}' \"$@\"\n",mock.display())).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let service = Service {
        streams: None,
        root: Some(root),
        executable: Some(executable),
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    (temp, service, workspace.id)
}
fn request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn create(service: &mut Service, workspace: &str) -> Value {
    service.request(json!({"operation":"create","workspaceId":workspace,"deviceId":"agentkib-local-owner","requestId":request_id()}),"boot",true).unwrap()
}
fn live(service: &mut Service, id: &str) -> Value {
    service
        .request(
            json!({"operation":"live","sessionId":id,"experimentalEnabled":true}),
            "boot",
            false,
        )
        .unwrap()
}
fn wait(service: &mut Service, id: &str, status: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = live(service, id);
        if state["status"] == status {
            return state;
        }
        assert!(Instant::now() < deadline, "{state}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn send(id: &str, request: &str, text: &str, revision: u64) -> Value {
    json!({"operation":"send","sessionId":id,"requestId":request,"deviceId":"agentkib-local-owner","runtimeBootId":"boot","expectedRevision":revision,"experimentalEnabled":true,"text":text})
}

#[test]
fn creation_is_passive_and_replays_across_boot_without_allocating_another_uuid() {
    let (temp, mut service, workspace) = fixture();
    let mut req = json!({"operation":"create","workspaceId":workspace,"requestId":request_id(),"runtimeBootId":"old"});
    let created = service.request(req.clone(), "boot", true).unwrap();
    assert!(!temp.path().join("starts").exists());
    assert_eq!(service.catalog().unwrap().len(), 1);
    assert_eq!(
        service.catalog().unwrap()[0]["indexedSessionId"],
        service
            .store()
            .unwrap()
            .conversation_id(
                AgentKind::ClaudeCode,
                created["sourceSessionId"].as_str().unwrap()
            )
            .unwrap()
    );
    assert!(uuid::Uuid::parse_str(created["sourceSessionId"].as_str().unwrap()).is_ok());
    req["runtimeBootId"] = json!("new");
    assert_eq!(service.request(req.clone(), "new", true).unwrap(), created);
    req["name"] = json!("different");
    assert!(
        service.request(req, "new", true).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("different-input")
    );
    let events = service
        .request(
            json!({"operation":"events","sessionId":created["sessionId"]}),
            "boot",
            false,
        )
        .unwrap();
    assert_eq!(events["events"], json!([]));
}
#[test]
fn fresh_send_has_session_id_and_durable_one_shot_receipt() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let request = request_id();
    let input = send(id, &request, "hello", 0);
    let ack = service.request(input.clone(), "boot", false).unwrap();
    assert_eq!(ack["accepted"], true, "{ack}");
    wait(&mut service, id, "idle");
    assert_eq!(service.request(input.clone(), "boot", false).unwrap(), ack);
    assert_eq!(
        fs::read_to_string(temp.path().join("users"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let args = fs::read_to_string(temp.path().join("starts")).unwrap();
    assert!(args.contains("--session-id="));
    assert!(!args.contains("--resume="));
    assert!(!args.contains("--permission-mode"));
    let receipt = service
        .ledger()
        .unwrap()
        .receipt(&request, "agentkib-local-owner")
        .unwrap();
    assert_eq!(
        service.receipt(receipt, "boot").unwrap()["completionObserved"],
        true
    );
    let root = service.root.clone();
    let executable = service.executable.clone();
    drop(service);
    let mut recovered = Service {
        streams: None,
        root,
        executable,
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    assert_eq!(recovered.request(input, "next-boot", false).unwrap(), ack);
    assert_eq!(
        fs::read_to_string(temp.path().join("users"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn interrupted_turn_stays_unknown_and_reconcile_never_resends() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let input = send(id, &request_id(), "wait", 0);
    assert_eq!(
        service.request(input, "boot", false).unwrap()["accepted"],
        true
    );
    let until = Instant::now() + Duration::from_secs(5);
    while !temp.path().join("users").exists() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    let root = service.root.clone();
    let executable = service.executable.clone();
    drop(service);
    let mut service = Service {
        streams: None,
        root,
        executable,
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    let state = live(&mut service, id);
    assert_eq!(state["status"], "outcome-unknown");
    assert_eq!(state["sendEnabled"], false);
    assert_eq!(state["approvals"], json!([]));
    let req = json!({"operation":"reconcile","sessionId":id,"requestId":request_id(),"deviceId":"device"});
    let outcome = service.request(req.clone(), "boot", true).unwrap();
    assert_eq!(outcome["reconciled"], false);
    assert_eq!(service.request(req, "boot", true).unwrap(), outcome);
    assert!(
        service
            .request(
                send(
                    id,
                    &request_id(),
                    "again",
                    state["revision"].as_u64().unwrap()
                ),
                "boot",
                false
            )
            .unwrap()["controlOutcome"]
            == "not-dispatched"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("users"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn metadata_lock_prevents_competing_runtime_from_overwriting_dispatch_state() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let mut other = Service {
        streams: None,
        root: service.root.clone(),
        executable: service.executable.clone(),
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    assert!(
        other
            .request(send(id, &request_id(), "hi", 0), "boot", false)
            .unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("another Runtime")
    );
    assert_eq!(
        service.load(id).unwrap().unwrap().snapshot["status"],
        "idle"
    );
}
#[test]
fn dispatched_ledger_fence_overrides_an_idle_disk_snapshot_after_restart() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let request = request_id();
    let ledger = service.ledger().unwrap();
    ledger
        .claim(&request, id, "hash", None, &json!({"operation":"send"}))
        .unwrap();
    ledger.dispatch(&request).unwrap();
    let state = live(&mut service, id);
    assert_eq!(state["status"], "outcome-unknown");
    assert_eq!(state["sendEnabled"], false);
}
#[test]
fn release_requires_current_revision_and_idle_then_persists() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let req = json!({"operation":"release","sessionId":id,"requestId":request_id(),"runtimeBootId":"boot","expectedRevision":1});
    assert_eq!(
        service.request(req, "boot", true).unwrap()["controlOutcome"],
        "not-dispatched"
    );
    let req = json!({"operation":"release","sessionId":id,"requestId":request_id(),"runtimeBootId":"boot","expectedRevision":0});
    let ack = service.request(req.clone(), "boot", true).unwrap();
    assert_eq!(ack["accepted"], true);
    assert!(!service.owns(id).unwrap());
    assert_eq!(service.request(req, "boot", true).unwrap(), ack);
}
#[test]
fn owner_process_detection_requires_exact_session_argument() {
    let id = request_id();
    assert!(process_mentions_session(
        &format!("22 /opt/bin/claude --resume={id}"),
        &id
    ));
    assert!(process_mentions_session(
        &format!("22 claude --resume {id}"),
        &id
    ));
    assert!(!process_mentions_session(
        &format!("22 claude --resume {id}a"),
        &id
    ));
    assert!(!process_mentions_session(
        &format!("22 other --resume {id}"),
        &id
    ));
}
#[test]
fn metadata_refuses_symlink_and_unknown_version() {
    use std::os::unix::fs::symlink;
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let path = service.path(id).unwrap();
    let original = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, &original).unwrap();
    symlink(&outside, &path).unwrap();
    assert!(service.load(id).is_err());
    assert_eq!(fs::read(&outside).unwrap(), original);
    fs::remove_file(&path).unwrap();
    let mut record: Value = serde_json::from_slice(&original).unwrap();
    record["version"] = json!(2);
    fs::write(&path, record.to_string()).unwrap();
    assert!(service.load(id).is_err());
    assert!(service.path("../../escape").is_err());
}

#[test]
fn lost_create_receipt_after_file_save_is_unknown_and_cannot_create_again() {
    let (_temp, mut service, workspace) = fixture();
    service.fail_after_record_save = true;
    let request = request_id();
    let input = json!({"operation":"create","workspaceId":workspace,"requestId":request,"deviceId":"device"});
    assert_eq!(
        service.request(input.clone(), "boot", true).unwrap()["controlOutcome"],
        "unknown"
    );
    assert_eq!(service.catalog().unwrap().len(), 1);
    let receipt = service
        .ledger()
        .unwrap()
        .receipt(&request, "device")
        .unwrap();
    assert_eq!(receipt["status"], "unknown");
    assert_eq!(receipt["operation"], "create");
    assert_eq!(receipt["workspaceId"], workspace);
    assert_eq!(receipt["executionMode"], "claude-managed");
    assert_eq!(
        service
            .ledger()
            .unwrap()
            .receipt(&request, "another-device")
            .unwrap()["found"],
        false
    );
    service.fail_after_record_save = false;
    assert_eq!(
        service.request(input, "new-boot", true).unwrap()["controlOutcome"],
        "unknown"
    );
    assert_eq!(service.catalog().unwrap().len(), 1);
}
#[test]
fn lost_release_receipt_cannot_claim_release_was_not_dispatched() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    service.fail_after_record_save = true;
    let request = request_id();
    let input = json!({"operation":"release","sessionId":id,"requestId":request,"deviceId":"device","runtimeBootId":"boot","expectedRevision":0});
    assert_eq!(
        service.request(input.clone(), "boot", true).unwrap()["controlOutcome"],
        "unknown"
    );
    assert!(service.load(id).unwrap().unwrap().released);
    assert_eq!(
        service
            .ledger()
            .unwrap()
            .receipt(&request, "device")
            .unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        service.request(input, "next-boot", true).unwrap()["controlOutcome"],
        "unknown"
    );
}

#[test]
fn released_empty_session_can_be_adopted_without_creating_a_second_native_session() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    service.request(json!({"operation":"release","sessionId":id,"requestId":request_id(),"runtimeBootId":"boot","expectedRevision":0}),"boot",true).unwrap();
    let inspected = service
        .request(json!({"operation":"inspect","sessionId":id}), "boot", true)
        .unwrap();
    let request = json!({"operation":"adopt","sessionId":id,"requestId":request_id(),"handoffConfirmed":true,"handoffFingerprint":inspected["handoffFingerprint"]});
    let adopted = service.request(request, "boot", true).unwrap();
    assert_eq!(adopted["sourceSessionId"], created["sourceSessionId"]);
    assert!(service.load(id).unwrap().unwrap().fresh);
    assert!(!temp.path().join("starts").exists());
}

#[test]
fn rejected_preflight_has_a_durable_correlated_receipt_and_conflicts_keep_it() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let request = request_id();
    let input = send(id, &request, "hello", 42);
    let rejected = service.request(input.clone(), "boot", false).unwrap();
    assert_eq!(rejected["controlOutcome"], "not-dispatched");
    let receipt = service
        .ledger()
        .unwrap()
        .receipt(&request, "agentkib-local-owner")
        .unwrap();
    assert_eq!(receipt["found"], true);
    assert_eq!(receipt["status"], "not-dispatched");
    assert_eq!(receipt["workspaceId"], workspace);
    let mut changed = input.clone();
    changed["text"] = json!("different");
    assert_eq!(
        service.request(changed, "boot", false).unwrap()["controlOutcome"],
        "unknown"
    );
    assert_eq!(
        service.request(input, "next-boot", false).unwrap(),
        rejected
    );
}

#[test]
fn cancellation_resets_native_connection_and_next_send_initializes_again() {
    let (temp, service, _workspace) = fixture();
    let mut runner = Runner::new_session(temp.path().join("project"), request_id());
    runner.set_test_executable(service.executable.clone().unwrap());
    let first = request_id();
    runner.send_content(json!("wait"), &first, 0).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !temp.path().join("users").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    runner
        .stop(&first, runner.snapshot()["revision"].as_u64().unwrap())
        .unwrap();
    assert_eq!(runner.snapshot()["lastOutcome"], "cancelled");
    assert_eq!(runner.snapshot()["status"], "idle");
    let second = request_id();
    runner
        .send_content(
            json!("hello"),
            &second,
            runner.snapshot()["revision"].as_u64().unwrap(),
        )
        .unwrap();
    assert!(runner.snapshot()["lastOutcome"].is_null());
    let deadline = Instant::now() + Duration::from_secs(5);
    while runner.snapshot()["status"] != "idle" {
        assert!(Instant::now() < deadline, "{}", runner.snapshot());
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::read_to_string(temp.path().join("users"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    let starts = fs::read_to_string(temp.path().join("starts")).unwrap();
    assert_eq!(starts.lines().count(), 2);
    assert!(starts.lines().nth(1).unwrap().contains("--resume="));
    runner.shutdown().unwrap();
}

#[test]
fn correlated_native_result_recovers_lost_send_receipt_without_another_send() {
    let (temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    service.fail_after_record_save = true;
    let request = request_id();
    let input = send(id, &request, "hello", 0);
    let unknown = service.request(input.clone(), "boot", false).unwrap();
    assert_eq!(unknown["controlOutcome"], "unknown");
    service.fail_after_record_save = false;
    wait(&mut service, id, "idle");
    let receipt = service
        .ledger()
        .unwrap()
        .receipt(&request, "agentkib-local-owner")
        .unwrap();
    let receipt = service.receipt(receipt, "boot").unwrap();
    assert_eq!(receipt["status"], "accepted");
    assert_eq!(receipt["completionObserved"], true);
    assert_eq!(receipt["ack"]["completed"], true);
    assert_eq!(
        service.request(input, "next-boot", false).unwrap()["accepted"],
        true
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("users"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn failed_cleanup_blocks_release_and_persists_unknown_after_service_exit() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap().to_owned();
    service
        .runners
        .insert(id.clone(), Runner::mock_cleanup_failure("idle"));
    let snapshot = live(&mut service, &id);
    let request = request_id();
    let ack=service.request(json!({"operation":"release","sessionId":id,"requestId":request,"deviceId":"agentkib-local-owner","runtimeBootId":"boot","expectedRevision":snapshot["revision"]}),"boot",true).unwrap();
    assert_eq!(ack["controlOutcome"], "unknown");
    assert!(!service.load(&id).unwrap().unwrap().released);
    assert_eq!(live(&mut service, &id)["status"], "outcome-unknown");
    let root = service.root.clone();
    let executable = service.executable.clone();
    drop(service);
    let mut restored = Service {
        streams: None,
        root,
        executable,
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    assert_eq!(live(&mut restored, &id)["status"], "outcome-unknown");
    assert!(!restored.load(&id).unwrap().unwrap().released);
}

#[test]
fn failed_cancel_receipt_is_not_upgraded_to_observed_completion() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap().to_owned();
    service
        .runners
        .insert(id.clone(), Runner::mock_cleanup_failure("running"));
    let snapshot = live(&mut service, &id);
    let request = request_id();
    let ack=service.request(json!({"operation":"stop","sessionId":id,"requestId":request,"deviceId":"agentkib-local-owner","runtimeBootId":"boot","expectedRevision":snapshot["revision"],"turnId":"cleanup-turn","experimentalEnabled":true}),"boot",false).unwrap();
    assert_eq!(ack["controlOutcome"], "unknown");
    let receipt = service
        .ledger()
        .unwrap()
        .receipt(&request, "agentkib-local-owner")
        .unwrap();
    let receipt = service.receipt(receipt, "boot").unwrap();
    assert_eq!(receipt["status"], "unknown");
    assert_eq!(receipt["completionObserved"], false);
    assert_eq!(live(&mut service, &id)["status"], "outcome-unknown");
}

#[test]
fn capacity_retirement_persists_failed_cleanup_without_waiting_for_drop() {
    let (_temp, mut service, workspace) = fixture();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap().to_owned();
    service
        .runners
        .insert(id.clone(), Runner::mock_cleanup_failure("idle"));
    service.reserve("another-session").unwrap();
    assert_eq!(
        service.load(&id).unwrap().unwrap().snapshot["status"],
        "outcome-unknown"
    );
    let mut restarted = Service {
        streams: None,
        root: service.root.clone(),
        executable: service.executable.clone(),
        runners: BTreeMap::new(),
        owners: BTreeMap::new(),
        installation: None,
        fail_after_record_save: false,
    };
    assert_eq!(live(&mut restarted, &id)["status"], "outcome-unknown");
}

#[test]
fn implicit_cleanup_fences_disk_before_capacity_retirement_or_drop() {
    for dropping in [false, true] {
        let (_temp, mut service, workspace) = fixture();
        let created = create(&mut service, &workspace);
        let id = created["sessionId"].as_str().unwrap().to_owned();
        let root = service.root.clone();
        let executable = service.executable.clone();
        let (started, observed) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        service
            .runners
            .insert(id.clone(), Runner::mock_cleanup_gate(started, released));
        let worker = std::thread::spawn(move || {
            if dropping {
                drop(service)
            } else {
                service.reserve("other").unwrap();
            }
        });
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut restarted = Service {
            streams: None,
            root,
            executable,
            runners: BTreeMap::new(),
            owners: BTreeMap::new(),
            installation: None,
            fail_after_record_save: false,
        };
        let snapshot = live(&mut restarted, &id);
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot["status"], "outcome-unknown");
        assert_eq!(snapshot["sendEnabled"], false);
    }
}

#[test]
fn owner_changes_reset_stream_epoch_and_receipt_replay_does_not_restart_observation() {
    let (directory, mut service, workspace) = fixture();
    let (sent, events) = std::sync::mpsc::channel();
    let hub = crate::session_stream::Hub::new("boot".into(), move |event| sent.send(event).is_ok());
    service.set_streams(hub.clone());
    let catalog = hub.subscribe("", None).unwrap();
    let created = create(&mut service, &workspace);
    let id = created["sessionId"].as_str().unwrap();
    let changed = events.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(changed["subscriptionId"], catalog["subscriptionId"]);
    assert_eq!(changed["type"], "invalidate");
    let before = hub.subscribe(id, None).unwrap();
    let release = json!({"operation":"release","sessionId":id,"requestId":request_id(),"runtimeBootId":"boot","expectedRevision":0});
    let released = service.request(release.clone(), "boot", true).unwrap();
    assert_eq!(released["accepted"], true);
    let after = hub.subscribe(id, before["cursor"].as_str()).unwrap();
    assert_eq!(after["events"][0]["type"], "snapshot");
    assert_ne!(after["events"][0]["epoch"], before["events"][0]["epoch"]);
    assert_eq!(after["events"][0]["payload"]["live"]["status"], "released");
    assert_eq!(after["events"][0]["payload"]["live"]["sendEnabled"], false);
    assert_eq!(service.request(release, "boot", true).unwrap(), released);
    assert_eq!(hub.subscribe(id, None).unwrap()["cursor"], after["cursor"]);
    let inspected = service
        .request(json!({"operation":"inspect","sessionId":id}), "boot", true)
        .unwrap();
    let adopted = service.request(json!({"operation":"adopt","sessionId":id,"requestId":request_id(),"handoffConfirmed":true,"handoffFingerprint":inspected["handoffFingerprint"]}), "boot", true).unwrap();
    assert_eq!(adopted["accepted"], true);
    let resumed = hub.subscribe(id, after["cursor"].as_str()).unwrap();
    assert_eq!(resumed["events"][0]["type"], "snapshot");
    assert_ne!(resumed["events"][0]["epoch"], after["events"][0]["epoch"]);
    assert_eq!(resumed["events"][0]["payload"]["live"]["status"], "idle");
    assert!(!directory.path().join("starts").exists());
}

#[test]
fn durable_owner_changes_replace_stream_baselines_even_when_receipt_save_fails() {
    for operation in ["create", "release", "adopt"] {
        let (directory, mut service, workspace) = fixture();
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        service.set_streams(hub.clone());
        let request = request_id();
        let (input, before) = if operation == "create" {
            (
                json!({"operation":"create","workspaceId":workspace,"requestId":request,"deviceId":"agentkib-local-owner"}),
                None,
            )
        } else {
            let created = create(&mut service, &workspace);
            let id = created["sessionId"].as_str().unwrap();
            let input = if operation == "release" {
                json!({"operation":"release","sessionId":id,"requestId":request,"deviceId":"agentkib-local-owner","runtimeBootId":"boot","expectedRevision":0})
            } else {
                let released = service.request(json!({"operation":"release","sessionId":id,"requestId":request_id(),"runtimeBootId":"boot","expectedRevision":0}), "boot", true).unwrap();
                assert_eq!(released["accepted"], true);
                let inspected = service
                    .request(json!({"operation":"inspect","sessionId":id}), "boot", true)
                    .unwrap();
                json!({"operation":"adopt","sessionId":id,"requestId":request,"deviceId":"agentkib-local-owner","handoffConfirmed":true,"handoffFingerprint":inspected["handoffFingerprint"]})
            };
            (input, Some(hub.subscribe(id, None).unwrap()))
        };
        service.fail_after_record_save = true;
        let uncertain = service.request(input.clone(), "boot", true).unwrap();
        assert_eq!(
            uncertain["controlOutcome"], "unknown",
            "{operation}: {uncertain}"
        );
        let receipt = service
            .ledger()
            .unwrap()
            .receipt(&request, "agentkib-local-owner")
            .unwrap();
        assert_eq!(receipt["status"], "unknown");
        assert_eq!(receipt["completionObserved"], false);
        let id = receipt["sessionId"].as_str().unwrap();
        assert_eq!(
            service.load(id).unwrap().unwrap().released,
            operation == "release"
        );
        let after = hub
            .subscribe(id, before.as_ref().and_then(|v| v["cursor"].as_str()))
            .unwrap();
        let baseline = &after["events"][0];
        assert_eq!(baseline["type"], "snapshot");
        if let Some(before) = before {
            assert_ne!(baseline["epoch"], before["events"][0]["epoch"]);
        }
        assert_eq!(
            baseline["payload"]["live"]["status"],
            if operation == "release" {
                "released"
            } else {
                "outcome-unknown"
            }
        );
        assert_eq!(baseline["payload"]["live"]["sendEnabled"], false);
        assert_eq!(service.request(input, "boot", true).unwrap(), uncertain);
        assert_eq!(hub.subscribe(id, None).unwrap()["cursor"], after["cursor"]);
        assert!(!directory.path().join("starts").exists());
    }
}
