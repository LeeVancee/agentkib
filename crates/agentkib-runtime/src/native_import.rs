//! Reviewed command imports. The attempt marker is durable before a target can
//! be mutated: a lost CLI response must never cause an automatic second import.
use super::*;
mod openclaw;
use agentkib_conversations::native_targets::{
    NativeTargetModel, prepare_native_import, validate_native_import_document,
    validate_native_import_readback, validate_native_import_readback_prefix,
};
use agentkib_core::{ChangeScope, ChangeSet, FileChange, RiskLevel};
use std::fs::OpenOptions;

thread_local! { static DEADLINE: std::cell::Cell<Option<Instant>> = const {std::cell::Cell::new(None)}; }
pub(super) fn with_deadline<T>(deadline: Instant, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<Instant>);
    impl Drop for Reset {
        fn drop(&mut self) {
            DEADLINE.set(self.0);
        }
    }
    let _reset = Reset(DEADLINE.replace(Some(deadline)));
    f()
}
pub(super) fn remaining() -> Duration {
    DEADLINE
        .get()
        .map(|d| d.saturating_duration_since(Instant::now()))
        .unwrap_or(Duration::from_secs(180))
}

pub(super) static STOPPING: AtomicBool = AtomicBool::new(false);
const MAX_OUTPUT: u64 = 256 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Plan {
    pub schema_version: u32,
    pub operation_id: String,
    pub workspace_id: String,
    pub workspace: PathBuf,
    pub source_session_id: String,
    pub source_fingerprint: String,
    pub target_agent: AgentKind,
    pub executable: PathBuf,
    pub version: String,
    pub model: Option<NativeTargetModel>,
    pub target_home: Option<PathBuf>,
    pub target_profile: Option<String>,
    pub environment: Vec<(String, Option<String>)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openclaw: Option<openclaw::Context>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<cursor_bridge::Context>,
    pub target_session_id: String,
    pub document: SessionDocument,
    pub expected: SessionDocument,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportRequest {
    pub operation_id: String,
    pub workspace_id: String,
    pub target_agent: AgentKind,
    pub plan_hash: String,
    pub capabilities: Option<ContinuationCapabilities>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Receipt {
    schema_version: u32,
    plan_hash: String,
    target_session_id: String,
    verified: bool,
    launched: bool,
    terminal: Option<String>,
}

pub(super) fn is_target(agent: AgentKind) -> bool {
    matches!(
        agent,
        AgentKind::OpenCode | AgentKind::Hermes | AgentKind::OpenClaw | AgentKind::Cursor
    )
}

pub(super) fn installation(agent: AgentKind) -> anyhow::Result<(PathBuf, String)> {
    anyhow::ensure!(
        is_target(agent),
        "Native importer has not been verified for this target"
    );
    anyhow::ensure!(
        agent != AgentKind::Cursor,
        "Cursor IDE requires an explicitly connected window"
    );
    if agent == AgentKind::OpenClaw {
        return openclaw::installation();
    }
    capture_environment()?;
    anyhow::ensure!(
        agent != AgentKind::OpenCode
            || std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none_or(|value| value.is_empty()),
        "Inline OpenCode configuration cannot be safely reproduced in an interactive terminal"
    );
    let name = if agent == AgentKind::Hermes {
        "hermes"
    } else {
        "opencode"
    };
    let executable =
        agentkib_platform::command::resolve(name).context("Target CLI is unavailable")?;
    let output = command(
        &executable,
        &["--version".into()],
        None,
        Duration::from_secs(3),
    )?;
    let output = String::from_utf8(output)?;
    let version = if agent == AgentKind::Hermes {
        anyhow::ensure!(
            output
                .lines()
                .any(|line| line.trim() == "Hermes Agent v0.21.5 (2026.9.24)"),
            "Unverified Hermes import version"
        );
        "0.21.5".to_owned()
    } else {
        anyhow::ensure!(
            output.trim() == "1.18.32",
            "Unverified OpenCode import version"
        );
        "1.18.32".to_owned()
    };
    Ok((executable, version))
}

fn directory(workspace_id: &str, operation_id: &str) -> anyhow::Result<PathBuf> {
    Ok(archive_directory(
        &agentkib_store::default_data_dir()?,
        workspace_id,
        operation_id,
    )?
    .join("import"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListRequest {
    pub workspace_id: String,
}

pub(super) fn list(request: ListRequest) -> anyhow::Result<Value> {
    let store = Store::open_default()?;
    let workspace_id = continuation_workspace_id(&store, &request.workspace_id)?;
    let base = directory(&workspace_id, &uuid::Uuid::nil().to_string())?;
    let root = base
        .parent()
        .and_then(Path::parent)
        .context("Import root unavailable")?;
    safe_path(root)?;
    if !root.exists() {
        return Ok(json!([]));
    }
    let mut operations = Vec::new();
    for entry in fs::read_dir(root)?.take(512) {
        let path = entry?.path().join("import/plan.json");
        if !path.exists() || safe_path(&path).is_err() {
            continue;
        }
        let content = read_bounded(&path)?;
        let Ok(plan) = serde_json::from_slice::<Plan>(&content) else {
            continue;
        };
        if validate_plan(&plan, &workspace_id).is_err() {
            continue;
        }
        let directory = path.parent().context("Import directory unavailable")?;
        let receipt = read_bounded(&directory.join("receipt.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Receipt>(&bytes).ok())
            .filter(|receipt| {
                receipt.plan_hash == agentkib_core::hash_content(&content)
                    && receipt_identity_valid(&plan, &receipt.target_session_id)
            });
        let status = if receipt.as_ref().is_some_and(|r| r.launched) {
            "launched"
        } else if receipt.as_ref().is_some_and(|r| r.verified) {
            "verified"
        } else if directory.join("attempted.json").exists() {
            "outcome-unknown"
        } else {
            "prepared"
        };
        operations.push(json!({
            "launch_request": SessionHandoffLaunchRequest::NativeImport(ImportRequest {
                operation_id: plan.operation_id, workspace_id: workspace_id.clone(), target_agent: plan.target_agent,
                plan_hash: agentkib_core::hash_content(&content), capabilities: None,
            }),
            "source_session_id": plan.source_session_id,
            "binding_id": plan.cursor.as_ref().map(|context| &context.binding_id),
            "target_session_id": receipt.as_ref().map(|r| &r.target_session_id),
            "status": status,
        }));
    }
    Ok(Value::Array(operations))
}

pub(super) fn plan_path(request: &ImportRequest) -> anyhow::Result<PathBuf> {
    let path = directory(&request.workspace_id, &request.operation_id)?.join("plan.json");
    safe_path(&path)?;
    Ok(path)
}

fn model(executable: &Path, workspace: &Path) -> anyhow::Result<NativeTargetModel> {
    let output = command(
        executable,
        &["debug".into(), "config".into()],
        Some(workspace),
        Duration::from_secs(10),
    )?;
    let config: Value = serde_json::from_slice(&output)?;
    let selected = config
        .get("model")
        .and_then(Value::as_str)
        .context("Configure an explicit OpenCode provider/model before native import")?;
    let (provider_id, model_id) = selected
        .split_once('/')
        .context("Invalid OpenCode configured model")?;
    anyhow::ensure!(
        !provider_id.is_empty() && !model_id.is_empty(),
        "Invalid OpenCode configured model"
    );
    Ok(NativeTargetModel {
        provider_id: provider_id.into(),
        model_id: model_id.into(),
    })
}

fn target_settings(
    agent: AgentKind,
    executable: &Path,
    workspace: &Path,
) -> anyhow::Result<(Option<NativeTargetModel>, Option<PathBuf>, Option<String>)> {
    if agent == AgentKind::OpenClaw {
        openclaw::context(executable, workspace)?;
        Ok((None, None, None))
    } else if agent == AgentKind::Hermes {
        let (home, profile) = hermes_target()?;
        Ok((None, Some(home), Some(profile)))
    } else {
        Ok((Some(model(executable, workspace)?), None, None))
    }
}

fn import_marker(agent: AgentKind, operation_id: &str) -> String {
    if agent == AgentKind::OpenCode {
        format!("ses_{}", operation_id.replace('-', ""))
    } else {
        operation_id.to_owned()
    }
}

pub(super) fn projected(
    target: AgentKind,
    document: &SessionDocument,
    workspace: &Path,
) -> anyhow::Result<SessionDocument> {
    let (executable, _) = installation(target)?;
    let (model, _, _) = target_settings(target, &executable, workspace)?;
    Ok(prepare_native_import(
        target,
        document,
        &import_marker(target, &uuid::Uuid::nil().to_string()),
        workspace,
        model.as_ref(),
    )?
    .expected)
}

pub(super) fn target_fingerprint(
    target: AgentKind,
    document: &SessionDocument,
    workspace: &Path,
) -> anyhow::Result<String> {
    let (executable, version) = installation(target)?;
    let (model, home, profile) = target_settings(target, &executable, workspace)?;
    let prepared = prepare_native_import(
        target,
        document,
        &import_marker(target, &uuid::Uuid::nil().to_string()),
        workspace,
        model.as_ref(),
    )?;
    Ok(agentkib_core::hash_content(&serde_json::to_vec(&(
        &executable,
        version,
        model,
        home,
        profile,
        capture_environment()?,
        prepared,
        if target == AgentKind::OpenClaw {
            Some(openclaw::context(&executable, workspace)?)
        } else {
            None
        },
    ))?))
}

const STORAGE_ENVIRONMENT: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "HERMES_HOME",
    "OPENCODE_TEST_HOME",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
];

fn capture_environment() -> anyhow::Result<Vec<(String, Option<String>)>> {
    let values = STORAGE_ENVIRONMENT
        .iter()
        .map(|key| {
            Ok((
                (*key).to_owned(),
                (if *key == "OPENCODE_CONFIG_CONTENT" {
                    None
                } else {
                    std::env::var_os(key)
                })
                .map(|value| {
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("Storage environment is not UTF-8"))
                })
                .transpose()?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    validate_environment(&values)?;
    Ok(values)
}

fn validate_environment(values: &[(String, Option<String>)]) -> anyhow::Result<()> {
    anyhow::ensure!(
        values.len() == STORAGE_ENVIRONMENT.len(),
        "Storage environment is incomplete"
    );
    for ((key, value), allowed) in values.iter().zip(STORAGE_ENVIRONMENT) {
        anyhow::ensure!(
            key == allowed
                && (key != "OPENCODE_CONFIG_CONTENT" || value.is_none())
                && value
                    .as_ref()
                    .is_none_or(|value| !value.contains(['\0', '\n', '\r'])),
            "Invalid storage environment"
        );
    }
    Ok(())
}

fn valid_profile(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn hermes_target() -> anyhow::Result<(PathBuf, String)> {
    let home = std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".hermes")))
        .context("Hermes home unavailable")?;
    anyhow::ensure!(home.is_absolute(), "Hermes home must be absolute");
    let (home, profile) = if home
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "profiles")
    {
        let profile = home
            .file_name()
            .and_then(|name| name.to_str())
            .context("Invalid Hermes profile")?
            .to_owned();
        (home, profile)
    } else {
        let active = home.join("active_profile");
        let profile = if active.exists() {
            let mut text = String::new();
            fs::File::open(&active)?
                .take(256)
                .read_to_string(&mut text)?;
            let name = text.trim();
            if name.is_empty() {
                "default".into()
            } else {
                name.to_owned()
            }
        } else {
            "default".into()
        };
        let selected = if profile == "default" {
            home
        } else {
            home.join("profiles").join(&profile)
        };
        (selected, profile)
    };
    anyhow::ensure!(valid_profile(&profile), "Invalid Hermes profile name");
    ensure_native_path(&home)?;
    Ok((fs::canonicalize(home)?, profile))
}

fn ensure_native_path(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir)),
        "Invalid native storage path"
    );
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok() {
            anyhow::ensure!(
                !platform_path::is_reparse_or_symlink(ancestor)?,
                "Native storage path is a link"
            );
        }
    }
    Ok(())
}

fn receipt_identity_valid(plan: &Plan, id: &str) -> bool {
    match plan.target_agent {
        AgentKind::OpenCode | AgentKind::OpenClaw => id == plan.target_session_id,
        AgentKind::Cursor => uuid::Uuid::parse_str(id).is_ok(),
        AgentKind::Hermes => {
            let bytes = id.as_bytes();
            bytes.len() == 22
                && bytes[8] == b'_'
                && bytes[15] == b'_'
                && bytes[..8]
                    .iter()
                    .chain(bytes[9..15].iter())
                    .all(u8::is_ascii_digit)
                && bytes[16..].iter().all(u8::is_ascii_hexdigit)
        }
        _ => false,
    }
}

fn safe_path(path: &Path) -> anyhow::Result<()> {
    let root = agentkib_store::default_data_dir()?;
    anyhow::ensure!(
        path.is_absolute() && path.starts_with(&root),
        "Import path escapes application data"
    );
    anyhow::ensure!(
        !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir)),
        "Invalid import path"
    );
    let mut cursor = Some(path);
    while let Some(p) = cursor {
        if p.exists() || fs::symlink_metadata(p).is_ok() {
            anyhow::ensure!(
                !platform_path::is_reparse_or_symlink(p)?,
                "Import path is a link"
            );
        }
        if p == root {
            return Ok(());
        }
        cursor = p.parent();
    }
    anyhow::bail!("Invalid import root")
}

