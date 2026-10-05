use super::*;

fn fixture() -> (Service, crate::session_stream::Hub) {
    let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
    let mut service = Service {
        streams: Some(hub.clone()),
        ..Service::default()
    };
    service.managed.set_streams(hub.clone());
    (service, hub)
}

fn baseline(hub: &crate::session_stream::Hub, id: &str) -> Value {
    let result = hub.subscribe(id, None).unwrap();
    hub.unsubscribe(result["subscriptionId"].as_str().unwrap());
    result
}

#[test]
fn subscriptions_refresh_static_availability_without_creating_a_runner() {
    let (mut service, hub) = fixture();
    let unsupported =
        json!({"status":"unsupported","reason":"unverified-installation","sendEnabled":false});
    let idle =
        json!({"executionMode":"managed-resume","status":"idle","revision":0,"sendEnabled":true});
    let mut cursor = None;
    for live in [&unsupported, &idle, &unsupported, &idle] {
        // The installation gate and the no-runner Claude live branch both
        // return static reads. Neither creates an observer that could repair
        // a cached subscription after installation or availability changes.
        let result = service
            .finish_subscription("claude-history", None, live.clone())
            .unwrap();
        let current = &result["events"][0]["payload"]["live"];
        assert_eq!(current["status"], live["status"]);
        assert_eq!(current["sendEnabled"], live["sendEnabled"]);
        assert_eq!(current["reason"], live["reason"]);
        assert_ne!(cursor.as_ref(), Some(&result["cursor"]));
        hub.unsubscribe(result["subscriptionId"].as_str().unwrap());
        let unchanged = service
            .finish_subscription("claude-history", result["cursor"].as_str(), live.clone())
            .unwrap();
        assert_eq!(unchanged["cursor"], result["cursor"]);
        assert!(unchanged["events"].as_array().unwrap().is_empty());
        hub.unsubscribe(unchanged["subscriptionId"].as_str().unwrap());
        cursor = Some(result["cursor"].clone());
    }
    assert!(service.claude.is_empty());
    assert!(service.antigravity.is_empty());
}

#[test]
fn subscriptions_recheck_runner_state_and_preserve_validated_guards() {
    let (mut service, hub) = fixture();
    let detached = json!({"executionMode":"managed-resume","status":"running","revision":99,"sendEnabled":false});
    hub.publisher("session", "managed-resume")
        .observe(detached.clone());
    let runner = crate::claude_runner::Runner::mock_worker("idle");
    runner.set_publisher(hub.publisher("session", "managed-resume"));
    service.claude.insert("session".into(), runner);
    let current = baseline(&hub, "session");
    for _ in 0..2 {
        let subscribed = service
            .finish_subscription("session", None, detached.clone())
            .unwrap();
        assert_eq!(subscribed["cursor"], current["cursor"]);
        let live = &subscribed["events"][0]["payload"]["live"];
        assert_eq!(live["status"], "idle");
        assert_eq!(live["revision"], 0);
        assert_eq!(live["sendEnabled"], true);
        hub.unsubscribe(subscribed["subscriptionId"].as_str().unwrap());
    }
    let guarded = service
        .finish_subscription(
            "session",
            None,
            json!({"status":"outcome-unknown","reason":"control-outcome-unconfirmed","sendEnabled":false}),
        )
        .unwrap();
    let live = &guarded["events"][0]["payload"]["live"];
    assert_eq!(live["status"], "outcome-unknown");
    assert_eq!(live["sendEnabled"], false);
    assert_eq!(service.claude.len(), 1);
}

#[test]
fn subscriptions_republish_uncached_native_runners_under_the_state_lock() {
    let (mut service, hub) = fixture();
    let session = "000-retired-projection";
    let runner = crate::claude_runner::Runner::mock_worker("idle");
    runner.set_publisher(hub.publisher(session, "managed-resume"));
    service.claude.insert(session.into(), runner);
    // The Hub evicts unsubscribed idle sources independently of the runner
    // cache. A detached read must not become authoritative after that eviction.
    for index in 0..128 {
        hub.publisher(&format!("other-{index}"), "")
            .observe(json!({"status":"idle"}));
    }
    assert!(!hub.contains(session));
    let subscribed = service
        .finish_subscription(
            session,
            None,
            json!({"executionMode":"managed-resume","status":"running","revision":99,"sendEnabled":false}),
        )
        .unwrap();
    let live = &subscribed["events"][0]["payload"]["live"];
    assert_eq!(live["status"], "idle");
    assert_eq!(live["revision"], 0);
    assert_eq!(live["sendEnabled"], true);
}

