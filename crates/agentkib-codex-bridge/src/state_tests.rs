use anyhow::Result;
use serde_json::{Value, json};

use crate::state::{SessionState, Status};

const CONVERSATION: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_CONVERSATION: &str = "00000000-0000-4000-8000-000000000002";
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER: &str = "22222222-2222-4222-8222-222222222222";

#[test]
fn refresh_accepts_only_exact_same_revision_snapshot() {
    let mut state = session();
    let snapshot = conversation_snapshot("idle", json!([]), json!([]));
    apply_snapshot(&mut state, 7, snapshot.clone()).unwrap();
    apply_snapshot(&mut state, 7, snapshot.clone()).unwrap();
    assert_eq!(state.revision(), Some(7));
    assert_eq!(state.snapshot_count, 2);
    // A refresh must not clear a mutation's unconfirmed outcome.
    state.status = Status::OutcomeUnknown;
    apply_snapshot(&mut state, 7, snapshot.clone()).unwrap();
    assert_eq!(state.status(), Status::OutcomeUnknown);
    let mut changed = snapshot;
    changed["threadRuntimeStatus"]["type"] = json!("active");
    assert!(apply_snapshot(&mut state, 7, changed).is_err());
    assert_eq!(state.status(), Status::Unsupported);
    assert!(state.snapshot().is_none());
}

#[test]
fn same_revision_patch_is_not_a_refresh_confirmation() {
    let mut state = session();
    apply_snapshot(
        &mut state,
        7,
        conversation_snapshot("idle", json!([]), json!([])),
    )
    .unwrap();
    assert!(
        state
            .notification(patches_message(OWNER, 7, 7, json!([])))
            .is_err()
    );
    assert!(state.revision().is_none());
}

fn session() -> SessionState {
    SessionState::new(CONVERSATION.to_owned(), OWNER.to_owned())
}

fn conversation_snapshot(runtime_type: &str, turns: Value, requests: Value) -> Value {
    json!({
        "id": CONVERSATION,
        "hostId": "local",
        "turns": turns,
        "requests": requests,
        "threadRuntimeStatus": {"type": runtime_type},
    })
}

fn stream_message(
    source: &str,
    conversation: &str,
    host: &str,
    version: u64,
    change: Value,
) -> Value {
    json!({
        "type": "broadcast",
        "method": "thread-stream-state-changed",
        "version": version,
        "sourceClientId": source,
        "params": {
            "conversationId": conversation,
            "hostId": host,
            "change": change,
        },
    })
}

fn snapshot_message(source: &str, revision: u64, snapshot: Value) -> Value {
    stream_message(
        source,
        CONVERSATION,
        "local",
        11,
        json!({
            "type": "snapshot",
            "revision": revision,
            "conversationState": snapshot,
        }),
    )
}

fn patches_message(source: &str, base_revision: u64, revision: u64, patches: Value) -> Value {
    stream_message(
        source,
        CONVERSATION,
        "local",
        11,
        json!({
            "type": "patches",
            "baseRevision": base_revision,
            "revision": revision,
            "patches": patches,
        }),
    )
}

fn apply_snapshot(state: &mut SessionState, revision: u64, snapshot: Value) -> Result<()> {
    state.notification(snapshot_message(OWNER, revision, snapshot))
}

fn idle_snapshot() -> Value {
    conversation_snapshot("idle", json!([]), json!([]))
}

#[test]
fn snapshot_then_immer_patches_update_state_and_revision() {
    let mut state = session();
    let mut snapshot = idle_snapshot();
    snapshot["title"] = json!("before");
    snapshot["tags"] = json!(["first"]);

    apply_snapshot(&mut state, 1, snapshot).expect("valid snapshot");
    assert_eq!(state.status(), Status::Idle);
    assert_eq!(state.revision(), Some(1));

    let patches = json!([
        {"op": "replace", "path": ["title"], "value": "after"},
        {"op": "add", "path": ["tags", 1], "value": "second"},
    ]);
    state
        .notification(patches_message(OWNER, 1, 2, patches))
        .expect("valid Immer patches");

    assert_eq!(state.revision(), Some(2));
    assert_eq!(state.status(), Status::Idle);
    assert_eq!(
        state.snapshot().and_then(|s| s["title"].as_str()),
        Some("after")
    );
    assert_eq!(
        state.snapshot().and_then(|s| s["tags"][1].as_str()),
        Some("second")
    );
}

