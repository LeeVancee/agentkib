//! These tests start from native records, not a SessionDocument with a changed
//! agent label. They certify parser/converter composition, not live CLI import.
use super::*;
use crate::native_targets::{
    NativeTargetModel, prepare_native_import, validate_native_import_readback,
};
use serde_json::json;
use uuid::Uuid;

fn jsonl(path: &Path, rows: &[Value]) {
    fs::write(
        path,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
}
fn source(agent: AgentKind) -> ConversationSessionSummary {
    hermes::fixture_source(agent)
}
fn text(document: &SessionDocument) -> Vec<(SessionRole, String)> {
    document
        .turns
        .iter()
        .flat_map(|turn| {
            turn.blocks.iter().filter_map(move |block| match block {
                SessionBlock::Text { text } => Some((turn.role, text.clone())),
                _ => None,
            })
        })
        .collect()
}
fn documents() -> Vec<SessionDocument> {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("history.jsonl");
    let question = "MATRIX-TEXT API_KEY=matrix-secret";
    let answer = "Decision: preserve message order.";
    jsonl(
        &p,
        &[
            json!({"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":question}}),
            json!({"type":"assistant","uuid":"a","parentUuid":"u","message":{"role":"assistant","content":[{"type":"text","text":answer}]}}),
        ],
    );
    let claude = read_claude_document(&source(AgentKind::ClaudeCode), &p, false, None).unwrap();
    jsonl(
        &p,
        &[
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":question}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":answer}]}}),
        ],
    );
    let codex = read_codex_document(&source(AgentKind::Codex), &p, None).unwrap();
    let opencode = opencode::matrix_parse(json!({"info":{"id":"ses_original"},"messages":[
        {"info":{"id":"u","role":"user"},"parts":[{"type":"text","text":question}]},
        {"info":{"id":"a","role":"assistant"},"parts":[{"type":"text","text":answer},{"type":"reasoning","text":"PRIVATE-REASONING"}]}
    ]})).unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let db = Connection::open(dir.path().join("state.db")).unwrap();
    db.execute_batch("CREATE TABLE sessions(id TEXT,cwd TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,active INTEGER,compacted INTEGER);").unwrap();
    db.execute(
        "INSERT INTO sessions VALUES ('s',?1)",
        [workspace.to_string_lossy()],
    )
    .unwrap();
    for (id, role, value, active) in [
        (1, "user", question, 1),
        (2, "assistant", answer, 1),
        (3, "assistant", "ABANDONED-BRANCH", 0),
    ] {
        db.execute(
            "INSERT INTO messages VALUES (?1,'s',?2,?3,?4,0)",
            rusqlite::params![id, role, value, active],
        )
        .unwrap();
    }
    let provider = HermesProvider::with_home(dir.path().into());
    let sessions = provider.list_sessions(&workspace).unwrap();
    let hermes = provider
        .read_session_document(&source(AgentKind::Hermes), &sessions[0].native_ref, None)
        .unwrap();
    jsonl(
        &p,
        &[
            json!({"type":"user","content":question}),
            json!({"type":"assistant","content":answer}),
        ],
    );
    let grok = grokbuild::matrix_parse(&p).unwrap();
    let antigravity = antigravity::matrix_parse(&[
        json!({"sessionUpdate":"user_message_chunk","messageId":"u","content":{"type":"text","text":question}}),
        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"PRIVATE-REASONING"}}),
        json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":answer}}),
    ]).unwrap();
    vec![
        claude,
        codex,
        opencode,
        hermes,
        grok,
        antigravity,
        cursor::matrix_document(),
        openclaw::matrix_document(),
    ]
}

