//! Typed projections of the pinned app-server contract. Never accept arbitrary
//! response JSON: an answer must match a decision derived from the live request.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn bounded(v: &Value, limit: usize) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= limit && !s.contains('\0'))
}
fn keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
}
fn optional(v: &Value, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    v.get(key).is_none_or(|v| v.is_null() || check(v))
}
fn strings(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() <= 100 && a.iter().all(|v| bounded(v, 4096)))
}
fn permission_profile(v: &Value) -> bool {
    keys(v, &["network", "fileSystem"])
        && optional(v, "network", |n| {
            keys(n, &["enabled"]) && optional(n, "enabled", Value::is_boolean)
        })
        && optional(v, "fileSystem", |f| {
            keys(f, &["entries", "read", "write", "globScanMaxDepth"])
                && optional(f, "read", strings)
                && optional(f, "write", strings)
                && optional(f, "globScanMaxDepth", |n| n.as_u64().is_some_and(|n| n > 0))
                && optional(f, "entries", |e| {
                    e.as_array().is_some_and(|a| {
                        a.len() <= 100
                            && a.iter().all(|e| {
                                keys(e, &["access", "path"])
                                    && matches!(
                                        e["access"].as_str(),
                                        Some("read" | "write" | "deny")
                                    )
                                    && match e["path"]["type"].as_str() {
                                        Some("path") => {
                                            keys(&e["path"], &["type", "path"])
                                                && bounded(&e["path"]["path"], 4096)
                                        }
                                        Some("glob_pattern") => {
                                            keys(&e["path"], &["type", "pattern"])
                                                && bounded(&e["path"]["pattern"], 4096)
                                        }
                                        // Special path values may expand scopes not displayed by older clients.
                                        _ => false,
                                    }
                            })
                    })
                })
        })
}
fn network_rule(v: &Value) -> bool {
    keys(v, &["action", "host"])
        && matches!(v["action"].as_str(), Some("allow" | "deny"))
        && bounded(&v["host"], 1024)
}

