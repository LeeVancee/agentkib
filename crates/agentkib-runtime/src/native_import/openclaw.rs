//! Fixed-version OpenClaw offline import through its own transactional writer.
use super::*;
use anyhow::Context as _;

const VERSION: &str = "2026.9.6";
const ENVIRONMENT: &[&str] = &[
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_HOME",
    "OPENCLAW_PROFILE",
    "OPENCLAW_INCLUDE_ROOTS",
    "NODE_OPTIONS",
    "NODE_PATH",
];
const MODULES: &[&str] = &[
    "agents.config-G5R7b0ly.mjs",
    "io.runtime-hPN4FOBi.mjs",
    "openclaw-agent-db.paths-C2YxM4Tj.mjs",
    "openclaw-state-db.paths-DYMh54HD.mjs",
    "embedded-state-lock-Cw9nQxv5.mjs",
    "openclaw-agent-db-CaQAStOA.mjs",
    "session-accessor.sqlite-entry-store-DTntRuil.mjs",
    "session-accessor.sqlite-transcript-store-CFksbmAY.mjs",
    "session-accessor.sqlite-read-DG0i0-yW.mjs",
    "openclaw-agent-db-readonly-IBx2zWDG.mjs",
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Context {
    node: PathBuf,
    node_version: String,
    package: PathBuf,
    package_fingerprint: String,
    agent_id: String,
    agent_dir: PathBuf,
    state_database: PathBuf,
    config_fingerprint: String,
    config_path: PathBuf,
    environment: Vec<(String, Option<String>)>,
}

pub(super) fn installation() -> anyhow::Result<(PathBuf, String)> {
    let executable =
        agentkib_platform::command::resolve("openclaw").context("OpenClaw CLI is unavailable")?;
    let executable = fs::canonicalize(executable)?;
    let package = executable
        .parent()
        .context("OpenClaw package is unavailable")?;
    let metadata: Value = serde_json::from_slice(&fs::read(package.join("package.json"))?)?;
    anyhow::ensure!(
        metadata["name"] == "openclaw"
            && metadata["version"] == VERSION
            && executable.file_name().is_some_and(|n| n == "openclaw.mjs"),
        "Native OpenClaw import requires the verified 2026.9.6 npm installation"
    );
    Ok((executable, VERSION.into()))
}

fn environment() -> anyhow::Result<Vec<(String, Option<String>)>> {
    let values = ENVIRONMENT
        .iter()
        .map(|key| {
            Ok((
                (*key).into(),
                std::env::var_os(key)
                    .map(|v| {
                        v.into_string()
                            .map_err(|_| anyhow::anyhow!("OpenClaw environment is not UTF-8"))
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
        values.len() == ENVIRONMENT.len(),
        "Incomplete OpenClaw environment"
    );
    for ((key, value), allowed) in values.iter().zip(ENVIRONMENT) {
        anyhow::ensure!(
            key == allowed
                && value
                    .as_ref()
                    .is_none_or(|v| !v.contains(['\0', '\n', '\r'])),
            "Invalid OpenClaw environment"
        );
        if key.starts_with("NODE_") {
            anyhow::ensure!(
                value.as_ref().is_none_or(|v| v.is_empty()),
                "Node injection environment is not supported for native import"
            );
        }
    }
    Ok(())
}
pub(super) fn context(executable: &Path, workspace: &Path) -> anyhow::Result<Context> {
    let environment = environment()?;
    let node = fs::canonicalize(
        agentkib_platform::command::resolve("node").context("OpenClaw requires Node")?,
    )?;
    let node_version = String::from_utf8(command(
        &node,
        &["--version".into()],
        None,
        Duration::from_secs(3),
    )?)?
    .trim()
    .to_owned();
    let package = executable
        .parent()
        .context("OpenClaw package missing")?
        .to_path_buf();
    let mut hashes = Vec::new();
    for name in MODULES {
        let path = package.join("dist").join(name);
        anyhow::ensure!(
            fs::canonicalize(&path)?.starts_with(&package),
            "OpenClaw module escapes installation"
        );
        hashes.push(agentkib_core::hash_content(&fs::read(path)?));
    }
    hashes.push(agentkib_core::hash_content(&fs::read(
        package.join("package.json"),
    )?));
    // Avoid `agents list --json`: its provenance worker can migrate storage.
    // Use the same official config-derived inventory with observation disabled.
    let storage_script = "import {pathToFileURL} from 'node:url'; const {s:path}=await import(pathToFileURL(process.argv[1]+'/dist/openclaw-state-db.paths-DYMh54HD.mjs')); console.log(JSON.stringify(path(process.env)));";
    let storage = command(
        &node,
        &[
            "--input-type=module".into(),
            "-e".into(),
            storage_script.into(),
            package.clone().into_os_string(),
        ],
        None,
        Duration::from_secs(3),
    )?;
    let state_database = PathBuf::from(serde_json::from_slice::<String>(&storage)?);
    preflight_global(&state_database)?;
    let inventory_script = r#"
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const get=n=>import(pathToFileURL(process.argv[1]+'/dist/'+n));
const {c:read}=await get('io.runtime-hPN4FOBi.mjs');
const {n:summaries}=await get('agents.config-G5R7b0ly.mjs');
const snapshot=await read({observe:false,skipPluginValidation:true,isolateEnv:true});
if(!snapshot.exists||!snapshot.valid)throw Error('Valid configured OpenClaw agent required');
console.log(JSON.stringify({entries:summaries(snapshot.config),path:snapshot.path,fingerprint:createHash('sha256').update(JSON.stringify(snapshot.config)).digest('hex')}));
"#;
    let output = command(
        &node,
        &[
            "--input-type=module".into(),
            "-e".into(),
            inventory_script.into(),
            package.clone().into_os_string(),
        ],
        Some(workspace),
        COMMAND_TIMEOUT,
    )?;
    let inventory: Value =
        serde_json::from_slice(&output).context("OpenClaw agent inventory is unavailable")?;
    let entries = inventory["entries"]
        .as_array()
        .context("OpenClaw inventory missing")?;
    let config_fingerprint = inventory["fingerprint"]
        .as_str()
        .context("OpenClaw configuration fingerprint missing")?
        .to_owned();
    let config_path = PathBuf::from(
        inventory["path"]
            .as_str()
            .context("OpenClaw configuration path missing")?,
    );
    ensure_native_path(&config_path)?;
    let matches = entries
        .iter()
        .filter(|entry| {
            entry["workspace"]
                .as_str()
                .and_then(|p| fs::canonicalize(p).ok())
                .is_some_and(|p| p == workspace)
        })
        .collect::<Vec<_>>();
    anyhow::ensure!(
        matches.len() == 1,
        "OpenClaw needs exactly one configured agent for this workspace"
    );
    let entry = matches[0];
    let agent_id = entry["id"]
        .as_str()
        .context("OpenClaw agent ID missing")?
        .to_owned();
    anyhow::ensure!(
        !agent_id.is_empty()
            && agent_id.len() <= 64
            && agent_id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
        "Invalid OpenClaw agent ID"
    );
    let agent_dir = PathBuf::from(
        entry["agentDir"]
            .as_str()
            .context("OpenClaw agent directory missing")?,
    );
    ensure_native_path(&agent_dir)?;
    let agent_dir = fs::canonicalize(agent_dir)?;
    let context = Context {
        node,
        node_version,
        package,
        package_fingerprint: agentkib_core::hash_content(&serde_json::to_vec(&hashes)?),
        agent_id,
        agent_dir,
        state_database,
        config_fingerprint,
        config_path,
        environment,
    };
    context.validate()?;
    preflight(&context)?;
    Ok(context)
}
impl Context {
    pub(super) fn validate(&self) -> anyhow::Result<()> {
        validate_environment(&self.environment)?;
        anyhow::ensure!(
            self.node.is_absolute()
                && self.package.is_absolute()
                && self.agent_dir.is_absolute()
                && self.state_database.is_absolute()
                && self.config_path.is_absolute()
                && self.config_fingerprint.len() == 64
                && self.package_fingerprint.len() == 64
                && !self.agent_id.is_empty()
                && self.agent_id.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'_'),
            "Invalid OpenClaw context"
        );
        Ok(())
    }
    fn key(&self, id: &str) -> String {
        format!("agent:{}:agentkib:{id}", self.agent_id)
    }
}
fn preflight_global(path: &Path) -> anyhow::Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        ensure_native_path(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    let global =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    global.busy_timeout(Duration::from_millis(500))?;
    let global_version: i64 = global.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let global_valid: bool = global.query_row("SELECT role='global' AND schema_version=18 AND app_version=?1 FROM schema_meta WHERE meta_key='primary'", [VERSION], |r| r.get(0))?;
    anyhow::ensure!(
        global_version == 18 && global_valid,
        "OpenClaw global database requires official migration before import"
    );
    Ok(())
}
fn preflight(context: &Context) -> anyhow::Result<()> {
    let path = context.agent_dir.join("openclaw-agent.sqlite");
    for suffix in ["", "-wal", "-shm", "-journal"] {
        ensure_native_path(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    let root = context
        .agent_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context("Invalid OpenClaw agent directory")?;
    anyhow::ensure!(
        context.agent_dir == root.join("agents").join(&context.agent_id).join("agent"),
        "Nonstandard OpenClaw agent directory is not verified"
    );
    let global = root.join("state/openclaw.sqlite");
    anyhow::ensure!(
        global == context.state_database,
        "OpenClaw environment and agent directory disagree"
    );
    preflight_global(&global)?;
    // Never let the writer create or migrate an older user's store implicitly.
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(500))?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let valid: bool = db.query_row("SELECT role='agent' AND schema_version=23 AND agent_id=?1 AND app_version=?2 FROM schema_meta WHERE meta_key='primary'", rusqlite::params![context.agent_id, VERSION], |r| r.get(0))?;
    anyhow::ensure!(
        version == 23 && valid,
        "OpenClaw requires an existing current agent database; migrate with OpenClaw first"
    );
    Ok(())
}

pub(super) fn ready(plan: &Plan, payload: &Path) -> anyhow::Result<()> {
    bridge(plan, payload, false, true).context("OpenClaw import requires the local Gateway to be stopped and current local database ownership")?;
    Ok(())
}
pub(super) fn run(plan: &Plan, payload: &Path, write: bool) -> anyhow::Result<Value> {
    bridge(plan, payload, write, false)
}
fn bridge(plan: &Plan, payload: &Path, write: bool, probe: bool) -> anyhow::Result<Value> {
    let context = plan
        .openclaw
        .as_ref()
        .context("OpenClaw target context missing")?;
    preflight(context)?;
    anyhow::ensure!(
        read_bounded(payload)? == plan.payload.as_bytes(),
        "OpenClaw payload changed after preview"
    );
    let input = json!({"context":context,"id":plan.target_session_id,"key":context.key(&plan.target_session_id),"workspace":plan.workspace,"payload":payload,"payload_hash":agentkib_core::hash_content(plan.payload.as_bytes()),"write":write,"probe":probe});
    let output = command(
        &context.node,
        &[
            "--input-type=module".into(),
            "-e".into(),
            BRIDGE.into(),
            serde_json::to_string(&input)?.into(),
        ],
        Some(&plan.workspace),
        COMMAND_TIMEOUT,
    )?;
    Ok(serde_json::from_slice(&output)?)
}
pub(super) fn verify(plan: &Plan, directory: &Path, exact: bool) -> anyhow::Result<String> {
    let output = run(plan, &directory.join("payload.json"), false)?;
    let actual = output["events"]
        .as_array()
        .context("OpenClaw history unavailable")?;
    let expected: Vec<Value> = serde_json::from_str(&plan.payload)?;
    anyhow::ensure!(
        actual.len() >= expected.len()
            && (!exact || actual.len() == expected.len())
            && actual.iter().zip(&expected).all(|(a, b)| a == b),
        "OpenClaw imported history differs from reviewed events"
    );
    let generation = output["generation"]
        .as_str()
        .filter(|v| !v.is_empty())
        .context("OpenClaw generation missing")?;
    let path = directory.join("openclaw-generation");
    if path.exists() {
        anyhow::ensure!(
            read_bounded(&path)? == generation.as_bytes(),
            "OpenClaw target transcript generation changed"
        );
    } else {
        create_file(&path, generation.as_bytes())?;
    }
    Ok(plan.target_session_id.clone())
}
pub(super) fn interactive(
    plan: &Plan,
) -> anyhow::Result<agentkib_platform::terminal::InteractiveCommand> {
    let context = plan.openclaw.as_ref().context("OpenClaw context missing")?;
    let environment = plan
        .environment
        .iter()
        .chain(&context.environment)
        .map(|(k, v)| (k.into(), v.as_ref().map(OsString::from)))
        .collect();
    Ok(agentkib_platform::terminal::InteractiveCommand {
        executable: context.node.clone(),
        arguments: vec![
            plan.executable.clone().into_os_string(),
            "tui".into(),
            "--local".into(),
            "--session".into(),
            context.key(&plan.target_session_id).into(),
        ],
        working_directory: plan.workspace.clone(),
        environment,
    })
}

// The package modules and symbols are pinned above. All database writes below
// are official writer calls under OpenClaw's own lifecycle/state lock.
const BRIDGE: &str = r#"
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const p=JSON.parse(process.argv[1]), c=p.context;
for(const [k,v] of c.environment) { if(v===null) delete process.env[k]; else process.env[k]=v; }
const get=n=>import(pathToFileURL(c.package+'/dist/'+n));
const {a:resolveDatabase}=await get('openclaw-agent-db.paths-C2YxM4Tj.mjs');
const {s:statePath}=await get('openclaw-state-db.paths-DYMh54HD.mjs');
if(fs.realpathSync(resolveDatabase({agentId:c.agent_id,env:process.env}))!==fs.realpathSync(c.agent_dir+'/openclaw-agent.sqlite')||fs.realpathSync(statePath(process.env))!==fs.realpathSync(c.state_database))throw Error('OpenClaw environment does not match reviewed storage');
const {t:lockState}=await get('embedded-state-lock-Cw9nQxv5.mjs');
const lock=await lockState({options:{env:process.env,allowInTests:true,timeoutMs:1000},formatActiveGatewayRefusal:()=> 'Stop the local OpenClaw Gateway before native import or resume'});
try {
 const path=c.agent_dir+'/openclaw-agent.sqlite';
 const db=new DatabaseSync(path,{readOnly:true});
 const meta=db.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
 if(db.prepare('PRAGMA user_version').get().user_version!==23||meta.role!=='agent'||meta.schema_version!==23||meta.agent_id!==c.agent_id||meta.app_version!=='2026.9.6') throw Error('Unverified OpenClaw database');
 db.close();
 if(fs.realpathSync(resolveDatabase({agentId:c.agent_id,env:process.env}))!==fs.realpathSync(path))throw Error('OpenClaw state and configured agent directory differ');
 const stateDb=new DatabaseSync(statePath(process.env),{readOnly:true});
 const stateMeta=stateDb.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
 if(stateDb.prepare('PRAGMA user_version').get().user_version!==18||stateMeta.role!=='global'||stateMeta.schema_version!==18)throw Error('Unverified OpenClaw global database');
 stateDb.close();
 const options={agentId:c.agent_id,env:process.env,path};
 const {f:transaction,r:close}=await get('openclaw-agent-db-CaQAStOA.mjs');
 const {f:writeEntry}=await get('session-accessor.sqlite-entry-store-DTntRuil.mjs');
 const {u:replace}=await get('session-accessor.sqlite-transcript-store-CFksbmAY.mjs');
 const {l:events}=await get('session-accessor.sqlite-read-DG0i0-yW.mjs');
 const {n:readOnly}=await get('openclaw-agent-db-readonly-IBx2zWDG.mjs');
 const payload=fs.readFileSync(p.payload);
 if(createHash('sha256').update(payload).digest('hex')!==p.payload_hash)throw Error('Reviewed OpenClaw payload changed');
 const expected=JSON.parse(payload.toString('utf8'));
 if(p.probe) {console.log(JSON.stringify({ready:true}));} else {
 const scope={...options,sessionKey:p.key,sessionId:p.id};
 const verify=d=>{
  const n=d.db.prepare('SELECT * FROM session_nodes WHERE session_key=?').get(p.key);
  const w=d.db.prepare('SELECT * FROM session_windows WHERE session_id=?').get(p.id);
  if(!n||!w||n.current_session_id!==p.id||n.entry_valid!==1||w.session_key!==p.key||w.previous_session_id||w.acp_owned||w.plugin_owner_id||w.parent_session_key||n.parent_session_key||n.fork_source_session_id||w.session_scope!=='conversation'||(w.agent_harness_id&&w.agent_harness_id!=='pi'))throw Error('OpenClaw target ownership or window changed');
  const e=JSON.parse(n.entry_json);
  if(e.sessionId!==p.id||e.spawnedCwd!==p.workspace||e.spawnedWorkspaceDir!==p.workspace||e.label!=='AgentKib '+p.id)throw Error('OpenClaw import ownership changed');
  if(d.db.prepare('SELECT 1 FROM session_transcript_cold_archives WHERE session_id=?').get(p.id))throw Error('OpenClaw target archived');
  const idx=d.db.prepare('SELECT * FROM session_transcript_index_state WHERE session_id=?').get(p.id);
  const last=d.db.prepare('SELECT max(seq) AS seq FROM transcript_events WHERE session_id=?').get(p.id);
  if(!idx||idx.needs_rebuild||idx.indexed_seq!==last.seq)throw Error('OpenClaw target index is stale');
  const active=d.db.prepare('SELECT event_seq,active_position,message_position,context_eligible FROM session_transcript_active_events WHERE session_id=? ORDER BY active_position LIMIT ?').all(p.id,expected.length-1);
  if(active.length!==expected.length-1||active.some((e,i)=>e.event_seq!==i+1||e.active_position!==i||e.message_position!==i||e.context_eligible!==1))throw Error('OpenClaw reviewed history is no longer active');
  const generation=d.db.prepare('SELECT generation FROM transcript_rewrite_watermarks WHERE session_id=?').get(p.id)?.generation;
  const raw=events(d,p.id,{maxEventBytes:268435456});
  if(raw.some((event,i)=>i>=expected.length && ['reset','compaction','branch_summary','leaf'].includes(event.type)))throw Error('OpenClaw target context boundary changed');
  return {events:raw,generation};
 };
 if(p.write)transaction(d=>{
  if(d.db.prepare('SELECT 1 FROM session_nodes WHERE session_key=? OR current_session_id=?').get(p.key,p.id)||d.db.prepare('SELECT 1 FROM session_windows WHERE session_id=?').get(p.id)||d.db.prepare('SELECT 1 FROM transcript_events WHERE session_id=?').get(p.id))throw Error('OpenClaw target already exists');
  writeEntry(d,p.key,{sessionId:p.id,updatedAt:Date.now(),createdAt:Date.now(),label:'AgentKib '+p.id,spawnedCwd:p.workspace,spawnedWorkspaceDir:p.workspace,createdVia:'operator'});
  replace(d,scope,expected);
  const actual=verify(d);
  if(JSON.stringify(actual.events)!==JSON.stringify(expected))throw Error('OpenClaw writer changed reviewed payload');
 },options);
 const result=readOnly(d=>{d.db.exec('BEGIN');try{return verify(d)}finally{d.db.exec('ROLLBACK')}},options);
 if(!result.found)throw Error('OpenClaw target not found');
 console.log(JSON.stringify(result.value));
 }
 await close();
} finally {await lock.release();}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_conversations::{SessionBlock, SessionDocumentSource, SessionRole, SessionTurn};

    #[test]
    fn environment_never_allows_node_code_injection() {
        let mut values = ENVIRONMENT
            .iter()
            .map(|key| ((*key).into(), None))
            .collect::<Vec<_>>();
        assert!(validate_environment(&values).is_ok());
        values[5].1 = Some("--import /tmp/foreign.mjs".into());
        assert!(validate_environment(&values).is_err());
        values[5].1 = None;
        values.swap(0, 1);
        assert!(validate_environment(&values).is_err());
    }

    fn append_fixture(context: &Context, id: &str, event: Value) {
        const SCRIPT: &str = r#"
import {pathToFileURL} from 'node:url';
const p=JSON.parse(process.argv[1]),c=p.context;
for(const [k,v] of c.environment){if(v===null)delete process.env[k];else process.env[k]=v;}
const get=n=>import(pathToFileURL(c.package+'/dist/'+n));
const {t:lockState}=await get('embedded-state-lock-Cw9nQxv5.mjs');
const lock=await lockState({options:{env:process.env,allowInTests:true,timeoutMs:1000},formatActiveGatewayRefusal:()=> 'Active Gateway'});
const {f:transaction,r:close}=await get('openclaw-agent-db-CaQAStOA.mjs');
const {t:append}=await get('session-accessor.sqlite-transcript-store-CFksbmAY.mjs');
try { const options={agentId:c.agent_id,env:process.env};transaction(d=>append(d,{...options,sessionKey:p.key,sessionId:p.id},p.event),options);await close();}finally{await lock.release();}
"#;
        let input = json!({"context":context,"id":id,"key":context.key(id),"event":event});
        let result = Command::new(&context.node)
            .args(["--input-type=module", "-e", SCRIPT, &input.to_string()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    /// Runs the production bridge against an isolated store made by the pinned
    /// product. No credentials, model request, Gateway or terminal is started.
    #[test]
    #[ignore = "requires pinned OpenClaw package and isolated environment"]
    fn official_openclaw_import_reopen_and_conflicts() {
        let package = PathBuf::from(
            std::env::var_os("AGENTKIB_TEST_OPENCLAW_PACKAGE").expect("set isolated package"),
        );
        let state =
            PathBuf::from(std::env::var_os("OPENCLAW_STATE_DIR").expect("set NEW isolated state"));
        let data = PathBuf::from(
            std::env::var_os("AGENTKIB_BENCHMARK_DATA_DIR").expect("set isolated application data"),
        );
        assert!(!state.exists(), "test state must be new");
        assert!(data.is_absolute());
        fs::create_dir_all(&data).unwrap();
        let node = agentkib_platform::command::resolve("node").unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../qa/probes/openclaw-sqlite-fixtures.mjs");
        let output = Command::new(&node)
            .arg(fixture)
            .arg(&package)
            .arg(&state)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let workspace = fs::canonicalize(state.join("workspace")).unwrap();
        let executable = fs::canonicalize(package.join("openclaw.mjs")).unwrap();
        let global_path = state.join("state/openclaw.sqlite");
        let agent_path = state.join("agents/main/agent/openclaw-agent.sqlite");
        let before_global = fs::read(&global_path).unwrap();
        let before_agent = fs::read(&agent_path).unwrap();
        let context = context(&executable, &workspace).unwrap();
        assert_eq!(
            fs::read(&global_path).unwrap(),
            before_global,
            "preview must not write global storage"
        );
        assert_eq!(
            fs::read(&agent_path).unwrap(),
            before_agent,
            "preview must not write native history"
        );
        {
            let old = rusqlite::Connection::open(&global_path).unwrap();
            old.execute_batch("PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17 WHERE meta_key='primary'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
            let before = fs::read(&global_path).unwrap();
            assert!(
                super::context(&executable, &workspace).is_err(),
                "old global database cannot enter writable CLI lifecycle"
            );
            assert_eq!(
                fs::read(&global_path).unwrap(),
                before,
                "preview must not migrate an old global database"
            );
            assert_eq!(
                old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                17
            );
            old.execute_batch("PRAGMA user_version=18; UPDATE schema_meta SET schema_version=18 WHERE meta_key='primary'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }

        let id = uuid::Uuid::new_v4().to_string();
        let document = SessionDocument {
            schema_version: agentkib_conversations::SESSION_DOCUMENT_SCHEMA_VERSION,
            source: SessionDocumentSource {
                agent: AgentKind::ClaudeCode,
                workspace_id: "workspace".into(),
                title: Some("Isolated OpenClaw import".into()),
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
                        text: "Marker OPENCLAW-NATIVE-83d2 and decision: SQLite WAL.".into(),
                    }],
                },
                SessionTurn {
                    id: "assistant".into(),
                    role: SessionRole::Assistant,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Confirmed OPENCLAW-NATIVE-83d2; SQLite WAL.".into(),
                    }],
                },
            ],
            losses: vec![],
            redaction_count: 0,
        };
        let prepared =
            prepare_native_import(AgentKind::OpenClaw, &document, &id, &workspace, None).unwrap();
        let plan = Plan {
            schema_version: 1,
            operation_id: id.clone(),
            workspace_id: "workspace".into(),
            workspace,
            source_session_id: "synthetic".into(),
            source_fingerprint: fingerprint(&document).unwrap(),
            target_agent: AgentKind::OpenClaw,
            executable,
            version: VERSION.into(),
            model: None,
            target_home: None,
            target_profile: None,
            environment: capture_environment().unwrap(),
            openclaw: Some(context.clone()),
            cursor: None,
            target_session_id: id.clone(),
            document,
            expected: prepared.expected,
            payload: prepared.payload,
        };
        validate_plan(&plan, "workspace").unwrap();
        let directory = data.join(format!("openclaw-test-{id}"));
        fs::create_dir(&directory).unwrap();
        let payload = directory.join("payload.json");
        create_file(&payload, plan.payload.as_bytes()).unwrap();
        ready(&plan, &payload).unwrap();
        run(&plan, &payload, true).unwrap();
        assert_eq!(verify(&plan, &directory, true).unwrap(), id);
        assert_eq!(verify(&plan, &directory, false).unwrap(), id);
        assert!(
            run(&plan, &payload, true).is_err(),
            "must not replace an existing target"
        );
        assert_eq!(verify(&plan, &directory, false).unwrap(), id);
        let events: Vec<Value> = serde_json::from_str(&plan.payload).unwrap();
        append_fixture(
            &context,
            &id,
            json!({"type":"message","id":"follow-up","parentId":events.last().unwrap()["id"],"timestamp":"2026-09-27T01:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Synthetic later turn"}],"timestamp":1790467200000i64}}),
        );
        assert_eq!(
            verify(&plan, &directory, false).unwrap(),
            id,
            "normal appended turns preserve reviewed prefix"
        );
        assert!(
            verify(&plan, &directory, true).is_err(),
            "first import verification requires exact history"
        );
        let db =
            rusqlite::Connection::open(context.agent_dir.join("openclaw-agent.sqlite")).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM session_nodes WHERE current_session_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        db.execute("UPDATE session_transcript_active_events SET context_eligible=0 WHERE session_id=?1 AND active_position=0",[&id]).unwrap();
        assert!(
            verify(&plan, &directory, false).is_err(),
            "reviewed text excluded from model context must be rejected"
        );
        db.execute("UPDATE session_transcript_active_events SET context_eligible=1 WHERE session_id=?1 AND active_position=0",[&id]).unwrap();
        let generation: String = db
            .query_row(
                "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        db.execute("UPDATE transcript_rewrite_watermarks SET generation='external-rewrite' WHERE session_id=?1",[&id]).unwrap();
        assert!(
            verify(&plan, &directory, false).is_err(),
            "must reject a changed generation"
        );
        db.execute(
            "UPDATE transcript_rewrite_watermarks SET generation=?1 WHERE session_id=?2",
            rusqlite::params![generation, id],
        )
        .unwrap();
        // Alter the approved raw record without repairing its projection: never
        // accept projection/cache text as proof of unchanged native history.
        let original: String = db
            .query_row(
                "SELECT event_json FROM transcript_events WHERE session_id=?1 AND seq=1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let mut changed: Value = serde_json::from_str(&original).unwrap();
        changed["message"]["content"][0]["text"] = json!("external replacement");
        db.execute(
            "UPDATE transcript_events SET event_json=?1 WHERE session_id=?2 AND seq=1",
            rusqlite::params![changed.to_string(), id],
        )
        .unwrap();
        assert!(
            verify(&plan, &directory, false).is_err(),
            "must preserve and refuse external edits"
        );
        let content: String = db
            .query_row(
                "SELECT event_json FROM transcript_events WHERE session_id=?1 AND seq=1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(content.contains("external replacement"));
        db.execute(
            "UPDATE transcript_events SET event_json=?1 WHERE session_id=?2 AND seq=1",
            rusqlite::params![original, id],
        )
        .unwrap();
        append_fixture(
            &context,
            &id,
            json!({"type":"reset","id":"external-reset","parentId":"follow-up","timestamp":"2026-09-27T02:00:00Z","reason":"new"}),
        );
        assert!(
            verify(&plan, &directory, false).is_err(),
            "reset cannot silently discard reviewed context"
        );
        db.execute_batch("PRAGMA user_version=24").unwrap();
        assert!(
            run(&plan, &payload, true).is_err(),
            "unknown schema must not reach writer"
        );
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            24
        );
    }
}
