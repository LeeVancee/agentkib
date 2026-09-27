//! Version-pinned native operations. Native state is never mirrored into a queue.
use super::*;

const FEATURES: &[&str] = &[
    "send",
    "stop",
    "approve",
    "answer",
    "inspect",
    "resume",
    "steer",
    "queue-list",
    "queue-add",
    "queue-update",
    "queue-delete",
    "queue-reorder",
    "queue-start",
    "rename",
    "archive",
    "unarchive",
    "fork",
    "settings",
    "settings-state",
    "usage",
    "goal",
    "goal-set",
    "goal-pause",
    "goal-resume",
    "goal-clear",
    "resources",
    "attachments",
    "worktree-create",
    "branch-switch",
];

impl Service {
    pub(crate) fn capabilities(&mut self, id: &str, boot: &str, controls: bool) -> Result<Value> {
        let (_, _, native) = self.target(id)?;
        let record = self
            .existing_ledger()?
            .map(|l| l.get(id))
            .transpose()?
            .flatten();
        let managed = record.as_ref().is_some_and(|r| !r.released || !r.adopted);
        let live = if let Some(record) = record.as_ref().filter(|_| managed) {
            let ledger = self.ledger()?;
            self.snapshot(record, boot, controls, &ledger)?
        } else {
            json!({"status":"native-host-required","reason":"follower-capabilities-required"})
        };
        let healthy = live["reason"].is_null() && controls;
        let idle = live["status"] == "idle";
        let running = live["status"] == "running";
        let verified = self.executable().is_ok();
        let unknown = self.has_unconfirmed(id)?;
        let mut features = serde_json::Map::new();
        for op in FEATURES {
            let available = match *op {
                "inspect" => verified,
                "resume" => {
                    !unknown
                        && verified
                        && controls
                        && native.is_some()
                        && record.as_ref().is_none_or(|r| !r.archived)
                        && !self.runners.get(id).is_some_and(|r| r.client.connected())
                }
                "worktree-create" | "branch-switch" => false,
                "settings-state" | "usage" | "goal" | "resources" => managed && verified,
                "send" | "rename" | "settings" | "goal-clear" | "archive" | "fork" => {
                    managed && verified && healthy && idle
                }
                "goal-set" => {
                    managed
                        && verified
                        && healthy
                        && idle
                        && record.as_ref().is_some_and(|record| {
                            record.goal.is_some() || state::settings_applied(record)
                        })
                }
                "goal-pause" => {
                    managed
                        && verified
                        && healthy
                        && record.as_ref().is_some_and(|record| {
                            record
                                .goal
                                .as_ref()
                                .is_some_and(|goal| goal["status"] == "active")
                        })
                }
                "goal-resume" => {
                    managed
                        && verified
                        && healthy
                        && record.as_ref().is_some_and(|record| {
                            state::settings_applied(record)
                                && record.goal.as_ref().is_some_and(|goal| {
                                    matches!(
                                        goal["status"].as_str(),
                                        Some(
                                            "paused" | "blocked" | "budgetLimited" | "usageLimited"
                                        )
                                    )
                                })
                        })
                }
                "unarchive" => managed && verified && controls && live["status"] == "archived",
                "steer" => managed && verified && healthy && running,
                "stop" => live["stopEnabled"] == true,
                "queue-add" => managed && verified && healthy && running,
                "queue-start" => false,
                _ => managed && verified && healthy,
            };
            let feature = if available {
                json!({"available":true})
            } else {
                let reason = if !verified {
                    "unsupported-codex-cli-version"
                } else if matches!(*op, "worktree-create" | "branch-switch" | "queue-start") {
                    "native-operation-not-integrated"
                } else if !controls {
                    "control-disabled"
                } else if *op == "resume" {
                    if unknown {
                        "control-outcome-unconfirmed"
                    } else if native.is_none() {
                        "native-session-unconfirmed"
                    } else if record.as_ref().is_some_and(|r| r.archived) {
                        "session-archived"
                    } else {
                        "session-already-managed"
                    }
                } else if !managed {
                    "follower-operation-unverified"
                } else if *op == "unarchive" {
                    "session-not-archived"
                } else if healthy
                    && !unknown
                    && (*op == "goal-resume"
                        || (*op == "goal-set"
                            && record.as_ref().is_some_and(|record| record.goal.is_none())))
                    && record
                        .as_ref()
                        .is_some_and(|record| !state::settings_applied(record))
                {
                    "settings-not-applied"
                } else if matches!(*op, "goal-pause" | "goal-resume") && healthy {
                    "goal-state-changed"
                } else if let Some(reason) = live["reason"].as_str() {
                    reason
                } else if unknown {
                    "control-outcome-unconfirmed"
                } else if live["status"] == "archived" {
                    "session-archived"
                } else {
                    match *op {
                        "send" | "rename" | "settings" | "goal-set" | "goal-clear" | "archive"
                        | "fork" => "session-busy",
                        "steer" | "queue-add" => "session-requires-running-turn",
                        "stop" => "no-active-turn",
                        _ => "session-state-unavailable",
                    }
                };
                json!({"available":false,"reason":reason})
            };
            features.insert((*op).into(), feature);
        }
        Ok(
            json!({"sessionId":id,"executionMode":if managed{"codex-managed"}else{"codex-follower"},"status":live["status"],"reason":live["reason"],"features":features}),
        )
    }
    pub(crate) fn inspect(&mut self, id: &str, boot: &str) -> Result<Value> {
        let (workspace_id, workspace, native) = self.target(id)?;
        let native = native.context("native-session-unconfirmed")?;
        let client = Client::spawn(&self.executable()?, &workspace, &self.home()?, None, |_| {})?;
        let response = client.request(
            "thread/read",
            json!({"threadId":native,"includeTurns":true}),
        )?;
        ensure!(
            response["thread"]["id"] == native,
            "thread-identity-mismatch"
        );
        ensure!(
            self.store()?
                .workspace_path(&workspace_id)?
                .canonicalize()?
                == workspace,
            "session-workspace-mismatch"
        );
        let context = native_context(&response["thread"], &workspace)?;
        let ledger = self.ledger()?;
        let managed_record = ledger.get(id)?;
        let unknown = ledger.unknown(id)?;
        let queued = if unknown.iter().any(|(_, e)| e["operation"] == "queue-add") {
            queue(&client, &native).ok()
        } else {
            None
        };
        let mut unresolved = 0;
        for (request, evidence) in unknown {
            let resolved = matches!(evidence["operation"].as_str(), Some("approve" | "answer"))
                && evidence["runtimeBootId"] == boot
                && !evidence["nativeRequestId"].is_null()
                && self.runners.get(id).is_some_and(|runner| {
                    let state = runner.state.lock().unwrap();
                    state.record.native_id.as_deref() == Some(&native)
                        && state.resolved_requests.contains(&format!(
                            "{}:{}",
                            evidence["turnId"].as_str().unwrap_or_default(),
                            evidence["nativeRequestId"]
                        ))
                });
            if !matches!(
                evidence["operation"].as_str(),
                Some("create" | "adopt" | "resume")
            ) && (resolved
                || reconciles(&request, &evidence, &response["thread"])
                || managed_record
                    .as_ref()
                    .is_some_and(|record| settings_evidence_matches(&evidence, record))
                || (evidence["operation"] == "queue-add"
                    && queued.as_ref().is_some_and(|q| {
                        q["complete"] == true
                            && q["data"].as_array().is_some_and(|a| {
                                a.iter().any(|row| row["clientUserMessageId"] == request)
                            })
                    })))
            {
                ledger.finish(&request, &json!({"accepted":true,"completed":false,"reconciled":true,"requestId":request,"runtimeBootId":boot,"sessionId":id}))?;
            } else {
                unresolved += 1;
            }
        }
        if unresolved == 0
            && let Some(runner) = self.runners.get(id).filter(|r| r.client.connected())
        {
            let mut state = runner
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
            if state.record.native_id.as_deref() == Some(&native)
                && state.reason.as_deref() == Some("control-outcome-unconfirmed")
            {
                if !state.questions.is_empty() {
                    state.status = "waiting-input".into();
                    state.reason = None;
                } else if !state.approvals.is_empty() {
                    state.status = "awaiting-approval".into();
                    state.reason = None;
                } else if state.turn.is_some() {
                    state.status = "running".into();
                    state.reason = None;
                } else if response["thread"]["status"]["type"] == "idle" {
                    state.status = "idle".into();
                    state.reason = None;
                }
                state.revision += 1;
                state.save(&ledger)?;
            }
        }
        Ok(
            json!({"sessionId":id,"reconciled":unresolved==0,"reason":if unresolved==0{Value::Null}else{json!("control-outcome-unconfirmed")},"unresolvedCount":unresolved,"context":context,"nativeStatus":response["thread"]["status"],"executionUnchanged":true}),
        )
    }
}

