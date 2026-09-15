//! Development-only interactive entry. No process launching, credentials, scanning or LAN.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use agentkib_codex_bridge::{Bridge, Compatibility, Connection, Decision};
    use anyhow::{Context, bail, ensure};
    use serde_json::{Value, json};
    use std::{
        io::{self, BufRead},
        path::PathBuf,
        sync::mpsc,
        time::Duration,
    };

    let mut socket = None;
    let mut desktop = None;
    let mut extension = None;
    let mut session = None;
    let mut controls = false;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--socket" => socket = Some(PathBuf::from(arguments.next().context("missing socket")?)),
            "--desktop-asar" => {
                desktop = Some(PathBuf::from(
                    arguments.next().context("missing desktop ASAR")?,
                ))
            }
            "--extension-package" => {
                extension = Some(PathBuf::from(
                    arguments.next().context("missing extension package")?,
                ))
            }
            "--session" => session = Some(arguments.next().context("missing conversation UUID")?),
            "--allow-control" => controls = true,
            "--help" => {
                println!(
                    "probe --socket /absolute/ipc.sock [--session UUID --desktop-asar PATH --extension-package PATH --allow-control]"
                );
                println!(
                    "Without --session: initialization only, then disconnect. With --session: status, sync, diagnostics, approvals, send TEXT, stop TURN_ID, approve JSON, quit."
                );
                println!(
                    "approve JSON: {{\"requestId\":42,\"turnId\":\"...\",\"decision\":\"accept|decline|cancel\"}}"
                );
                return Ok(());
            }
            _ => bail!("unknown argument; use --help"),
        }
    }
    let socket = socket.context("explicit --socket is required")?;
    let Some(session) = session else {
        ensure!(!controls, "--allow-control requires explicit --session");
        let connection = Connection::connect(&socket)?;
        println!(
            "{}",
            json!({"initialized":connection.is_connected(),"clientType":agentkib_codex_bridge::CLIENT_TYPE,"sessionRead":false})
        );
        return Ok(());
    };
    let compatibility = match (desktop, extension) {
        (Some(desktop), Some(extension)) => Compatibility::inspect(&desktop, &extension),
        _ => Compatibility::default(),
    };
    println!(
        "{}",
        json!({"knownInstalledVersions":compatibility.is_known(), "desktop":compatibility.desktop_version(),"extension":compatibility.extension_version()})
    );
    let mut bridge = Bridge::connect(&socket, compatibility)?;
    if controls {
        bridge.enable_controls()?;
    }
    bridge.select(&session)?;
    println!(
        "Selected explicit session. Control is opt-in. Requests are never automatically retried."
    );
    let (tx, rx) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        // Read bounded lines so accidental pastes do not allocate unbounded memory.
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            let mut too_long = false;
            loop {
                let available = match input.fill_buf() {
                    Ok(v) => v,
                    Err(_) => return,
                };
                if available.is_empty() {
                    return;
                }
                let n = available
                    .iter()
                    .position(|&b| b == b'\n')
                    .map(|p| p + 1)
                    .unwrap_or(available.len());
                let complete = available[n - 1] == b'\n';
                if bytes.len() + n <= 20 * 1024 {
                    bytes.extend_from_slice(&available[..n]);
                } else {
                    too_long = true;
                }
                input.consume(n);
                if complete {
                    break;
                }
            }
            let line = if too_long {
                "invalid oversized command".into()
            } else {
                String::from_utf8_lossy(&bytes).trim_end().to_owned()
            };
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    let mut last = None;
    loop {
        if let Some(state) = bridge.state() {
            let marker = (state.status(), state.revision());
            if last != Some(marker) {
                println!(
                    "{}",
                    json!({"status":state.status(),"revision":state.revision(),"activeTurnId":state.active_turn(),"pendingApprovals":state.approvals().len()})
                );
                last = Some(marker);
            }
        }
        match rx.try_recv() {
            Ok(line) => {
                if line == "quit" {
                    break;
                }
                let result = (|| -> anyhow::Result<()> {
                    if line == "status" {
                        last = None;
                    } else if line == "sync" {
                        bridge.refresh()?;
                    } else if line == "diagnostics" {
                        let snapshot = bridge
                            .state()
                            .and_then(|s| s.snapshot())
                            .context("no snapshot")?;
                        // Explicit metadata-only diagnostics: never print messages, tool inputs or credentials.
                        let summarize =
                            |turn: &Value| json!({"turnId":turn["turnId"],"status":turn["status"]});
                        let live: Vec<_> = snapshot["turns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(summarize)
                            .collect();
                        let active_history: Vec<_> =
                            snapshot["turnHistory"]["history"]["entitiesByKey"]
                                .as_object()
                                .into_iter()
                                .flat_map(|m| m.values())
                                .filter(|t| t["status"] == "inProgress")
                                .map(summarize)
                                .collect();
                        println!(
                            "{}",
                            json!({"runtimeStatus":snapshot["threadRuntimeStatus"]["type"],"liveTurns":live,"activeHistory":active_history,"unconfirmedCount":snapshot["unconfirmedTurnSubmissions"].as_array().map(Vec::len)})
                        );
                    } else if line == "approvals" {
                        let approvals = bridge.state().context("no session")?.approvals();
                        // Explicitly requested view only; never continuously log conversation content.
                        for approval in approvals {
                            println!(
                                "{}",
                                json!({"requestId":approval.request_id,"turnId":approval.turn_id,"method":approval.method,
                                "command":approval.details.get("command"),"reason":approval.details.get("reason"),"changes":approval.details.get("changes"),"itemId":approval.details.get("itemId"),
                                "availableDecisions":approval.details.get("availableDecisions"),
                                "networkApprovalContext":approval.details.get("networkApprovalContext"),
                                "additionalPermissions":approval.details.get("additionalPermissions"),
                                "grantRoot":approval.details.get("grantRoot")})
                            );
                        }
                        println!(
                            "Use only decisions offered by the owner and supported by this probe. If details are incomplete, permissions are unsupported, or available decisions are unclear, handle the request in the original client. Cancel interrupts the turn; it is not a substitute for decline."
                        );
                    } else if let Some(text) = line.strip_prefix("send ") {
                        bridge.send_text(text)?;
                        receipt();
                    } else if let Some(turn) = line.strip_prefix("stop ") {
                        bridge.stop(turn)?;
                        println!(
                            "Owner confirmed the selected turn interruption. Tool subprocess termination is NOT guaranteed. Use sync; idle is not proof that commands have exited."
                        );
                    } else if let Some(data) = line.strip_prefix("approve ") {
                        let value: Value = serde_json::from_str(data)?;
                        let turn = value["turnId"].as_str().context("missing turnId")?;
                        let decision = match value["decision"].as_str() {
                            Some("accept") => Decision::Accept,
                            Some("decline") => Decision::Decline,
                            Some("cancel") => Decision::Cancel,
                            _ => bail!("only single-use accept/decline/cancel are supported"),
                        };
                        bridge.approve(&value["requestId"], turn, decision)?;
                        receipt();
                    } else {
                        bail!("unknown command; use status/sync/approvals/send/stop/approve/quit");
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("{error}");
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => (),
        }
        if let Err(error) = bridge.poll(Duration::from_millis(100)) {
            eprintln!("{error}");
            break;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn receipt() {
    println!(
        "Owner acknowledged; execution/approval completion is not yet confirmed. Use sync before another operation."
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This experimental Codex IPC probe currently supports macOS only.");
}