pub fn native_approval_options(method: &str, details: &Value) -> Vec<Value> {
    if serde_json::to_vec(details).map_or(true, |b| b.len() > 1024 * 1024) {
        return vec![];
    }
    let common = [
        "threadId",
        "turnId",
        "itemId",
        "reason",
        "startedAtMs",
        "environmentId",
        "cwd",
    ];
    let extra: &[&str] = match method {
        "item/commandExecution/requestApproval" => &[
            "approvalId",
            "command",
            "commandActions",
            "kind",
            "availableDecisions",
            "proposedExecpolicyAmendment",
            "proposedNetworkPolicyAmendments",
            "networkApprovalContext",
            "additionalPermissions",
        ],
        "item/fileChange/requestApproval" => &["changes", "grantRoot", "availableDecisions"],
        "item/permissions/requestApproval" => &["permissions"],
        _ => return vec![],
    };
    if !details.as_object().is_some_and(|m| {
        m.iter().all(|(k, v)| {
            v.is_null() || common.contains(&k.as_str()) || extra.contains(&k.as_str())
        })
    }) || !optional(details, "environmentId", |v| v == "local")
        || !optional(details, "reason", |v| bounded(v, 16384))
        || !optional(details, "startedAtMs", |v| v.as_u64().is_some())
    {
        return vec![];
    }
    if method == "item/permissions/requestApproval" {
        if !bounded(&details["cwd"], 4096) || !permission_profile(&details["permissions"]) {
            return vec![];
        }
        return vec![
            json!({"id":"grant-turn","label":"grant-turn","scope":"once","decision":{"permissions":details["permissions"],"scope":"turn"}}),
            json!({"id":"grant-session","label":"grant-session","scope":"session","decision":{"permissions":details["permissions"],"scope":"session"}}),
            json!({"id":"deny-permissions","label":"deny-permissions","scope":"once","decision":{"permissions":{},"scope":"turn"}}),
        ];
    }
    if method == "item/commandExecution/requestApproval" {
        if !bounded(&details["command"], 16384)
            || !bounded(&details["cwd"], 4096)
            || !optional(details, "kind", |v| v == "command")
            || !optional(details, "additionalPermissions", permission_profile)
            || !optional(details, "networkApprovalContext", |v| {
                keys(v, &["host", "protocol"])
                    && bounded(&v["host"], 1024)
                    && matches!(
                        v["protocol"].as_str(),
                        Some("http" | "https" | "tcp" | "udp")
                    )
            })
            || !optional(details, "proposedExecpolicyAmendment", strings)
            || !optional(details, "proposedNetworkPolicyAmendments", |v| {
                v.as_array()
                    .is_some_and(|a| a.len() <= 100 && a.iter().all(network_rule))
            })
        {
            return vec![];
        }
    } else if !details["changes"]
        .as_array()
        .is_some_and(|a| !a.is_empty() && a.len() <= 100)
        || !optional(details, "grantRoot", |v| bounded(v, 4096))
    {
        return vec![];
    }
    let defaults = vec![json!("accept"), json!("decline"), json!("cancel")];
    let offered = match details.get("availableDecisions") {
        None | Some(Value::Null) => &defaults,
        Some(Value::Array(a)) if a.len() <= 32 => a,
        _ => return vec![],
    };
    let mut result = vec![];
    for (i, decision) in offered.iter().enumerate() {
        let (label, scope) = match decision.as_str() {
            Some("accept") => (
                "accept",
                if details.get("grantRoot").is_some_and(|v| !v.is_null()) {
                    "session"
                } else {
                    "once"
                },
            ),
            Some("decline") => ("decline", "once"),
            Some("cancel") => ("cancel", "once"),
            Some("acceptForSession") => ("acceptForSession", "session"),
            Some(_) => continue,
            None if method == "item/commandExecution/requestApproval" => {
                if keys(decision,&["acceptWithExecpolicyAmendment"])
                    && keys(&decision["acceptWithExecpolicyAmendment"],&["execpolicy_amendment"])
                    && strings(&decision["acceptWithExecpolicyAmendment"]["execpolicy_amendment"])
                    && decision["acceptWithExecpolicyAmendment"]["execpolicy_amendment"] == details["proposedExecpolicyAmendment"] {
                    ("acceptWithExecpolicyAmendment","persistent")
                } else if keys(decision,&["applyNetworkPolicyAmendment"])
                    && keys(&decision["applyNetworkPolicyAmendment"],&["network_policy_amendment"])
                    && network_rule(&decision["applyNetworkPolicyAmendment"]["network_policy_amendment"])
                    && details["proposedNetworkPolicyAmendments"].as_array().is_some_and(|a|a.contains(&decision["applyNetworkPolicyAmendment"]["network_policy_amendment"])) {
                    ("applyNetworkPolicyAmendment","persistent")
                } else { continue; }
            }
            None => continue,
        };
        result.push(
            json!({"id":format!("native-{i}"),"label":label,"scope":scope,"decision":decision}),
        );
    }
    result
}

pub fn validate_native_approval(method: &str, details: &Value, decision: &Value) -> Result<()> {
    ensure!(
        native_approval_options(method, details)
            .iter()
            .any(|o| &o["decision"] == decision),
        "decision-not-offered"
    );
    Ok(())
}

pub fn project_native_questions(params: &Value) -> Option<Value> {
    let rows = params["questions"].as_array()?;
    if rows.is_empty() || rows.len() > 32 {
        return None;
    }
    let mut ids = BTreeSet::new();
    let mut supported = true;
    let questions: Vec<_> = rows.iter().map(|q| {
        // Pinned protocol has no multiSelect declaration; never infer it from
        // the array-valued response container.
        let secret = q["isSecret"] == true;
        let options = q["options"].as_array().cloned().unwrap_or_default();
        let custom = q["isOther"] == true || q.get("options").is_none_or(Value::is_null);
        let mut labels = BTreeSet::new();
        supported &= keys(q,&["id","header","question","isOther","isSecret","options"])
            && bounded(&q["id"],256) && ids.insert(q["id"].as_str().unwrap_or_default().to_owned())
            && bounded(&q["question"],16384) && optional(q,"header",|v|bounded(v,1024))
            && optional(q,"isOther",Value::is_boolean) && optional(q,"isSecret",Value::is_boolean)
            && optional(q,"options",Value::is_array)
            && (custom || !options.is_empty()) && options.len() <= 100
            && options.iter().all(|o| keys(o,&["label","description"]) && bounded(&o["label"],4096) && labels.insert(o["label"].as_str().unwrap_or_default().to_owned()) && optional(o,"description",|v|bounded(v,16384)));
        json!({"id":q["id"],"header":q["header"],"question":q["question"],"options":options,"multiSelect":false,"allowCustom":custom,"isSecret":secret})
    }).collect();
    Some(json!({"supported":supported,"questions":questions}))
}