pub(super) fn input(req: &Request) -> Result<Value> {
    input_with_resources(req, None, None)
}

pub(super) fn input_with_resources(
    req: &Request,
    record: Option<&Record>,
    client: Option<&Client>,
) -> Result<Value> {
    let mut rows = if let Some(value) = &req.input {
        ensure!(req.text.is_none(), "ambiguous-input");
        value.as_array().context("invalid-input")?.clone()
    } else {
        let text = req.text.as_deref().context("missing-text")?;
        agentkib_codex_bridge::validate_send_text(text)?;
        vec![json!({"type":"text","text":text})]
    };
    ensure!(!rows.is_empty() && rows.len() <= 11, "invalid-input-count");
    let references = req.resource_refs.as_deref().unwrap_or_default();
    ensure!(references.len() <= 32, "invalid-resource-reference-count");
    for reference in references {
        let mapped = match reference["kind"].as_str() {
            Some("skill") => json!({"type":"skill","id":reference["id"]}),
            Some(kind @ ("file" | "directory")) => {
                json!({"type":"computerPath","kind":kind,"workspaceRelativePath":reference["relativePath"]})
            }
            Some("plugin" | "app") => bail!("native-resource-unverified"),
            _ => bail!("invalid-resource-reference"),
        };
        rows.push(mapped);
    }
    // Preserve the two independent service limits plus the text row.
    ensure!(!rows.is_empty() && rows.len() <= 43, "invalid-input-count");
    let mut size = 0;
    let mut result = vec![];
    for row in &rows {
        match row["type"].as_str() {
            Some("text") => {
                let text = row["text"].as_str().context("invalid-text-input")?;
                agentkib_codex_bridge::validate_send_text(text)?;
                size += text.len();
                result.push(json!({"type":"text","text":text}));
            }
            Some("localImage") => {
                let path = Path::new(row["path"].as_str().context("invalid-image-path")?);
                ensure!(
                    path.is_absolute()
                        && !path
                            .components()
                            .any(|c| matches!(c, std::path::Component::ParentDir)),
                    "invalid-image-path"
                );
                let canonical = path.canonicalize().context("attachment-unavailable")?;
                ensure!(canonical.is_file(), "attachment-unavailable");
                ensure!(
                    canonical.metadata()?.len() <= 25 * 1024 * 1024,
                    "attachment-too-large"
                );
                result.push(json!({"type":"localImage","path":canonical}));
            }
            Some("computerPath") => {
                let record = record.context("resource-context-required")?;
                let relative = row["workspaceRelativePath"]
                    .as_str()
                    .filter(|path| !path.is_empty() && path.len() <= 4096)
                    .context("invalid-resource-path")?;
                let relative = Path::new(relative);
                ensure!(
                    !relative.is_absolute()
                        && !relative.components().any(|part| matches!(
                            part,
                            std::path::Component::ParentDir
                                | std::path::Component::RootDir
                                | std::path::Component::Prefix(_)
                        )),
                    "invalid-resource-path"
                );
                let path = record
                    .workspace
                    .join(relative)
                    .canonicalize()
                    .context("resource-unavailable")?;
                ensure!(
                    path.starts_with(&record.workspace),
                    "resource-outside-workspace"
                );
                let kind = row["kind"].as_str().context("invalid-resource-kind")?;
                ensure!(
                    (kind == "file" && path.is_file()) || (kind == "directory" && path.is_dir()),
                    "resource-kind-mismatch"
                );
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .context("invalid-resource-name")?;
                result.push(json!({"type":"mention","name":name,"path":path}));
            }
            Some("skill") => {
                let record = record.context("resource-context-required")?;
                let client = client.context("resource-context-required")?;
                let requested = row["id"].as_str().context("invalid-skill-id")?;
                let listed = client.request(
                    "skills/list",
                    json!({"cwds":[record.workspace],"forceReload":false}),
                )?;
                let skill = listed["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|entry| {
                        entry["cwd"]
                            .as_str()
                            .and_then(|cwd| Path::new(cwd).canonicalize().ok())
                            .as_ref()
                            == Some(&record.workspace)
                    })
                    .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
                    .find_map(|skill| {
                        let path = skill["path"]
                            .as_str()
                            .and_then(|path| Path::new(path).canonicalize().ok())?;
                        let id =
                            format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
                        (id == requested && skill["enabled"] == true).then_some((skill, path))
                    })
                    .context("skill-unavailable")?;
                let name = skill.0["name"]
                    .as_str()
                    .filter(|name| !name.is_empty() && name.len() <= 256)
                    .context("invalid-skill-name")?;
                result.push(json!({"type":"skill","name":name,"path":skill.1}));
            }
            _ => bail!("unsupported-input-type"),
        }
    }
    ensure!(size <= 128 * 1024, "input-too-large");
    Ok(json!(result))
}