#[test]
fn native_sources_compose_with_all_five_enabled_target_formats() {
    // 使用平台绝对路径，Windows 不把 `/synthetic/...` 视为绝对路径。
    let workspace = std::env::temp_dir().join("matrix-workspace");
    let workspace = workspace.as_path();
    let docs = documents();
    assert_eq!(docs.len(), 8);
    let mut directions = 0;
    for doc in docs {
        let source_text = text(&doc);
        assert_eq!(source_text.len(), 2, "{:?}", doc.source.agent);
        assert_eq!(source_text[0].0, SessionRole::User);
        assert_eq!(source_text[1].0, SessionRole::Assistant);
        if !matches!(doc.source.agent, AgentKind::Cursor | AgentKind::OpenClaw) {
            assert_eq!(source_text[0].1, "MATRIX-TEXT API_KEY= [REDACTED]");
            assert_eq!(source_text[1].1, "Decision: preserve message order.");
        }

        let serialized = serde_json::to_string(&doc).unwrap();
        assert!(!serialized.contains("matrix-secret"));
        assert!(!serialized.contains("ABANDONED-BRANCH"));
        assert!(!serialized.contains("PRIVATE-REASONING"));
        if doc.source.agent != AgentKind::Cursor {
            assert!(doc.redaction_count > 0);
        }
        if doc.source.agent == AgentKind::OpenClaw
            && let Some(output) = std::env::var_os("AGENTKIB_LIVE_FIXTURE_DIR")
        {
            let output = PathBuf::from(output).join("openclaw");
            let workspace = output.join("workspace");
            fs::create_dir_all(&workspace).unwrap();
            let workspace = fs::canonicalize(workspace).unwrap();
            let session_id = Uuid::new_v4();
            let rendered =
                render_claude_native_session(&doc, session_id, &workspace, Utc::now()).unwrap();
            validate_native_roundtrip(&rendered, AgentKind::ClaudeCode, &doc).unwrap();
            fs::write(output.join("claude.jsonl"), rendered).unwrap();
            for target in [AgentKind::OpenCode, AgentKind::Hermes] {
                let id = if target == AgentKind::OpenCode {
                    format!("ses_{}", Uuid::new_v4().simple())
                } else {
                    Uuid::new_v4().to_string()
                };
                let rendered = prepare_native_import(
                    target,
                    &doc,
                    &id,
                    &workspace,
                    Some(&NativeTargetModel {
                        provider_id: "opencode".into(),
                        model_id: "big-pickle".into(),
                    }),
                )
                .unwrap();
                let name = if target == AgentKind::OpenCode {
                    "opencode"
                } else {
                    "hermes"
                };
                fs::write(
                    output.join(format!("{name}-payload.json")),
                    &rendered.payload,
                )
                .unwrap();
                fs::write(
                    output.join(format!("{name}-expected.json")),
                    serde_json::to_vec_pretty(&rendered.expected).unwrap(),
                )
                .unwrap();
                fs::write(output.join(format!("{name}-id.txt")), id).unwrap();
            }

            fs::write(
                output.join("document.json"),
                serde_json::to_vec_pretty(&doc).unwrap(),
            )
            .unwrap();
            let original: Value =
                serde_json::from_slice(&fs::read(output.join("source.json")).unwrap()).unwrap();
            fs::write(output.parent().unwrap().join("manifest.json"),serde_json::to_vec_pretty(&json!({"cases":[{
                    "source":"openclaw-sqlite-23", "session_id":session_id, "workspace":workspace,
                    "transcript":output.join("claude.jsonl"),
                    "marker":source_text[0].1.split_whitespace().nth(1).unwrap(),
                    "decision":source_text[1].1,
                    "source_files":[{"path":original["original_source_path"],"sha256":original["source_sha256"]},{"path":output.join("source.sqlite"),"sha256":original["source_sha256"]}]
                }]})).unwrap()).unwrap();
            fs::write(
                output.join("target.json"),
                serde_json::to_vec_pretty(&json!({
                    "target_agent":"claude-code", "session_id":session_id,"workspace":workspace,
                    "source_text":source_text
                }))
                .unwrap(),
            )
            .unwrap();
        }
        for target in [AgentKind::ClaudeCode, AgentKind::Codex] {
            let rendered = if target == AgentKind::ClaudeCode {
                render_claude_native_session(&doc, Uuid::new_v4(), workspace, Utc::now())
            } else {
                render_codex_native_session(&doc, Uuid::new_v4(), workspace, Utc::now())
            }
            .unwrap();
            validate_native_roundtrip(&rendered, target, &doc).unwrap();
            directions += 1;
        }
        for target in [AgentKind::OpenCode, AgentKind::Hermes, AgentKind::OpenClaw] {
            let id = if target == AgentKind::OpenCode {
                format!("ses_{}", Uuid::new_v4().simple())
            } else {
                Uuid::new_v4().to_string()
            };
            let prepared = prepare_native_import(
                target,
                &doc,
                &id,
                workspace,
                Some(&NativeTargetModel {
                    provider_id: "offline-fixture".into(),
                    model_id: "offline-fixture".into(),
                }),
            )
            .unwrap();
            let projected = text(&prepared.expected);
            // Hermes merges the adjacent import notice and first user turn.
            assert!(
                projected[projected.len() - 2]
                    .1
                    .ends_with(&source_text[0].1)
            );
            assert_eq!(projected.last(), source_text.last());
            assert!(!prepared.payload.contains("matrix-secret"));
            assert!(!prepared.payload.contains("ABANDONED-BRANCH"));
            assert_eq!(prepared.expected.redaction_count, doc.redaction_count);
            for loss in &doc.losses {
                assert!(prepared.expected.losses.contains(loss));
            }
            if target == AgentKind::OpenCode {
                validate_native_import_readback(target, &prepared.payload, &prepared.expected, &id)
                    .unwrap();
            }
            directions += 1;
        }
    }
    assert_eq!(directions, 40);
}