pub(super) fn plan(
    workspace: &Path,
    workspace_id: &str,
    source_session_id: &str,
    source_fingerprint: &str,
    target_agent: AgentKind,
    document: &SessionDocument,
    capabilities: ContinuationCapabilities,
) -> anyhow::Result<PlannedSessionHandoff> {
    let (executable, version) = installation(target_agent)?;
    let workspace = agentkib_core::canonical_project(workspace)?;
    let (model, target_home, target_profile) =
        target_settings(target_agent, &executable, &workspace)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let target_session_id = import_marker(target_agent, &operation_id);
    let prepared = prepare_native_import(
        target_agent,
        document,
        &target_session_id,
        &workspace,
        model.as_ref(),
    )?;
    let plan = Plan {
        schema_version: 1,
        operation_id: operation_id.clone(),
        workspace_id: workspace_id.into(),
        workspace: workspace.clone(),
        source_session_id: source_session_id.into(),
        source_fingerprint: source_fingerprint.into(),
        target_agent,
        cursor: None,
        openclaw: if target_agent == AgentKind::OpenClaw {
            Some(openclaw::context(&executable, &workspace)?)
        } else {
            None
        },
        executable,
        version,
        model,
        target_home,
        target_profile,
        environment: capture_environment()?,
        target_session_id,
        document: document.clone(),
        expected: prepared.expected,
        payload: prepared.payload,
    };
    let content = serde_json::to_string_pretty(&plan)?;
    let path = directory(workspace_id, &operation_id)?.join("plan.json");
    safe_path(&path)?;
    anyhow::ensure!(!path.exists(), "Import operation already exists");
    Ok(PlannedSessionHandoff {
        change_set: ChangeSet {
            id: operation_id.clone(),
            project_root: workspace,
            created_at: Utc::now(),
            requires_home_approval: true,
            changes: vec![FileChange {
                target: path,
                scope: ChangeScope::ApplicationData,
                original_hash: None,
                before: String::new(),
                after: content.clone(),
                risk: RiskLevel::High,
                validator: "json".into(),
            }],
        },
        launch_request: SessionHandoffLaunchRequest::NativeImport(ImportRequest {
            operation_id,
            workspace_id: workspace_id.into(),
            target_agent,
            plan_hash: agentkib_core::hash_content(content.as_bytes()),
            capabilities: Some(capabilities),
        }),
    })
}