fn queue_id(req: &Request) -> Result<&str> {
    req.queued_submission_id
        .as_deref()
        .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        .context("invalid-queued-submission")
}

pub(super) fn operation(
    req: &Request,
    record: &Record,
    state: &State,
    _models: Option<&[Value]>,
    client: &Client,
) -> Result<(&'static str, Value, Option<Value>)> {
    let native = record
        .native_id
        .as_ref()
        .context("native-session-unconfirmed")?;
    let mut params = json!({"threadId":native});
    let method = match req.operation.as_str() {
        "steer" => {
            ensure!(
                state.status == "running" && state.turn.is_some() && req.turn_id == state.turn,
                "stale-turn"
            );
            params["expectedTurnId"] = json!(state.turn);
            params["clientUserMessageId"] = json!(valid_request_id(req)?);
            params["input"] = input_with_resources(req, Some(record), Some(client))?;
            "turn/steer"
        }
        "queue-add" => {
            ensure!(
                matches!(
                    state.status.as_str(),
                    "running" | "waiting-input" | "awaiting-approval"
                ),
                "queue-requires-running-turn"
            );
            params["clientUserMessageId"] = json!(valid_request_id(req)?);
            params["input"] = input_with_resources(req, Some(record), Some(client))?;
            "thread/queue/add"
        }
        "queue-update" => {
            params["queuedSubmissionId"] = json!(queue_id(req)?);
            params["input"] = input_with_resources(req, Some(record), Some(client))?;
            "thread/queue/update"
        }
        "queue-delete" => {
            params["queuedSubmissionId"] = json!(queue_id(req)?);
            "thread/queue/delete"
        }
        "queue-start" => bail!("native-operation-unverified"),
        "queue-reorder" => {
            let ids = req
                .queued_submission_ids
                .as_ref()
                .context("missing-queue-order")?;
            ensure!(
                ids.len() <= 100
                    && ids.iter().all(|s| !s.is_empty() && s.len() <= 128)
                    && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
                "invalid-queue-order"
            );
            params["queuedSubmissionIds"] = json!(ids);
            "thread/queue/reorder"
        }
        "rename" => {
            ensure!(state.status == "idle", "session-busy");
            let name = req
                .name
                .as_deref()
                .filter(|n| {
                    !n.trim().is_empty() && n.len() <= 256 && !n.chars().any(char::is_control)
                })
                .context("invalid-session-name")?;
            params["name"] = json!(name);
            "thread/name/set"
        }
        "archive" => {
            ensure!(state.status == "idle", "session-busy");
            "thread/archive"
        }
        "unarchive" => {
            ensure!(state.status == "archived", "session-not-archived");
            "thread/unarchive"
        }
        // The public app-server protocol has no thread/settings/update request.
        // Settings are selected durably by Service and are passed to the next
        // turn/start, where Codex validates and applies them atomically.
        "settings" => bail!("native-setting-selection-not-routed"),
        "goal-set" => {
            ensure!(state.status == "idle", "session-busy");
            let goal = req.goal.as_ref().context("missing-goal")?;
            let objective = goal["objective"]
                .as_str()
                .filter(|value| !value.trim().is_empty() && value.len() <= 16 * 1024)
                .context("invalid-goal-objective")?;
            let intent = goal
                .get("intent")
                .and_then(Value::as_str)
                .unwrap_or("start");
            ensure!(matches!(intent, "start" | "update"), "invalid-goal-intent");
            if intent == "update" {
                ensure!(record.goal.is_some(), "goal-unavailable");
            } else {
                ensure!(record.goal.is_none(), "goal-already-exists");
                ensure!(state::settings_applied(record), "settings-not-applied");
            }
            let budget = goal.get("tokenBudget").filter(|value| !value.is_null());
            ensure!(
                budget.is_none_or(|value| value.as_u64().is_some_and(|n| n > 0)),
                "invalid-goal-budget"
            );
            params["objective"] = json!(objective);
            if let Some(budget) = goal.get("tokenBudget") {
                params["tokenBudget"] = budget.clone();
            }
            if intent == "start" {
                params["status"] = json!("active");
            }
            "thread/goal/set"
        }
        "goal-pause" | "goal-resume" => {
            let goal = record.goal.as_ref().context("goal-unavailable")?;
            let current = goal["status"].as_str().context("goal-unavailable")?;
            let target = if req.operation == "goal-pause" {
                "paused"
            } else {
                "active"
            };
            ensure!(
                (target == "paused" && current == "active")
                    || (target == "active"
                        && matches!(
                            current,
                            "paused" | "blocked" | "budgetLimited" | "usageLimited"
                        )),
                "goal-state-changed"
            );
            if target == "active" {
                ensure!(state::settings_applied(record), "settings-not-applied");
            }
            params["status"] = json!(target);
            "thread/goal/set"
        }
        "goal-clear" => {
            ensure!(record.goal.is_some(), "goal-unavailable");
            "thread/goal/clear"
        }
        _ => bail!("managed-operation-unsupported"),
    };
    Ok((method, params, None))
}