pub fn validate_native_answers(questions: &Value, answers: &Value) -> Result<Value> {
    let rows = questions.as_array().context("invalid-questions")?;
    let map = answers.as_object().context("invalid-answers")?;
    ensure!(
        map.len() == rows.len() && !rows.is_empty(),
        "answer-keys-mismatch"
    );
    ensure!(
        serde_json::to_vec(answers)?.len() <= 65536,
        "answers-too-large"
    );
    let mut result = serde_json::Map::new();
    for q in rows {
        let id = q["id"].as_str().context("invalid-question-id")?;
        let a = map
            .get(id)
            .and_then(Value::as_array)
            .context("missing-answer")?;
        ensure!(a.len() == 1, "invalid-answer-cardinality");
        ensure!(
            bounded(&a[0], 8192) && a[0].as_str().is_some_and(|s| !s.trim().is_empty()),
            "invalid-answer"
        );
        ensure!(
            q["allowCustom"] == true
                || q["options"]
                    .as_array()
                    .is_some_and(|opts| opts.iter().any(|o| o["label"] == a[0])),
            "answer-not-offered"
        );
        result.insert(id.into(), json!({"answers":a}));
    }
    Ok(json!({"answers":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_rules_must_match_both_offered_decision_and_proposal() {
        let decision = json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo"]}});
        let mut p = json!({"command":"echo ok","cwd":"/tmp","availableDecisions":["acceptForSession",decision],"proposedExecpolicyAmendment":["echo"]});
        assert_eq!(
            native_approval_options("item/commandExecution/requestApproval", &p).len(),
            2
        );
        assert!(
            validate_native_approval("item/commandExecution/requestApproval", &p, &decision)
                .is_ok()
        );
        p["proposedExecpolicyAmendment"] = json!(["rm"]);
        assert!(
            validate_native_approval("item/commandExecution/requestApproval", &p, &decision)
                .is_err()
        );
        p["unknownScope"] = json!(true);
        assert!(native_approval_options("item/commandExecution/requestApproval", &p).is_empty());
    }
    #[test]
    fn permission_grants_never_expand_requested_scope() {
        let p = json!({"cwd":"/tmp","permissions":{"network":{"enabled":true}}});
        let options = native_approval_options("item/permissions/requestApproval", &p);
        assert_eq!(options.len(), 3);
        assert!(
            validate_native_approval(
                "item/permissions/requestApproval",
                &p,
                &json!({"permissions":{"fileSystem":{"write":["/"]}},"scope":"session"})
            )
            .is_err()
        );
    }
    #[test]
    fn plain_and_secret_inputs_preserve_native_contract() {
        let p = project_native_questions(
            &json!({"questions":[{"id":"q","question":"Value","isSecret":true}]}),
        )
        .unwrap();
        assert_eq!(p["supported"], true);
        assert_eq!(p["questions"][0]["isSecret"], true);
        assert!(validate_native_answers(&p["questions"], &json!({"q":["value"]})).is_ok());
        assert!(validate_native_answers(&p["questions"], &json!({"q":["a","b"]})).is_err());
        assert!(validate_native_answers(&p["questions"], &json!({"other":["value"]})).is_err());
        assert_eq!(
            project_native_questions(
                &json!({"questions":[{"id":"q","question":"Value","multiSelect":true}]})
            )
            .unwrap()["supported"],
            false
        );
    }
}