fn validate_plan(plan: &Plan, workspace_id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        plan.schema_version == 1 && plan.workspace_id == workspace_id,
        "Import plan version or workspace mismatch"
    );
    let _: uuid::Uuid = plan.operation_id.parse()?;
    anyhow::ensure!(
        fingerprint(&plan.document)? == plan.source_fingerprint,
        "Import document differs from its approved source fingerprint"
    );
    if plan.target_agent == AgentKind::Cursor {
        return validate_cursor_plan(plan);
    }
    anyhow::ensure!(plan.cursor.is_none(), "Unexpected Cursor context");
    validate_environment(&plan.environment)?;
    anyhow::ensure!(
        is_target(plan.target_agent),
        "Unverified native import target"
    );
    anyhow::ensure!(
        plan.target_session_id == import_marker(plan.target_agent, &plan.operation_id),
        "Import target identity mismatch"
    );
    anyhow::ensure!(
        plan.document.source.workspace_id == workspace_id,
        "Import document workspace mismatch"
    );
    anyhow::ensure!(
        match plan.target_agent {
            AgentKind::Hermes =>
                plan.model.is_none()
                    && plan
                        .target_home
                        .as_ref()
                        .is_some_and(|home| home.is_absolute())
                    && plan
                        .target_profile
                        .as_ref()
                        .is_some_and(|profile| valid_profile(profile)),
            AgentKind::OpenClaw =>
                plan.model.is_none() && plan.target_home.is_none() && plan.target_profile.is_none(),
            AgentKind::OpenCode =>
                plan.model.is_some() && plan.target_home.is_none() && plan.target_profile.is_none(),
            _ => false,
        },
        "Import target settings mismatch"
    );
    if let Some(context) = &plan.openclaw {
        context.validate()?;
    }
    anyhow::ensure!(
        (plan.target_agent == AgentKind::OpenClaw) == plan.openclaw.is_some(),
        "Unexpected OpenClaw context"
    );
    let prepared = prepare_native_import(
        plan.target_agent,
        &plan.document,
        &plan.target_session_id,
        &plan.workspace,
        plan.model.as_ref(),
    )?;
    anyhow::ensure!(
        prepared.payload == plan.payload && prepared.expected == plan.expected,
        "Import payload does not match its reviewed document"
    );
    Ok(())
}

pub(super) fn validate_changes(
    changes: &ChangeSet,
    workspace_id: &str,
) -> anyhow::Result<Vec<PathBuf>> {
    anyhow::ensure!(
        changes.changes.len() == 1 && changes.requires_home_approval,
        "Native import requires a single reviewed plan and Agent Home approval"
    );
    let change = &changes.changes[0];
    let plan: Plan = serde_json::from_str(&change.after)?;
    validate_plan(&plan, workspace_id)?;
    anyhow::ensure!(
        agentkib_core::canonical_project(&changes.project_root)? == plan.workspace,
        "Import project mismatch"
    );
    let expected = directory(workspace_id, &plan.operation_id)?.join("plan.json");
    anyhow::ensure!(
        change.target == expected
            && change.validator == "json"
            && matches!(change.scope, ChangeScope::ApplicationData)
            && change.original_hash.is_none()
            && change.before.is_empty()
            && !expected.exists(),
        "Unexpected import plan destination"
    );
    safe_path(&expected)?;
    Ok(vec![expected])
}

pub(super) fn validate_request(changes: &ChangeSet, request: &ImportRequest) -> anyhow::Result<()> {
    validate_changes(changes, &request.workspace_id)?;
    let content = &changes.changes[0].after;
    let plan: Plan = serde_json::from_str(content)?;
    anyhow::ensure!(
        plan.operation_id == request.operation_id
            && plan.target_agent == request.target_agent
            && agentkib_core::hash_content(content.as_bytes()) == request.plan_hash,
        "Import request does not match reviewed plan"
    );
    Ok(())
}