pub(super) fn select_settings(
    req: &Request,
    record: &Record,
    models: &[Value],
    modes: Option<&[Value]>,
) -> Result<Record> {
    if let Some(mode) = req.mode.as_deref() {
        ensure!(
            modes.is_some_and(|modes| modes.iter().any(|entry| entry["id"] == mode)),
            "unsupported-collaboration-mode"
        );
    }
    let model = if req.reset_defaults {
        record.default_model.as_deref()
    } else {
        req.model.as_deref().or(record.model.as_deref())
    }
    .context("model-required")?;
    let entry = models
        .iter()
        .find(|candidate| candidate["id"] == model)
        .context("unsupported-model")?;
    let effort = if req.reset_defaults {
        record.default_effort.as_deref()
    } else {
        req.effort.as_deref().or(record.effort.as_deref())
    };
    if let Some(effort) = effort {
        ensure!(
            entry["efforts"]
                .as_array()
                .is_some_and(|values| values.contains(&json!(effort))),
            "unsupported-effort"
        );
    }
    let service_tier = if req.reset_defaults {
        record.default_service_tier.as_deref()
    } else {
        req.service_tier
            .as_deref()
            .or(record.service_tier.as_deref())
    };
    if let Some(tier) = service_tier {
        ensure!(
            entry["serviceTiers"]
                .as_array()
                .is_some_and(|tiers| tiers.iter().any(|candidate| candidate["id"] == tier)),
            "unsupported-service-tier"
        );
    }
    let mut selected = record.clone();
    if let Some(mode) = req.mode.as_ref() {
        selected.mode = Some(mode.clone());
    }
    selected.model = Some(model.into());
    selected.effort = effort.map(str::to_owned);
    selected.service_tier = service_tier.map(str::to_owned);
    if let Some(policy) = req.policy_id.as_deref() {
        selected.policy_id = policy.into();
    }
    // Validate the policy identifier and its bounded host-owned mapping now;
    // browsers never provide raw sandbox or reviewer objects.
    apply_policy_params(&mut json!({"config":{}}), &selected)?;
    Ok(selected)
}

