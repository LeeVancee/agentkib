//! Temporary native readers and the session worker fence for the staged TypeScript migration.
use super::*;

pub fn context(_: EmptyRequest) -> anyhow::Result<Value> {
    Ok(json!({
        "agent_homes": agentkib_discovery::known_agent_homes(),
        "agentkib_home": agentkib_skills::default_home_dir().ok(),
    }))
}

#[derive(Deserialize)]
pub struct NativeDiscoveryRequest {
    roots: Vec<NativeScanRoot>,
}

#[derive(Deserialize)]
struct NativeScanRoot {
    path: PathBuf,
    max_depth: usize,
}

pub fn discover(request: NativeDiscoveryRequest) -> anyhow::Result<Value> {
    let roots = request
        .roots
        .into_iter()
        .map(|root| (root.path, root.max_depth))
        .collect::<Vec<_>>();
    let snapshot = discover_local_workspaces(&roots);
    Ok(json!({
        "candidates": snapshot.candidates,
        "installations": snapshot.installations,
        "home_assets": snapshot.home_assets,
        "errors": snapshot.errors,
        "source_diagnostics": snapshot.source_diagnostics,
    }))
}

#[derive(Deserialize)]
pub struct NativeInspectRequest {
    workspaces: Vec<NativeWorkspace>,
}

#[derive(Deserialize)]
struct NativeWorkspace {
    id: String,
    path: PathBuf,
}

pub fn inspect(request: NativeInspectRequest) -> anyhow::Result<Value> {
    Ok(Value::Array(
        request
            .workspaces
            .into_iter()
            .map(|workspace| {
                json!({
                    "id": workspace.id,
                    "inspection": agentkib_store::inspect_workspace(&workspace.id, &workspace.path),
                })
            })
            .collect(),
    ))
}

/// The TypeScript-owned index has changed; revoke remaining remote gateway snapshots without writing the index.
pub fn remote_session_index_changed(_: EmptyRequest) -> anyhow::Result<()> {
    let _guard = session_index_write_lock()?;
    invalidate_session_index_refreshes();
    Ok(())
}