fn read_plan(request: &ImportRequest) -> anyhow::Result<(PathBuf, Plan)> {
    let directory = directory(&request.workspace_id, &request.operation_id)?;
    let path = directory.join("plan.json");
    safe_path(&path)?;
    let content = read_bounded(&path)?;
    anyhow::ensure!(
        agentkib_core::hash_content(&content) == request.plan_hash,
        "Import plan changed"
    );
    let plan: Plan = serde_json::from_slice(&content)?;
    validate_plan(&plan, &request.workspace_id)?;
    anyhow::ensure!(
        plan.operation_id == request.operation_id && plan.target_agent == request.target_agent,
        "Import operation mismatch"
    );
    Ok((directory, plan))
}

fn read_bounded(path: &Path) -> anyhow::Result<Vec<u8>> {
    safe_path(path)?;
    let metadata = fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= MAX_OUTPUT,
        "Import record is not a bounded regular file"
    );
    let mut content = Vec::new();
    fs::File::open(path)?
        .take(MAX_OUTPUT + 1)
        .read_to_end(&mut content)?;
    anyhow::ensure!(
        content.len() as u64 <= MAX_OUTPUT,
        "Import file exceeds size limit"
    );
    Ok(content)
}

fn create_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    safe_path(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(content)?;
    file.sync_all()?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn save_receipt(directory: &Path, receipt: &Receipt) -> anyhow::Result<()> {
    let path = directory.join("receipt.json");
    safe_path(&path)?;
    let temporary = directory.join(format!("receipt-{}.tmp", uuid::Uuid::new_v4()));
    create_file(&temporary, &serde_json::to_vec(receipt)?)?;
    fs::rename(temporary, path)?;
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

fn verify(
    plan: &Plan,
    directory: &Path,
    known_id: Option<&str>,
    exact: bool,
) -> anyhow::Result<String> {
    if plan.target_agent == AgentKind::OpenClaw {
        return openclaw::verify(plan, directory, exact);
    }
    if plan.target_agent == AgentKind::Hermes {
        return verify_hermes(plan, directory, known_id, exact);
    }
    let output = command(
        &plan.executable,
        &["export".into(), plan.target_session_id.clone().into()],
        Some(&plan.workspace),
        COMMAND_TIMEOUT,
    )?;
    let exported: Value = serde_json::from_slice(&output)?;
    anyhow::ensure!(
        exported
            .pointer("/info/directory")
            .and_then(Value::as_str)
            .is_some_and(|p| Path::new(p) == plan.workspace),
        "Imported workspace mismatch"
    );
    if exact {
        validate_native_import_readback(
            plan.target_agent,
            std::str::from_utf8(&output)?,
            &plan.expected,
            &plan.target_session_id,
        )?;
    } else {
        validate_native_import_readback_prefix(
            plan.target_agent,
            std::str::from_utf8(&output)?,
            &plan.expected,
            &plan.target_session_id,
        )?;
        anyhow::ensure!(
            exported.pointer("/info/id").and_then(Value::as_str)
                == Some(plan.target_session_id.as_str()),
            "Imported target identity changed"
        );
    }
    let model = plan.model.as_ref().context("OpenCode model unavailable")?;
    for message in exported
        .get("messages")
        .and_then(Value::as_array)
        .context("Missing exported messages")?
        .iter()
        .take(plan.expected.turns.len())
    {
        let info = &message["info"];
        if info["role"] == "user" {
            anyhow::ensure!(
                info["model"]["providerID"] == model.provider_id
                    && info["model"]["modelID"] == model.model_id,
                "Imported model differs from preview"
            );
        }
    }
    Ok(plan.target_session_id.clone())
}

fn verify_hermes(
    plan: &Plan,
    directory: &Path,
    known_id: Option<&str>,
    exact: bool,
) -> anyhow::Result<String> {
    let database = plan
        .target_home
        .as_ref()
        .context("Hermes home missing")?
        .join("state.db");
    ensure_native_path(&database)?;
    let conn = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(500))?;
    conn.execute_batch("BEGIN")?;
    let payload = directory.join("payload.json");
    let payload = payload.to_str().context("Payload path is not UTF-8")?;
    let mut query=conn.prepare("SELECT id,cwd FROM sessions WHERE CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.foreign_session_id') END = ?1 AND CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.path') END = ?2 AND CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.tool') END = 'claude-code' LIMIT 2")?;
    let candidates = query
        .query_map(rusqlite::params![plan.operation_id, payload], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        candidates.len() == 1,
        "Hermes import identity is missing or ambiguous; operation preserved for reconciliation"
    );
    let (id, cwd) = &candidates[0];
    // Hermes --resume resolves compression/continuation descendants before
    // loading messages. Until that lineage can be verified end to end, reject
    // redirects even when the original parent's exported text is still intact.
    let redirects: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE parent_session_id=?1) OR EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND parent_session_id IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        !redirects,
        "Hermes target has a continuation or parent; resume identity cannot be verified"
    );
    anyhow::ensure!(
        receipt_identity_valid(plan, id) && known_id.is_none_or(|known| known == id),
        "Hermes target identity differs from receipt"
    );
    anyhow::ensure!(
        cwd.as_deref()
            .is_some_and(|path| Path::new(path) == plan.workspace),
        "Hermes imported workspace mismatch"
    );
    {
        let mut query=conn.prepare("SELECT id,role,CASE WHEN length(CAST(content AS BLOB)) <= ?3 THEN content ELSE NULL END,tool_calls,tool_call_id,active FROM messages WHERE session_id=?1 ORDER BY id LIMIT ?2")?;
        let mut rows = query.query(rusqlite::params![
            id,
            plan.expected.turns.len().saturating_add(usize::from(exact)) as i64,
            MAX_OUTPUT as i64
        ])?;
        let mut actual = plan.expected.clone();
        actual.turns.clear();
        actual.losses.clear();
        let mut total = 0usize;
        while let Some(row) = rows.next()? {
            let role: String = row.get(1)?;
            let role = match role.as_str() {
                "user" => agentkib_conversations::SessionRole::User,
                "assistant" => agentkib_conversations::SessionRole::Assistant,
                _ => anyhow::bail!("Unexpected Hermes imported role"),
            };
            let text: String = row.get(2)?;
            total = total.saturating_add(text.len());
            anyhow::ensure!(
                total as u64 <= MAX_OUTPUT,
                "Hermes imported history exceeds limit"
            );
            let tools: Option<String> = row.get(3)?;
            let call: Option<String> = row.get(4)?;
            let active: i64 = row.get(5)?;
            anyhow::ensure!(
                tools
                    .as_deref()
                    .is_none_or(|value| value == "[]" || value == "null")
                    && call.is_none()
                    && active == 1,
                "Hermes imported tool or hidden record differs from preview"
            );
            actual.turns.push(agentkib_conversations::SessionTurn {
                id: row.get::<_, i64>(0)?.to_string(),
                role,
                timestamp: None,
                blocks: vec![agentkib_conversations::SessionBlock::Text { text }],
            });
        }
        validate_native_import_document(&plan.expected, &actual)?;
    }
    Ok(id.clone())
}