pub(super) fn finish(
    req: &Request,
    runner: &Runner,
    ledger: &Ledger,
    result: Value,
    boot: &str,
) -> Result<Value> {
    let name_read = if req.operation == "rename" {
        let native = runner.state.lock().unwrap().record.native_id.clone();
        Some(runner.client.request(
            "thread/read",
            json!({"threadId":native,"includeTurns":false}),
        )?)
    } else {
        None
    };
    let mut state = runner
        .state
        .lock()
        .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
    match req.operation.as_str() {
        "rename" => {
            let read = name_read.unwrap();
            ensure!(
                read["thread"]["name"] == json!(req.name),
                "native-name-unconfirmed"
            );
            state.record.title = req.name.clone().unwrap();
        }
        "archive" => {
            state.status = "archived".into();
            state.record.archived = true;
        }
        "unarchive" => {
            state.status = "idle".into();
        }
        "settings" => ensure!(
            mutation_confirmed(req, &state),
            "settings-selection-unconfirmed"
        ),
        // Native goal mutation receipts were checked before entering finish.
        // Keep any subsequent native event as the current state.
        "goal-set" | "goal-pause" | "goal-resume" => {}
        "goal-clear" => {
            ensure!(state.record.goal.is_none(), "native-goal-unconfirmed");
        }
        _ => {}
    }
    state.revision += 1;
    state.save(ledger)?;
    Ok(
        json!({"accepted":true,"completed":true,"sessionId":req.session_id,"requestId":req.request_id,"runtimeBootId":boot,"result":result}),
    )
}