#[test]
fn patch_base_revision_gap_invalidates_state() {
    let mut state = session();
    apply_snapshot(&mut state, 1, idle_snapshot()).expect("valid snapshot");

    let error = state
        .notification(patches_message(OWNER, 0, 2, json!([])))
        .expect_err("a patch with the wrong base revision must be rejected");

    assert!(error.to_string().contains("stream revision gap"));
    assert_eq!(state.status(), Status::Unsupported);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}

#[test]
fn stale_snapshot_is_rejected_without_retaining_stale_state() {
    let mut state = session();
    apply_snapshot(&mut state, 2, idle_snapshot()).expect("valid snapshot");

    let error = apply_snapshot(&mut state, 1, idle_snapshot())
        .expect_err("an older snapshot must not roll back the stream");

    assert!(error.to_string().contains("stale stream revision"));
    assert_eq!(state.status(), Status::Unsupported);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}

#[test]
fn unknown_state_method_version_is_rejected() {
    let mut state = session();
    let message = stream_message(
        OWNER,
        CONVERSATION,
        "local",
        10,
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": idle_snapshot(),
        }),
    );

    let error = state
        .notification(message)
        .expect_err("an unknown stream protocol version must be rejected");

    assert!(error.to_string().contains("incompatible state version"));
    assert_eq!(state.status(), Status::Unsupported);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}

#[test]
fn foreign_owner_host_and_conversation_cannot_mutate_selected_session() {
    let mut state = session();

    let foreign_owner = stream_message(
        OTHER_OWNER,
        CONVERSATION,
        "local",
        11,
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": idle_snapshot(),
        }),
    );
    state
        .notification(foreign_owner)
        .expect("foreign owner is ignored");

    let foreign_host = stream_message(
        OWNER,
        CONVERSATION,
        "remote",
        11,
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": idle_snapshot(),
        }),
    );
    state
        .notification(foreign_host)
        .expect("foreign host is ignored");

    let foreign_conversation = stream_message(
        OWNER,
        OTHER_CONVERSATION,
        "local",
        11,
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": idle_snapshot(),
        }),
    );
    state
        .notification(foreign_conversation)
        .expect("foreign conversation is ignored");

    assert_eq!(state.status(), Status::WaitingForSnapshot);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}

#[test]
fn invalid_patch_path_invalidates_accumulated_state() {
    let mut state = session();
    apply_snapshot(&mut state, 1, idle_snapshot()).expect("valid snapshot");

    let error = state
        .notification(patches_message(
            OWNER,
            1,
            2,
            json!([{"op": "replace", "path": ["missing", "child"], "value": true}]),
        ))
        .expect_err("a path through a missing object must be rejected");

    assert!(error.to_string().contains("patch path missing"));
    assert_eq!(state.status(), Status::Unsupported);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}

#[test]
fn status_tracks_idle_running_and_approval_states() {
    let mut state = session();

    apply_snapshot(&mut state, 1, idle_snapshot()).expect("idle snapshot");
    assert_eq!(state.status(), Status::Idle);

    apply_snapshot(
        &mut state,
        2,
        conversation_snapshot("active", json!([]), json!([])),
    )
    .expect("active snapshot");
    // Runtime activity alone does not identify a safe turn control target.
    assert_eq!(state.status(), Status::OutcomeUnknown);

    let in_progress_turn = json!([{"turnId": "turn-1", "status": "inProgress"}]);
    apply_snapshot(
        &mut state,
        3,
        conversation_snapshot("idle", in_progress_turn, json!([])),
    )
    .expect("in-progress turn snapshot");
    assert_eq!(state.status(), Status::Running);

    let requests = json!([{
        "id": "request-1",
        "method": "item/commandExecution/requestApproval",
        "params": {"threadId": CONVERSATION, "turnId": "turn-1"}
    }]);
    apply_snapshot(
        &mut state,
        4,
        conversation_snapshot(
            "idle",
            json!([{"turnId": "turn-1", "status": "inProgress"}]),
            requests,
        ),
    )
    .expect("approval snapshot");
    assert_eq!(state.status(), Status::AwaitingApproval);
}