pub(super) fn execute(
    request: &ImportRequest,
    approve_home: bool,
    reopen: bool,
) -> anyhow::Result<HandoffContinuationResult> {
    let (directory, plan) = read_plan(request)?;
    if plan.target_agent == AgentKind::Cursor {
        return execute_cursor(request, &directory, &plan, approve_home, reopen);
    }
    let workspace = Store::open_default()?.workspace_path(&request.workspace_id)?;
    anyhow::ensure!(
        agentkib_core::canonical_project(&workspace)? == plan.workspace,
        "Import workspace changed"
    );
    anyhow::ensure!(
        capture_environment()? == plan.environment,
        "Target storage environment changed after preview"
    );
    let (executable, version) = installation(plan.target_agent)?;
    anyhow::ensure!(
        executable == plan.executable && version == plan.version,
        "Target installation changed after preview"
    );
    let (current_model, current_home, current_profile) =
        target_settings(plan.target_agent, &executable, &plan.workspace)?;
    anyhow::ensure!(
        current_model == plan.model
            && current_home == plan.target_home
            && current_profile == plan.target_profile,
        "Target configuration changed after preview"
    );
    if plan.target_agent == AgentKind::OpenClaw {
        anyhow::ensure!(
            plan.openclaw.as_ref() == Some(&openclaw::context(&executable, &plan.workspace)?),
            "OpenClaw installation or storage changed after preview"
        );
    }
    let receipt_path = directory.join("receipt.json");
    let mut receipt = if receipt_path.exists() {
        let value: Receipt = serde_json::from_slice(&read_bounded(&receipt_path)?)?;
        anyhow::ensure!(
            value.schema_version == 1
                && value.plan_hash == request.plan_hash
                && receipt_identity_valid(&plan, &value.target_session_id),
            "Import receipt mismatch"
        );
        value
    } else {
        Receipt {
            schema_version: 1,
            plan_hash: request.plan_hash.clone(),
            target_session_id: plan.target_session_id.clone(),
            verified: false,
            launched: false,
            terminal: None,
        }
    };
    if !receipt.verified {
        anyhow::ensure!(approve_home, "Native import requires Agent Home approval");
        let attempted = directory.join("attempted.json");
        safe_path(&attempted)?;
        let previously_attempted = attempted.exists();
        if !previously_attempted {
            anyhow::ensure!(
                !reopen,
                "Import has not started; prepare and approve a new import preview"
            );
            // Check the immutable source immediately before first mutation.
            let (source, mut document) = load_session_document(&plan.source_session_id)?;
            let store = Store::open_default()?;
            let source_workspace = continuation_workspace_id(&store, &source.workspace_id)?;
            anyhow::ensure!(
                source_workspace == plan.workspace_id,
                "Import source workspace changed"
            );
            use_continuation_workspace_id(&mut document, &source_workspace);
            anyhow::ensure!(
                fingerprint(&document)? == plan.source_fingerprint,
                "Source changed after import preview"
            );
            anyhow::ensure!(
                !STOPPING.load(Ordering::SeqCst),
                "Continuation worker is shutting down"
            );
            let payload_path = directory.join("payload.json");
            if payload_path.exists() {
                anyhow::ensure!(
                    read_bounded(&payload_path)? == plan.payload.as_bytes(),
                    "Import payload changed"
                );
            } else {
                create_file(&payload_path, plan.payload.as_bytes())?;
            }
            if plan.target_agent == AgentKind::OpenClaw {
                openclaw::ready(&plan, &payload_path)?;
            }
            create_file(&attempted, request.plan_hash.as_bytes())?;
            // Never retry this mutation, including when the command reports a failure:
            // importers can commit part or all of their data before failing.
            if plan.target_agent == AgentKind::OpenClaw {
                let _outcome = openclaw::run(&plan, &payload_path, true);
            } else {
                let arguments = if plan.target_agent == AgentKind::Hermes {
                    vec![
                        "--profile".into(),
                        plan.target_profile
                            .as_ref()
                            .context("Hermes profile missing")?
                            .into(),
                        "sessions".into(),
                        "import".into(),
                        "--from".into(),
                        "claude".into(),
                        payload_path.into_os_string(),
                    ]
                } else {
                    vec!["import".into(), payload_path.into_os_string()]
                };
                let _outcome = command(
                    &plan.executable,
                    &arguments,
                    Some(&plan.workspace),
                    COMMAND_TIMEOUT,
                );
            }
        }
        receipt.target_session_id = verify(&plan, &directory, None, !previously_attempted).context("Native import is incomplete or outcome unknown; preserved operation for reconciliation, not retried")?;
        receipt.verified = true;
        save_receipt(&directory, &receipt)?;
    }
    if receipt.launched && !reopen {
        return Ok(HandoffContinuationResult::Launched {
            receipt: HandoffLaunchReceipt {
                target_agent: plan.target_agent,
                terminal: receipt
                    .terminal
                    .unwrap_or_else(|| "previously-opened".into()),
            },
        });
    }
    verify(
        &plan,
        &directory,
        Some(&receipt.target_session_id),
        !receipt.launched && !reopen,
    )?;
    // A resumed session can grow after import; compare its reviewed prefix before
    // first launch only. Subsequent opens use the durable verified session ID.
    anyhow::ensure!(
        !STOPPING.load(Ordering::SeqCst),
        "Continuation worker is shutting down"
    );
    let interactive = if plan.target_agent == AgentKind::OpenClaw {
        openclaw::interactive(&plan)?
    } else {
        agentkib_platform::terminal::InteractiveCommand {
            executable: plan.executable,
            arguments: if plan.target_agent == AgentKind::Hermes {
                vec![
                    "--profile".into(),
                    plan.target_profile
                        .as_ref()
                        .context("Hermes profile missing")?
                        .into(),
                    "--resume".into(),
                    receipt.target_session_id.clone().into(),
                ]
            } else {
                let model = plan.model.as_ref().context("OpenCode model missing")?;
                vec![
                    "--session".into(),
                    receipt.target_session_id.clone().into(),
                    "--model".into(),
                    format!("{}/{}", model.provider_id, model.model_id).into(),
                ]
            },
            working_directory: plan.workspace,
            environment: plan
                .environment
                .iter()
                .map(|(key, value)| (key.into(), value.as_ref().map(OsString::from)))
                .collect(),
        }
    };
    match agentkib_platform::terminal::launch_interactive_command(&interactive) {
        Ok(launched) => {
            receipt.launched = true;
            receipt.terminal = Some(launched.terminal.clone());
            save_receipt(&directory, &receipt)?;
            Ok(HandoffContinuationResult::Launched {
                receipt: HandoffLaunchReceipt {
                    target_agent: plan.target_agent,
                    terminal: launched.terminal,
                },
            })
        }
        Err(error) => Ok(HandoffContinuationResult::AppliedLaunchFailed {
            error: json!({"key":"errors.handoff.launchAfterApplyFailed","params":{},"detail":error.to_string()}),
        }),
    }
}