pub(super) fn mutation_confirmed(req: &Request, state: &State) -> bool {
    match req.operation.as_str() {
        "settings" => {
            let expected_model = if req.reset_defaults {
                state.record.default_model.as_ref()
            } else {
                req.model.as_ref().or(state.record.model.as_ref())
            };
            let expected_effort = if req.reset_defaults {
                state.record.default_effort.as_ref()
            } else {
                req.effort.as_ref().or(state.record.effort.as_ref())
            };
            let expected_tier = if req.reset_defaults {
                state.record.default_service_tier.as_ref()
            } else {
                req.service_tier
                    .as_ref()
                    .or(state.record.service_tier.as_ref())
            };
            state.record.model.as_ref() == expected_model
                && state.record.effort.as_ref() == expected_effort
                && state.record.service_tier.as_ref() == expected_tier
                && req
                    .mode
                    .as_ref()
                    .is_none_or(|mode| state.record.mode.as_ref() == Some(mode))
                && req
                    .policy_id
                    .as_ref()
                    .is_none_or(|policy| state.record.policy_id == *policy)
        }
        "goal-set" => state.record.goal.as_ref().is_some_and(|actual| {
            req.goal.as_ref().is_some_and(|requested| {
                actual["objective"] == requested["objective"]
                    && requested
                        .get("tokenBudget")
                        .is_none_or(|budget| actual["tokenBudget"] == *budget)
                    && actual["status"].is_string()
            })
        }),
        // The engine can immediately hit a budget or complete the goal. A native
        // result is authoritative; do not rewrite those legal transitions.
        "goal-resume" => state.record.goal.as_ref().is_some_and(|goal| {
            matches!(
                goal["status"].as_str(),
                Some("active" | "blocked" | "complete" | "budgetLimited" | "usageLimited")
            )
        }),
        "goal-pause" => state.record.goal.as_ref().is_some_and(|goal| {
            matches!(
                goal["status"].as_str(),
                Some("paused" | "complete" | "budgetLimited" | "usageLimited")
            )
        }),
        "goal-clear" => state.record.goal.is_none(),
        _ => true,
    }
}

/// Fetch the bounded complete native queue; never hand callers a truncated order.
pub(super) fn queue(client: &Client, native: &str) -> Result<Value> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = BTreeSet::new();
    loop {
        let page = client.request(
            "thread/queue/list",
            json!({"threadId":native,"cursor":cursor,"limit":100}),
        )?;
        let data = page["data"].as_array().context("invalid-native-queue")?;
        rows.extend(data.iter().cloned());
        if rows.len() > 100 {
            return Ok(json!({"data":[],"complete":false,"reason":"queue-too-large"}));
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(json!({"data":rows,"nextCursor":null,"complete":true}));
        }
        let key = cursor
            .as_str()
            .filter(|c| !c.is_empty())
            .context("invalid-native-queue-cursor")?;
        ensure!(
            seen.insert(key.to_owned()) && !data.is_empty(),
            "invalid-native-queue-cursor"
        );
    }
}