#[test]
fn native_tool_and_attachment_projection_reports_both_source_and_target_losses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grok.jsonl");
    jsonl(
        &path,
        &[
            json!({"type":"user","content":[{"type":"text","text":"Read the image."},{"type":"image","url":"data:image/png;base64,YWJj"}]}),
            json!({"type":"reasoning","content":"PRIVATE-REASONING"}),
            json!({"type":"assistant","content":"Inspecting.","tool_calls":[{"id":"call-1","name":"read","arguments":"{\"path\":\"SECRET-ARG\"}"}]}),
            json!({"type":"tool_result","tool_call_id":"call-1","content":"SECRET-RESULT"}),
            json!({"type":"assistant","content":"Image checked."}),
        ],
    );
    let doc = grokbuild::matrix_parse(&path).unwrap();
    assert!(
        matches!(&doc.turns[1].blocks[1],SessionBlock::ToolCall{call_id,..} if call_id=="call-1")
    );
    assert!(
        matches!(&doc.turns[2].blocks[0],SessionBlock::ToolResult{call_id,..} if call_id=="call-1")
    );
    for target in [AgentKind::OpenCode, AgentKind::Hermes, AgentKind::OpenClaw] {
        let id = if target == AgentKind::OpenCode {
            format!("ses_{}", Uuid::new_v4().simple())
        } else {
            Uuid::new_v4().to_string()
        };
        let result = prepare_native_import(
            target,
            &doc,
            &id,
            dir.path(),
            Some(&NativeTargetModel {
                provider_id: "fixture".into(),
                model_id: "fixture".into(),
            }),
        )
        .unwrap();
        for (code, count) in [
            (SessionLossCode::ReasoningExcluded, 1),
            (SessionLossCode::TargetToolSummary, 2),
            (SessionLossCode::TargetAttachmentOmitted, 1),
        ] {
            assert_eq!(
                result
                    .expected
                    .losses
                    .iter()
                    .find(|loss| loss.code == code)
                    .map(|loss| loss.count),
                Some(count)
            );
        }
        assert!(!result.payload.contains("SECRET-ARG"));
        assert!(!result.payload.contains("SECRET-RESULT"));
        assert!(!result.payload.contains("PRIVATE-REASONING"));
        assert!(!result.payload.contains("YWJj"));
        assert!(result.payload.contains("Historical tool call: read"));
        assert!(result.payload.contains("Image checked."));
    }
}