#[test]
fn outcome_unknown_overrides_other_statuses() {
    let mut state = session();
    let mut snapshot = conversation_snapshot("active", json!([]), json!([]));
    snapshot["unconfirmedTurnSubmissions"] = json!([{"requestId": "request-1"}]);

    apply_snapshot(&mut state, 1, snapshot).expect("valid outcome-unknown snapshot");
    assert_eq!(state.status(), Status::OutcomeUnknown);
}

#[test]
fn approvals_are_filtered_to_active_turn_thread_and_supported_methods() {
    let mut state = session();
    let active_turn = "turn-active";
    let completed_turn = "turn-completed";
    let requests = json!([
        {
            "id": "command-request",
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": CONVERSATION, "turnId": active_turn, "availableDecisions": ["accept"]}
        },
        {
            "id": 42,
            "method": "item/fileChange/requestApproval",
            "params": {"threadId": CONVERSATION, "turnId": active_turn}
        },
        {
            "id": "wrong-thread",
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": OTHER_CONVERSATION, "turnId": active_turn}
        },
        {
            "id": "wrong-turn",
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": CONVERSATION, "turnId": completed_turn}
        },
        {
            "id": "unsupported-method",
            "method": "item/permissions/requestApproval",
            "params": {"threadId": CONVERSATION, "turnId": active_turn}
        },
        {
            "id": true,
            "method": "item/fileChange/requestApproval",
            "params": {"threadId": CONVERSATION, "turnId": active_turn}
        }
    ]);
    let turns = json!([
        {"turnId": completed_turn, "status": "completed"},
        {"turnId": active_turn, "status": "inProgress"}
    ]);
    apply_snapshot(
        &mut state,
        1,
        conversation_snapshot("active", turns, requests),
    )
    .expect("valid approval snapshot");

    let approvals = state.approvals();
    assert_eq!(approvals.len(), 2);
    assert_eq!(approvals[0].request_id, json!("command-request"));
    assert_eq!(approvals[0].turn_id, active_turn);
    assert_eq!(approvals[0].method, "item/commandExecution/requestApproval");
    assert_eq!(approvals[1].request_id, json!(42));
    assert_eq!(approvals[1].turn_id, active_turn);
    assert_eq!(approvals[1].method, "item/fileChange/requestApproval");
}

fn canonical_snapshot() -> Value {
    let mut snapshot = idle_snapshot();
    snapshot["turnHistory"] = json!({"kind":"canonical","history":{
        "islands":[{"entries":[{"value":"turn-key"}]}],
        "entitiesByKey":{"turn-key":{"turnId":"canonical-turn","status":"inProgress","items":[]}}
    }});
    snapshot
}

#[test]
fn canonical_history_drives_active_turn_and_incremental_completion() {
    let mut state = session();
    apply_snapshot(&mut state, 1, canonical_snapshot()).unwrap();
    assert_eq!(state.status(), Status::Running);
    assert_eq!(state.active_turn(), Some("canonical-turn"));
    state.notification(patches_message(OWNER, 1, 2, json!([{
        "op":"replace","path":["turnHistory","history","entitiesByKey","turn-key","status"],"value":"interrupted"
    }]))).unwrap();
    assert_eq!(state.status(), Status::Idle);
    assert_eq!(state.active_turn(), None);
}