fn command(
    executable: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        executable.is_absolute(),
        "Importer executable must be absolute"
    );
    anyhow::ensure!(
        !STOPPING.load(Ordering::SeqCst),
        "Continuation worker is shutting down"
    );
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    configure_process_group(&mut cmd);
    let mut child = cmd.spawn()?;
    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    };
    let stdout = child.stdout.take().context("Importer stdout unavailable")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + timeout;
    let result = loop {
        if STOPPING.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break Err(anyhow::anyhow!(
                "Import command interrupted; reconcile target before any retry"
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("Import command exited unsuccessfully"))
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error.into()),
        }
    };
    let _ = tree.terminate();
    let _ = child.wait();
    result?;
    let bytes = rx
        .recv_timeout(Duration::from_millis(250))
        .context("Import output did not close")??;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_OUTPUT,
        "Import output exceeds size limit"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_conversations::{SessionBlock, SessionDocumentSource, SessionRole, SessionTurn};
    use rusqlite::params;

    fn fixture(root: &Path) -> (Plan, PathBuf, rusqlite::Connection, String) {
        let root = fs::canonicalize(root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let directory = root.join("operation");
        fs::create_dir(&directory).unwrap();
        let home = root.join("hermes");
        fs::create_dir(&home).unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        let document = SessionDocument {
            schema_version: 1,
            source: SessionDocumentSource {
                agent: AgentKind::Codex,
                workspace_id: "workspace".into(),
                title: Some("synthetic".into()),
                created_at: None,
                updated_at: None,
                git_branch: None,
            },
            turns: vec![
                SessionTurn {
                    id: "user".into(),
                    role: SessionRole::User,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Marker E9JQ. Use SQLite.".into(),
                    }],
                },
                SessionTurn {
                    id: "assistant".into(),
                    role: SessionRole::Assistant,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Confirmed SQLite.".into(),
                    }],
                },
            ],
            losses: vec![],
            redaction_count: 0,
        };
        let prepared =
            prepare_native_import(AgentKind::Hermes, &document, &operation, &workspace, None)
                .unwrap();
        let plan = Plan {
            schema_version: 1,
            operation_id: operation.clone(),
            workspace_id: "workspace".into(),
            workspace,
            source_session_id: "source".into(),
            source_fingerprint: fingerprint(&document).unwrap(),
            target_agent: AgentKind::Hermes,
            executable: root.join("hermes-cli"),
            version: "0.21.5".into(),
            model: None,
            target_home: Some(home.clone()),
            target_profile: Some("default".into()),
            environment: STORAGE_ENVIRONMENT
                .iter()
                .map(|key| ((*key).into(), None))
                .collect(),
            openclaw: None,
            cursor: None,
            target_session_id: operation,
            document,
            expected: prepared.expected,
            payload: prepared.payload,
        };
        let conn = rusqlite::Connection::open(home.join("state.db")).unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,origin_json TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,tool_call_id TEXT,active INTEGER);").unwrap();
        let id = "20260927_123456_a1b2c3".to_owned();
        insert_target(&conn, &plan, &directory, &id);
        (plan, directory, conn, id)
    }

    fn insert_target(conn: &rusqlite::Connection, plan: &Plan, directory: &Path, id: &str) {
        let origin=json!({"imported_from":{"tool":"claude-code","path":directory.join("payload.json"),"foreign_session_id":plan.operation_id}}).to_string();
        conn.execute(
            "INSERT INTO sessions(id,cwd,origin_json) VALUES (?,?,?)",
            params![id, plan.workspace.to_str().unwrap(), origin],
        )
        .unwrap();
        for turn in &plan.expected.turns {
            let role = if turn.role == SessionRole::User {
                "user"
            } else {
                "assistant"
            };
            let SessionBlock::Text { text } = &turn.blocks[0] else {
                panic!()
            };
            conn.execute(
                "INSERT INTO messages(session_id,role,content,active) VALUES (?,?,?,1)",
                params![id, role, text],
            )
            .unwrap();
        }
    }

    #[test]
    fn hermes_reconciles_exact_origin_after_lost_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let (plan, directory, _conn, id) = fixture(temp.path());
        assert_eq!(verify_hermes(&plan, &directory, None, true).unwrap(), id);
        assert_eq!(
            verify_hermes(&plan, &directory, Some(&id), true).unwrap(),
            id
        );
        assert!(verify_hermes(&plan, &directory, Some("20260927_123456_ffffff"), true).is_err());
    }

    #[test]
    fn hermes_reconciliation_refuses_missing_and_ambiguous_identity() {
        let temp = tempfile::tempdir().unwrap();
        let (plan, directory, conn, id) = fixture(temp.path());
        conn.execute("UPDATE sessions SET origin_json='{}'", [])
            .unwrap();
        assert!(verify_hermes(&plan, &directory, None, true).is_err());
        conn.execute("DELETE FROM sessions", []).unwrap();
        conn.execute("DELETE FROM messages", []).unwrap();
        insert_target(&conn, &plan, &directory, &id);
        insert_target(&conn, &plan, &directory, "20260927_123457_a1b2c3");
        assert!(verify_hermes(&plan, &directory, None, true).is_err());
    }

    #[test]
    fn hermes_readback_refuses_altered_hidden_and_executable_history() {
        for statement in [
            "UPDATE messages SET content='changed' WHERE role='user'",
            "UPDATE messages SET active=0 WHERE role='user'",
            "UPDATE messages SET tool_calls='[{\"name\":\"bash\"}]' WHERE role='assistant'",
            "UPDATE messages SET role='user' WHERE role='assistant'",
            "UPDATE sessions SET cwd='/other-project'",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let (plan, directory, conn, _id) = fixture(temp.path());
            conn.execute(statement, []).unwrap();
            assert!(
                verify_hermes(&plan, &directory, None, true).is_err(),
                "{statement}"
            );
        }
    }

    #[test]
    fn hermes_reopen_allows_appended_turns_but_requires_intact_reviewed_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let (plan, directory, conn, id) = fixture(temp.path());
        conn.execute(
            "INSERT INTO messages(session_id,role,content,active) VALUES (?,'user','follow-up',1)",
            params![id],
        )
        .unwrap();
        assert!(verify_hermes(&plan, &directory, Some(&id), true).is_err());
        assert!(verify_hermes(&plan, &directory, Some(&id), false).is_ok());
        conn.execute("UPDATE messages SET content='mutated' WHERE id=1", [])
            .unwrap();
        assert!(verify_hermes(&plan, &directory, Some(&id), false).is_err());
    }

    #[test]
    fn hermes_reopen_rejects_native_resume_redirects_with_unchanged_parent_history() {
        let temp = tempfile::tempdir().unwrap();
        let (plan, directory, conn, id) = fixture(temp.path());
        conn.execute(
            "INSERT INTO sessions(id,parent_session_id) VALUES ('continuation',?1)",
            [&id],
        )
        .unwrap();
        conn.execute("INSERT INTO messages(session_id,role,content,active) VALUES ('continuation','user','different context',1)", []).unwrap();
        for exact in [true, false] {
            assert!(
                verify_hermes(&plan, &directory, Some(&id), exact)
                    .unwrap_err()
                    .to_string()
                    .contains("resume identity")
            );
        }
        conn.execute("DELETE FROM sessions WHERE id='continuation'", [])
            .unwrap();
        conn.execute(
            "UPDATE sessions SET parent_session_id='external-parent' WHERE id=?1",
            [&id],
        )
        .unwrap();
        assert!(verify_hermes(&plan, &directory, Some(&id), false).is_err());
    }

    #[test]
    fn plan_validation_rejects_payload_or_target_substitution() {
        let temp = tempfile::tempdir().unwrap();
        let (mut plan, _directory, _conn, _id) = fixture(temp.path());
        validate_plan(&plan, "workspace").unwrap();
        let original = plan.document.clone();
        plan.document.source.title = Some("changed after review".into());
        assert!(validate_plan(&plan, "workspace").is_err());
        plan.document = original;
        plan.payload.push(' ');
        assert!(validate_plan(&plan, "workspace").is_err());
        plan.payload.pop();
        plan.target_session_id = uuid::Uuid::new_v4().to_string();
        assert!(validate_plan(&plan, "workspace").is_err());
    }

    #[test]
    fn storage_environment_does_not_accept_extra_variables_or_control_characters() {
        let mut values = STORAGE_ENVIRONMENT
            .iter()
            .map(|key| ((*key).into(), None))
            .collect::<Vec<(String, Option<String>)>>();
        validate_environment(&values).unwrap();
        values[0].1 = Some("/tmp/home\nINJECTED=yes".into());
        assert!(validate_environment(&values).is_err());
        values[0].1 = None;
        let inline_index = values
            .iter()
            .position(|(key, _)| key == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        assert_eq!(values[inline_index].1, None);
        values[inline_index].1 = Some("inline-content-must-not-be-journaled".into());
        assert!(validate_environment(&values).is_err());
        values[inline_index].1 = None;
        values.push(("API_KEY".into(), Some("not-a-real-key".into())));
        assert!(validate_environment(&values).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn hermes_refuses_symlink_database() {
        let temp = tempfile::tempdir().unwrap();
        let (plan, directory, conn, _id) = fixture(temp.path());
        drop(conn);
        let database = plan.target_home.as_ref().unwrap().join("state.db");
        let other = database.with_file_name("external.db");
        fs::rename(&database, &other).unwrap();
        std::os::unix::fs::symlink(other, &database).unwrap();
        assert!(verify_hermes(&plan, &directory, None, true).is_err());
    }
}

pub(super) fn cursor_fingerprint(context: &cursor_bridge::Context) -> anyhow::Result<String> {
    cursor_bridge::validate_context(context)?;
    Ok(agentkib_core::hash_content(&serde_json::to_vec(context)?))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn plan_cursor(
    workspace: &Path,
    workspace_id: &str,
    source_session_id: &str,
    source_fingerprint: &str,
    document: &SessionDocument,
    capabilities: ContinuationCapabilities,
    context: cursor_bridge::Context,
) -> anyhow::Result<PlannedSessionHandoff> {
    let workspace = agentkib_core::canonical_project(workspace)?;
    anyhow::ensure!(
        context.profile.workspace == workspace,
        "Cursor profile workspace mismatch"
    );
    cursor_bridge::validate_context(&context)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let prepared = agentkib_conversations::cursor_ide::prepare_cursor_ide_import(
        document,
        &operation_id,
        &workspace,
    )?;
    let plan = Plan {
        schema_version: 1,
        operation_id: operation_id.clone(),
        workspace_id: workspace_id.into(),
        workspace: workspace.clone(),
        source_session_id: source_session_id.into(),
        source_fingerprint: source_fingerprint.into(),
        target_agent: AgentKind::Cursor,
        executable: context.app_root.clone(),
        version: cursor_bridge::VERSION.into(),
        model: None,
        target_home: None,
        target_profile: None,
        environment: vec![],
        openclaw: None,
        cursor: Some(context),
        target_session_id: operation_id.clone(),
        document: document.clone(),
        expected: prepared.expected,
        payload: prepared.payload,
    };
    let content = serde_json::to_string_pretty(&plan)?;
    let path = directory(workspace_id, &operation_id)?.join("plan.json");
    safe_path(&path)?;
    anyhow::ensure!(!path.exists(), "Cursor import operation already exists");
    Ok(PlannedSessionHandoff {
        change_set: ChangeSet {
            id: operation_id.clone(),
            project_root: workspace,
            created_at: Utc::now(),
            requires_home_approval: true,
            changes: vec![FileChange {
                target: path,
                scope: ChangeScope::ApplicationData,
                original_hash: None,
                before: String::new(),
                after: content.clone(),
                risk: RiskLevel::High,
                validator: "json".into(),
            }],
        },
        launch_request: SessionHandoffLaunchRequest::NativeImport(ImportRequest {
            operation_id,
            workspace_id: workspace_id.into(),
            target_agent: AgentKind::Cursor,
            plan_hash: agentkib_core::hash_content(content.as_bytes()),
            capabilities: Some(capabilities),
        }),
    })
}

fn validate_cursor_plan(plan: &Plan) -> anyhow::Result<()> {
    let context = plan
        .cursor
        .as_ref()
        .context("Cursor import context missing")?;
    cursor_bridge::validate_context(context)?;
    anyhow::ensure!(
        context.profile.workspace == plan.workspace
            && plan.version == cursor_bridge::VERSION
            && plan.executable == context.app_root
            && plan.target_session_id == plan.operation_id
            && plan.model.is_none()
            && plan.target_home.is_none()
            && plan.target_profile.is_none()
            && plan.environment.is_empty()
            && plan.openclaw.is_none()
            && plan.document.source.workspace_id == plan.workspace_id,
        "Cursor import identity or settings mismatch"
    );
    let prepared = agentkib_conversations::cursor_ide::prepare_cursor_ide_import(
        &plan.document,
        &plan.operation_id,
        &plan.workspace,
    )?;
    anyhow::ensure!(
        agentkib_conversations::cursor_ide::reviewed_cursor_ide_import_payload_matches(
            &prepared.payload,
            &plan.payload,
        )? && prepared.expected == plan.expected,
        "Cursor import payload differs from its approved document"
    );
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorAttempt {
    schema_version: u32,
    plan_hash: String,
    before_native_ids: Vec<String>,
}

fn execute_cursor(
    request: &ImportRequest,
    directory: &Path,
    plan: &Plan,
    approve_home: bool,
    reopen: bool,
) -> anyhow::Result<HandoffContinuationResult> {
    use agentkib_conversations::cursor_ide::{
        list_cursor_ide_identities, verify_cursor_ide_import,
    };
    let frozen = plan
        .cursor
        .as_ref()
        .context("Cursor import context unavailable")?;
    let workspace = agentkib_core::canonical_project(
        &Store::open_default()?.workspace_path(&request.workspace_id)?,
    )?;
    anyhow::ensure!(
        workspace == plan.workspace,
        "Cursor import workspace changed"
    );
    let context = cursor_bridge::context(&frozen.binding_id, &workspace)?;
    anyhow::ensure!(&context == frozen, "Cursor binding changed after preview");
    let attempted = directory.join("attempted.json");
    let receipt_path = directory.join("receipt.json");
    let mut receipt = if receipt_path.exists() {
        let value: Receipt = serde_json::from_slice(&read_bounded(&receipt_path)?)?;
        anyhow::ensure!(
            value.schema_version == 1
                && value.plan_hash == request.plan_hash
                && receipt_identity_valid(plan, &value.target_session_id),
            "Cursor receipt mismatch"
        );
        value
    } else {
        Receipt {
            schema_version: 1,
            plan_hash: request.plan_hash.clone(),
            target_session_id: String::new(),
            verified: false,
            launched: false,
            terminal: None,
        }
    };
    let attempt = if attempted.exists() {
        let value: CursorAttempt = serde_json::from_slice(&read_bounded(&attempted)?)?;
        anyhow::ensure!(
            value.schema_version == 1 && value.plan_hash == request.plan_hash,
            "Cursor attempt fingerprint mismatch"
        );
        value
    } else {
        anyhow::ensure!(
            !reopen && approve_home,
            "Cursor import requires a reviewed plan and explicit approval"
        );
        let (source, mut document) = load_session_document(&plan.source_session_id)?;
        let store = Store::open_default()?;
        let source_workspace = continuation_workspace_id(&store, &source.workspace_id)?;
        use_continuation_workspace_id(&mut document, &source_workspace);
        anyhow::ensure!(
            source_workspace == plan.workspace_id
                && fingerprint(&document)? == plan.source_fingerprint,
            "Source changed after Cursor preview"
        );
        anyhow::ensure!(
            !STOPPING.load(Ordering::SeqCst) && !remaining().is_zero(),
            "Cursor import executor is stopping or timed out"
        );
        let value = CursorAttempt {
            schema_version: 1,
            plan_hash: request.plan_hash.clone(),
            before_native_ids: list_cursor_ide_identities(&context.profile)?
                .into_iter()
                .map(|i| i.native_id)
                .collect(),
        };
        create_file(&attempted, &serde_json::to_vec(&value)?)?;
        // Durable marker precedes dispatch. Failure here can only be reconciled, never resent.
        let dispatched = cursor_bridge::call(
            &context,
            "import",
            json!({"operation_id":plan.operation_id,"plan_hash":request.plan_hash,"payload":plan.payload,"payload_hash":agentkib_core::hash_content(plan.payload.as_bytes())}),
        );
        if dispatched.is_err() {
            return Ok(cursor_unknown(
                "Cursor importer disconnected; reconnect this window and reconcile the existing operation",
            ));
        }
        value
    };
    let marker = format!("AgentKib {}", plan.operation_id);
    loop {
        let known =
            (!receipt.target_session_id.is_empty()).then_some(receipt.target_session_id.as_str());
        match verify_cursor_ide_import(
            &context.profile,
            &plan.payload,
            &plan.expected,
            &marker,
            known,
            &attempt.before_native_ids,
            !receipt.verified,
        ) {
            Ok(id) => {
                receipt.target_session_id = id;
                receipt.verified = true;
                save_receipt(directory, &receipt)?;
                break;
            }
            Err(error) => {
                if STOPPING.load(Ordering::SeqCst) || remaining().is_zero() {
                    return Ok(cursor_unknown(&error.to_string()));
                }
                if attempted.exists() && reopen {
                    return Ok(cursor_unknown(&error.to_string()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    if receipt.launched && !reopen {
        return Ok(HandoffContinuationResult::Launched {
            receipt: HandoffLaunchReceipt {
                target_agent: AgentKind::Cursor,
                terminal: "Cursor IDE".into(),
            },
        });
    }
    if let Err(error) = cursor_bridge::call(
        &context,
        "open",
        json!({"native_id":receipt.target_session_id}),
    ) {
        return Ok(HandoffContinuationResult::AppliedLaunchFailed {
            error: json!({"detail":error.to_string()}),
        });
    }
    receipt.launched = true;
    receipt.terminal = Some("Cursor IDE".into());
    save_receipt(directory, &receipt)?;
    Ok(HandoffContinuationResult::Launched {
        receipt: HandoffLaunchReceipt {
            target_agent: AgentKind::Cursor,
            terminal: "Cursor IDE".into(),
        },
    })
}

fn cursor_unknown(detail: &str) -> HandoffContinuationResult {
    HandoffContinuationResult::ImportOutcomeUnknown {
        error: json!({"detail":detail}),
    }
}