#[test]
#[ignore = "exports isolated synthetic native sources and Claude payloads; no model calls"]
fn export_six_native_sources_for_live_acceptance() {
    use sha2::{Digest, Sha256};
    let output = PathBuf::from(
        std::env::var_os("AGENTKIB_LIVE_FIXTURE_DIR")
            .expect("isolated absolute output directory required"),
    );
    assert!(output.is_absolute());
    fs::create_dir_all(&output).unwrap();
    let mut cases = Vec::new();
    for (name, agent) in [
        ("claude-code", AgentKind::ClaudeCode),
        ("codex", AgentKind::Codex),
        ("opencode", AgentKind::OpenCode),
        ("hermes", AgentKind::Hermes),
        ("grok-build", AgentKind::GrokBuild),
        ("antigravity-acp", AgentKind::Antigravity),
    ] {
        let root = output.join(name);
        fs::create_dir(&root).expect("refuse to overwrite an existing acceptance case");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let workspace = fs::canonicalize(workspace).unwrap();
        let marker = Uuid::new_v4().to_string();
        let decision = format!("Use storage namespace {}.", Uuid::new_v4());
        let question = format!("Remember marker {marker}. API_KEY=matrix-secret");
        let path = root.join(if agent == AgentKind::Hermes {
            "state.db"
        } else {
            "source.jsonl"
        });
        let source = source(agent);
        let document = match agent {
            AgentKind::ClaudeCode => {
                jsonl(
                    &path,
                    &[
                        json!({"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":question}}),
                        json!({"type":"assistant","uuid":"a","parentUuid":"u","message":{"role":"assistant","content":[{"type":"text","text":decision}]}}),
                    ],
                );
                read_claude_document(&source, &path, false, None).unwrap()
            }
            AgentKind::Codex => {
                jsonl(
                    &path,
                    &[
                        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":question}]}}),
                        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":decision}]}}),
                    ],
                );
                read_codex_document(&source, &path, None).unwrap()
            }
            AgentKind::GrokBuild => {
                jsonl(
                    &path,
                    &[
                        json!({"type":"user","content":question}),
                        json!({"type":"assistant","content":decision}),
                    ],
                );
                grokbuild::matrix_parse(&path).unwrap()
            }
            AgentKind::OpenCode => {
                fs::write(&path,serde_json::to_vec(&json!({"info":{"id":"ses_original"},"messages":[{"info":{"id":"u","role":"user"},"parts":[{"type":"text","text":question}]},{"info":{"id":"a","role":"assistant"},"parts":[{"type":"text","text":decision}]}]})).unwrap()).unwrap();
                opencode::matrix_parse(serde_json::from_slice(&fs::read(&path).unwrap()).unwrap())
                    .unwrap()
            }
            AgentKind::Antigravity => {
                fs::write(&path,serde_json::to_vec(&json!([
                    {"sessionUpdate":"user_message_chunk","messageId":"u","content":{"type":"text","text":question}},
                    {"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":decision}}
                ])).unwrap()).unwrap();
                let updates: Vec<Value> =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                antigravity::matrix_parse(&updates).unwrap()
            }
            AgentKind::Hermes => {
                let db = Connection::open(&path).unwrap();
                db.execute_batch("CREATE TABLE sessions(id TEXT,cwd TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,active INTEGER,compacted INTEGER);").unwrap();
                db.execute(
                    "INSERT INTO sessions VALUES ('s',?1)",
                    [workspace.to_string_lossy()],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO messages VALUES (1,'s','user',?1,1,0)",
                    [&question],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO messages VALUES (2,'s','assistant',?1,1,0)",
                    [&decision],
                )
                .unwrap();
                drop(db);
                let provider = HermesProvider::with_home(root.clone());
                let sessions = provider.list_sessions(&workspace).unwrap();
                provider
                    .read_session_document(&source, &sessions[0].native_ref, None)
                    .unwrap()
            }
            _ => unreachable!(),
        };
        let original = fs::read(&path).unwrap();
        let session_id = Uuid::new_v4();
        let payload =
            render_claude_native_session(&document, session_id, &workspace, Utc::now()).unwrap();
        validate_native_roundtrip(&payload, AgentKind::ClaudeCode, &document).unwrap();
        assert!(!payload.contains("matrix-secret"));
        assert!(payload.contains(&marker));
        assert!(payload.contains(&decision));
        let transcript = root.join("claude.jsonl");
        fs::write(&transcript, payload).unwrap();
        fs::write(
            root.join("document.json"),
            serde_json::to_vec_pretty(&document).unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        cases.push(json!({"source":name,"session_id":session_id,"workspace":workspace,"transcript":transcript,"marker":marker,"decision":decision,"source_files":[{"path":path,"sha256":hex::encode(Sha256::digest(&original))}]}));
    }
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&json!({"cases":cases})).unwrap(),
    )
    .unwrap();
}