#[test]
fn conflicting_live_overlay_never_selects_a_turn_for_control() {
    for turn in [
        json!({"turnId":"canonical-turn","status":"completed"}),
        json!({"turnId":"other-turn","status":"inProgress"}),
    ] {
        let mut state = session();
        let mut snapshot = canonical_snapshot();
        snapshot["turns"] = json!([turn]);
        apply_snapshot(&mut state, 1, snapshot).unwrap();
        assert_eq!(state.status(), Status::OutcomeUnknown);
        assert_eq!(state.active_turn(), None);
        assert!(state.approvals().is_empty());
    }
}

#[test]
fn unresolved_history_placeholder_stays_unknown_until_owner_resolves_it() {
    for id in [Value::Null, json!("")] {
        let mut state = session();
        let mut snapshot = canonical_snapshot();
        snapshot["turnHistory"]["history"]["entitiesByKey"]["turn-key"]["turnId"] = id;
        apply_snapshot(&mut state, 1, snapshot).unwrap();
        assert_eq!(state.status(), Status::OutcomeUnknown);
        assert_eq!(state.active_turn(), None);
        assert!(state.approvals().is_empty());
        // Keep the stream usable: an authoritative replacement can recover.
        apply_snapshot(&mut state, 2, idle_snapshot()).unwrap();
        assert_eq!(state.status(), Status::Idle);
    }
}

#[test]
fn missing_canonical_entity_invalidates_snapshot() {
    let mut state = session();
    let mut snapshot = canonical_snapshot();
    snapshot["turnHistory"]["history"]["entitiesByKey"] = json!({});
    assert!(apply_snapshot(&mut state, 1, snapshot).is_err());
    assert_eq!(state.status(), Status::Unsupported);
    assert!(state.snapshot().is_none());
}

#[test]
fn malformed_schema_invalidates_state_and_drops_content() {
    let malformed_changes = [
        json!({"type": "snapshot", "revision": 1}),
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": {"id": CONVERSATION, "hostId": "local", "turns": [], "requests": {}}
        }),
        json!({
            "type": "snapshot",
            "revision": 1,
            "conversationState": {"id": OTHER_CONVERSATION, "hostId": "local", "turns": [], "requests": []}
        }),
        json!({"type": "snapshot", "revision": "1", "conversationState": idle_snapshot()}),
        json!({"type": "unknown", "revision": 1, "conversationState": idle_snapshot()}),
    ];

    for change in malformed_changes {
        let mut state = session();
        let message = stream_message(OWNER, CONVERSATION, "local", 11, change);
        assert!(state.notification(message).is_err());
        assert_eq!(state.status(), Status::Unsupported);
        assert_eq!(state.revision(), None);
        assert_eq!(state.snapshot(), None);
    }
}

#[test]
fn owner_disconnect_and_connection_reset_clear_selected_state() {
    let mut state = session();
    apply_snapshot(&mut state, 1, idle_snapshot()).expect("valid snapshot");

    state
        .notification(json!({
            "type": "broadcast",
            "method": "client-status-changed",
            "sourceClientId": OWNER,
            "version": 1,
            "params": {"clientId": OWNER, "status": "disconnected"}
        }))
        .expect("owner disconnect notification");
    assert_eq!(state.status(), Status::Disconnected);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);

    apply_snapshot(&mut state, 2, idle_snapshot()).expect("late snapshot is ignored");
    assert_eq!(state.status(), Status::Disconnected);
    let mut state = session();
    apply_snapshot(&mut state, 1, idle_snapshot()).expect("rediscovered owner snapshot");
    state
        .notification(json!({
            "type": "broadcast",
            "method": "ipc-connection-reset",
            "version": 1,
            "sourceClientId": OWNER,
            "params": {}
        }))
        .expect("owner connection reset notification");
    assert_eq!(state.status(), Status::Disconnected);
    assert_eq!(state.revision(), None);
    assert_eq!(state.snapshot(), None);
}