#[test]
fn subscriptions_seed_missing_follower_projection_without_overwriting_native_updates() {
    let (mut service, hub) = fixture();
    let initial = json!({"executionMode":"codex-follower","status":"running","revision":1});
    let first = service
        .finish_subscription("follower", None, initial.clone())
        .unwrap();
    assert_eq!(first["events"][0]["payload"]["live"]["revision"], 1);
    hub.unsubscribe(first["subscriptionId"].as_str().unwrap());
    hub.publisher("follower", "codex-follower")
        .observe(json!({"status":"idle","revision":2,"sendEnabled":true}));
    let latest = baseline(&hub, "follower");
    let subscribed = service
        .finish_subscription("follower", None, initial)
        .unwrap();
    assert_eq!(subscribed["cursor"], latest["cursor"]);
    let live = &subscribed["events"][0]["payload"]["live"];
    assert_eq!(live["status"], "idle");
    assert_eq!(live["revision"], 2);
}

#[test]
fn control_publication_uses_current_claude_runner_after_revision_reset() {
    let (mut service, hub) = fixture();
    let previous = json!({"executionMode":"managed-resume","status":"running","revision":10,"sendEnabled":false});
    hub.publisher("session", "managed-resume")
        .observe(previous.clone());
    // An idle replacement can legitimately start below the retired runner's
    // revision. It must not be rejected by a global revision-monotonic filter.
    let runner = crate::claude_runner::Runner::mock_worker("idle");
    runner.set_publisher(hub.publisher("session", "managed-resume"));
    service.claude.insert("session".into(), runner);
    let current = baseline(&hub, "session");
    assert_eq!(current["events"][0]["payload"]["live"]["revision"], 0);
    service
        .publish_control_snapshot("session", previous)
        .unwrap();
    let after = baseline(&hub, "session");
    assert_eq!(after["cursor"], current["cursor"]);
    assert_eq!(after["events"][0]["payload"]["live"]["status"], "idle");
    assert_eq!(after["events"][0]["payload"]["live"]["sendEnabled"], true);
}

#[test]
fn control_publication_keeps_validated_guards_and_static_sessions() {
    let (mut service, hub) = fixture();
    let runner = crate::claude_runner::Runner::mock_worker("idle");
    runner.set_publisher(hub.publisher("session", "managed-resume"));
    service.claude.insert("session".into(), runner);
    for status in ["unsupported", "outcome-unknown"] {
        let guarded = json!({"status":status,"revision":null,"sendEnabled":false,"reason":"control-outcome-unconfirmed"});
        service
            .publish_control_snapshot("session", guarded)
            .unwrap();
        let current = baseline(&hub, "session");
        assert_eq!(current["events"][0]["payload"]["live"]["status"], status);
        assert_eq!(
            current["events"][0]["payload"]["live"]["sendEnabled"],
            false
        );
    }
    for (id, mode) in [
        ("unstarted-claude", "managed-resume"),
        ("retired-acp", "acp-managed"),
        ("released-managed", "codex-managed"),
    ] {
        service
            .publish_control_snapshot(
                id,
                json!({"executionMode":mode,"status":"idle","revision":0,"sendEnabled":false}),
            )
            .unwrap();
        assert_eq!(
            baseline(&hub, id)["events"][0]["payload"]["live"]["executionMode"],
            mode
        );
    }
    assert_eq!(service.claude.len(), 1);
    assert!(service.antigravity.is_empty());
    let before = baseline(&hub, "session");
    service
        .publish_control_snapshot(
            "session",
            json!({"executionMode":"codex-follower","status":"running","revision":99}),
        )
        .unwrap();
    assert_eq!(baseline(&hub, "session")["cursor"], before["cursor"]);
}

#[cfg(unix)]
#[test]
fn control_publication_does_not_restore_acp_running_after_native_completion() {
    let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","messageId":"answer","content":{"type":"text","text":"done"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
while read -r line; do :; done
"#;
    let runner = crate::antigravity_runner::Runner::connect_for_test(
        Path::new("/bin/sh"),
        &["-c".into(), script.into()],
        std::env::temp_dir().canonicalize().unwrap(),
        "native".into(),
    )
    .unwrap();
    let (mut service, hub) = fixture();
    runner.set_publisher(hub.publisher("session", "acp-managed"));
    let detached = runner.send("hello", 0).unwrap();
    assert_eq!(detached["status"], "running");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while runner.snapshot()["status"] != "idle" {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    service.antigravity.insert("session".into(), runner);
    let completed = baseline(&hub, "session");
    service
        .publish_control_snapshot("session", detached)
        .unwrap();
    let after = baseline(&hub, "session");
    assert_eq!(after["events"][0]["payload"]["live"]["status"], "idle");
    assert_eq!(after["events"][0]["payload"]["live"]["sendEnabled"], true);
    // Re-publication must not repeat transcript items or history invalidations.
    assert_eq!(after["cursor"], completed["cursor"]);
    assert_eq!(
        after["events"][0]["payload"]["items"],
        completed["events"][0]["payload"]["items"]
    );
}
