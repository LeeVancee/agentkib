//! Local, explicitly paired Cursor IDE windows. No remote control or database writes.
use super::*;
use agentkib_conversations::cursor_ide::CursorIdeProfile;
use anyhow::Context as AnyhowContext;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

pub(super) const VERSION: &str = "3.22.12";
pub(super) const EXTENSION_VERSION: &str = "0.1.0";
#[cfg(target_os = "macos")]
const MAX_FRAME: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Context {
    pub binding_id: String,
    pub profile: CursorIdeProfile,
    pub app_root: PathBuf,
    pub app_hash: String,
    pub extension_version: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    context: Context,
    credential_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    action: String,
    workspace_id: String,
    binding_id: Option<String>,
}

pub(super) fn request(request: Request) -> anyhow::Result<Value> {
    let workspace = agentkib_core::canonical_project(
        &Store::open_default()?.workspace_path(&request.workspace_id)?,
    )?;
    match request.action.as_str() {
        "status" => Ok(
            json!({"supported":cfg!(target_os="macos"), "version": VERSION,
            "bindings": registrations()?.into_iter().filter(|r|r.context.profile.workspace==workspace)
                .map(|r|json!({"id":r.context.binding_id,"profile":r.context.profile.id,
                    "version":r.context.profile.version,"connected":connected(&r.context.binding_id)})).collect::<Vec<_>>()}),
        ),
        "connect" => begin(workspace, request.binding_id),
        "disconnect" => disconnect(
            request.binding_id.context("Select a Cursor IDE binding")?,
            &workspace,
        ),
        _ => anyhow::bail!("Unsupported Cursor bridge action"),
    }
}

fn root() -> anyhow::Result<PathBuf> {
    Ok(agentkib_store::default_data_dir()?.join("cursor-bridge"))
}

fn safe(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
        "Invalid Cursor storage path"
    );
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok() {
            anyhow::ensure!(
                !platform_path::is_reparse_or_symlink(p)?,
                "Cursor storage path is a link"
            );
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn private_directory(path: &Path) -> anyhow::Result<()> {
    safe(path)?;
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn private_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    safe(path)?;
    let parent = path.parent().context("Missing bridge directory")?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> anyhow::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn registrations() -> anyhow::Result<Vec<Registration>> {
    let path = root()?.join("profiles-v1.json");
    safe(&path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    anyhow::ensure!(
        fs::metadata(&path)?.len() <= 1024 * 1024,
        "Cursor profile registry exceeds limit"
    );
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    anyhow::ensure!(
        value["schema_version"] == 1,
        "Unknown Cursor profile registry version"
    );
    let registrations: Vec<Registration> = serde_json::from_value(value["registrations"].clone())?;
    anyhow::ensure!(registrations.len() <= 64, "Too many Cursor profiles");
    for r in &registrations {
        validate_context(&r.context)?;
    }
    Ok(registrations)
}

#[cfg(target_os = "macos")]
fn save_registrations(registrations: &[Registration]) -> anyhow::Result<()> {
    private_json(
        &root()?.join("profiles-v1.json"),
        &json!({"schema_version":1,"registrations":registrations}),
    )
}

fn unique_profiles(profiles: impl IntoIterator<Item = CursorIdeProfile>) -> Vec<CursorIdeProfile> {
    let mut unique = Vec::new();
    for profile in profiles {
        if !unique.contains(&profile) {
            unique.push(profile);
        }
    }
    unique
}

pub(super) fn profiles() -> anyhow::Result<Vec<CursorIdeProfile>> {
    Ok(unique_profiles(
        registrations()?
            .into_iter()
            .filter(|r| !r.credential_hash.is_empty())
            .map(|r| r.context.profile),
    ))
}

pub(super) fn context(binding_id: &str, workspace: &Path) -> anyhow::Result<Context> {
    anyhow::ensure!(
        cfg!(target_os = "macos"),
        "Cursor IDE native bridge is only verified on macOS"
    );
    let context = registrations()?
        .into_iter()
        .find(|r| r.context.binding_id == binding_id)
        .context("Cursor profile is not connected; explicitly connect this window")?
        .context;
    anyhow::ensure!(
        context.profile.workspace == workspace,
        "Cursor binding belongs to another workspace"
    );
    validate_context(&context)?;
    anyhow::ensure!(connected(binding_id), "Cursor IDE window is disconnected");
    Ok(context)
}

pub(super) fn validate_context(context: &Context) -> anyhow::Result<()> {
    let _: uuid::Uuid = context.binding_id.parse()?;
    anyhow::ensure!(
        context.extension_version == EXTENSION_VERSION && context.profile.version == VERSION,
        "Unverified Cursor bridge version"
    );
    safe(&context.app_root)?;
    safe(&context.profile.db_path)?;
    safe(&context.profile.workspace)?;
    let package = fs::read(context.app_root.join("package.json"))?;
    let product: Value = serde_json::from_slice(&package)?;
    anyhow::ensure!(
        product["name"] == "Cursor"
            && product["version"] == VERSION
            && agentkib_core::hash_content(&package) == context.app_hash,
        "Cursor installation changed after connection"
    );
    anyhow::ensure!(
        context
            .profile
            .db_path
            .file_name()
            .is_some_and(|n| n == "state.vscdb")
            && context
                .profile
                .db_path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == "globalStorage")
            && context
                .profile
                .db_path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .is_some_and(|n| n == "User"),
        "Unsupported Cursor profile storage"
    );
    anyhow::ensure!(
        agentkib_core::canonical_project(&context.profile.workspace)? == context.profile.workspace,
        "Cursor workspace identity changed"
    );
    Ok(())
}

#[cfg(target_os = "macos")]
mod local {
    use super::*;
    use std::io::BufReader;
    use std::os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    };
    struct Pairing {
        token: String,
        workspace: PathBuf,
        binding_id: Option<String>,
        expires: Instant,
    }
    struct Window {
        lease: String,
        session_id: String,
        cancellation: UnixStream,
        stream: Mutex<BufReader<UnixStream>>,
    }
    struct State {
        pairing: Vec<Pairing>,
        windows: BTreeMap<String, Arc<Window>>,
    }
    struct Server {
        state: Mutex<State>,
        boot: String,
        socket: PathBuf,
        stopping: AtomicBool,
    }
    static SERVER: OnceLock<Arc<Server>> = OnceLock::new();
    static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

    fn frame(reader: &mut impl BufRead) -> anyhow::Result<Value> {
        let mut raw = Vec::new();
        reader
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut raw)?;
        anyhow::ensure!(
            !raw.is_empty() && raw.len() <= MAX_FRAME && raw.last() == Some(&b'\n'),
            "Invalid Cursor bridge frame"
        );
        Ok(serde_json::from_slice(&raw)?)
    }
    fn write_frame(writer: &mut impl Write, value: &Value) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(value)?;
        anyhow::ensure!(
            bytes.len() < MAX_FRAME,
            "Cursor bridge payload exceeds limit"
        );
        writer.write_all(&bytes)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    }
    fn server() -> anyhow::Result<&'static Arc<Server>> {
        if let Some(server) = SERVER.get() {
            return Ok(server);
        }
        let _lock = REGISTRY_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor registry unavailable"))?;
        if let Some(server) = SERVER.get() {
            return Ok(server);
        }
        private_directory(&root()?)?;
        // macOS limits sockaddr_un to 104 bytes. Only nonsecret rendezvous metadata is persistent.
        let directory =
            fs::canonicalize("/tmp")?.join(format!("akib-{}", uuid::Uuid::new_v4().simple()));
        safe(&directory)?;
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let socket = directory.join("b.sock");
        anyhow::ensure!(
            socket.as_os_str().len() < 104,
            "Cursor bridge socket path exceeds macOS limit"
        );
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let server = Arc::new(Server {
            state: Mutex::new(State {
                pairing: vec![],
                windows: BTreeMap::new(),
            }),
            boot: uuid::Uuid::new_v4().to_string(),
            socket: socket.clone(),
            stopping: AtomicBool::new(false),
        });
        private_json(
            &root()?.join("endpoint-v1.json"),
            &json!({"schema_version":1,"boot_id":server.boot,"socket":socket}),
        )?;
        SERVER
            .set(server.clone())
            .map_err(|_| anyhow::anyhow!("Cursor bridge already running"))?;
        std::thread::spawn(move || {
            while !server.stopping.load(Ordering::SeqCst) {
                if let Ok(mut state) = server.state.lock() {
                    state.windows.retain(|_, window| alive(window));
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = accept(&server, stream);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(SERVER.get().expect("Initialized Cursor server"))
    }

    fn alive(window: &Window) -> bool {
        let Ok(mut reader) = window.stream.try_lock() else {
            return true;
        };
        if reader.get_mut().set_nonblocking(true).is_err() {
            return false;
        }
        let alive = match reader.fill_buf() {
            Ok(bytes) => !bytes.is_empty(),
            Err(e) => e.kind() == io::ErrorKind::WouldBlock,
        };
        let _ = reader.get_mut().set_nonblocking(false);
        alive
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Hello {
        protocol: u32,
        extension_version: String,
        workspace: PathBuf,
        global_storage: PathBuf,
        app_root: PathBuf,
        session_id: String,
        extension_mode: u32,
        ticket: Option<String>,
        credential: Option<String>,
    }

    fn accept(server: &Arc<Server>, stream: UnixStream) -> anyhow::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let mut reader = BufReader::new(stream);
        let hello: Hello = serde_json::from_value(frame(&mut reader)?)?;
        anyhow::ensure!(
            hello.protocol == 1
                && hello.extension_version == EXTENSION_VERSION
                && hello.extension_mode == 1
                && !hello.session_id.is_empty()
                && hello.session_id.len() < 256,
            "Unverified Cursor extension host"
        );
        let workspace = agentkib_core::canonical_project(&hello.workspace)?;
        safe(&hello.global_storage)?;
        anyhow::ensure!(
            hello
                .global_storage
                .file_name()
                .is_some_and(|n| n == "agentkib.cursor-bridge"),
            "Unexpected extension storage identity"
        );
        let db = hello
            .global_storage
            .parent()
            .context("Cursor profile storage unavailable")?
            .join("state.vscdb");
        anyhow::ensure!(
            db.is_file(),
            "Cursor authoritative profile database is unavailable"
        );
        let package = fs::read(hello.app_root.join("package.json"))?;
        let profile_id = agentkib_core::hash_content(db.to_string_lossy().as_bytes());
        let _registry = REGISTRY_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor registry unavailable"))?;
        let mut registrations = registrations()?;
        let mut state = server
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor bridge unavailable"))?;
        let credential;
        let paired = hello.ticket.is_some();
        let registration = if let Some(ticket) = hello.ticket {
            let position = state
                .pairing
                .iter()
                .position(|p| {
                    p.token == ticket && p.workspace == workspace && p.expires > Instant::now()
                })
                .context("Expired or mismatched Cursor connection challenge")?;
            let pairing = state.pairing.remove(position);
            let existing = pairing
                .binding_id
                .as_ref()
                .and_then(|id| registrations.iter().find(|r| r.context.binding_id == *id))
                .cloned();
            let context = Context {
                binding_id: existing
                    .as_ref()
                    .map(|r| r.context.binding_id.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                profile: CursorIdeProfile {
                    id: profile_id,
                    db_path: db,
                    version: VERSION.into(),
                    workspace,
                },
                app_root: hello.app_root,
                app_hash: agentkib_core::hash_content(&package),
                extension_version: hello.extension_version,
            };
            validate_context(&context)?;
            context.profile.validate()?;
            agentkib_conversations::cursor_ide::list_cursor_ide_identities(&context.profile)?;
            anyhow::ensure!(
                existing.is_some() || registrations.len() < 64,
                "Too many Cursor connections"
            );
            credential = Some(format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ));
            let registration = Registration {
                context,
                credential_hash: agentkib_core::hash_content(
                    credential.as_ref().expect("Pairing credential").as_bytes(),
                ),
            };
            if let Some(existing) = &existing {
                anyhow::ensure!(
                    existing.context == registration.context,
                    "Cursor reconnect profile differs from the existing binding"
                );
            }
            registrations.retain(|r| r.context.binding_id != registration.context.binding_id);
            registrations.push(registration.clone());
            save_registrations(&registrations)?;
            registration
        } else {
            credential = None;
            anyhow::ensure!(
                registrations
                    .iter()
                    .filter(|r| r.context.profile.id == profile_id
                        && r.context.profile.workspace == workspace)
                    .count()
                    == 1,
                "Multiple Cursor windows require explicit selection and reconnection"
            );
            let hash = agentkib_core::hash_content(
                hello
                    .credential
                    .as_deref()
                    .context("Cursor bridge credential required")?
                    .as_bytes(),
            );
            registrations
                .into_iter()
                .find(|r| {
                    r.credential_hash == hash
                        && r.context.profile.id == profile_id
                        && r.context.profile.workspace == workspace
                        && r.context.app_root == hello.app_root
                })
                .context("Cursor bridge identity changed")?
        };
        validate_context(&registration.context)?;
        registration.context.profile.validate()?;
        agentkib_conversations::cursor_ide::list_cursor_ide_identities(
            &registration.context.profile,
        )?;
        if !paired && let Some(existing) = state.windows.get(&registration.context.binding_id) {
            anyhow::ensure!(
                existing.session_id == hello.session_id || !alive(existing),
                "Multiple Cursor windows require explicit selection and reconnection"
            );
        }
        anyhow::ensure!(
            state.windows.len() < 8 || state.windows.contains_key(&registration.context.binding_id),
            "Cursor window limit reached"
        );
        let lease = uuid::Uuid::new_v4().to_string();
        write_frame(
            reader.get_mut(),
            &json!({"protocol":1,"boot_id":server.boot,"binding_id":registration.context.binding_id,"lease":lease,"credential":credential,"endpoint":root()?.join("endpoint-v1.json")}),
        )?;
        let old = state.windows.insert(
            registration.context.binding_id,
            Arc::new(Window {
                lease,
                session_id: hello.session_id,
                cancellation: reader.get_ref().try_clone()?,
                stream: Mutex::new(reader),
            }),
        );
        if let Some(old) = old {
            let _ = old.cancellation.shutdown(std::net::Shutdown::Both);
        }
        Ok(())
    }

    pub(crate) fn begin(workspace: PathBuf, binding_id: Option<String>) -> anyhow::Result<Value> {
        if let Some(id) = &binding_id {
            anyhow::ensure!(
                registrations()?.iter().any(
                    |r| r.context.binding_id == *id && r.context.profile.workspace == workspace
                ),
                "Cursor reconnect binding is unavailable"
            );
        }
        let server = server()?;
        anyhow::ensure!(
            !server.stopping.load(Ordering::SeqCst),
            "Cursor bridge is shutting down"
        );
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut state = server
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor bridge unavailable"))?;
        state.pairing.retain(|p| p.expires > Instant::now());
        anyhow::ensure!(state.pairing.len() < 8, "Cursor connection queue is full");
        state.pairing.push(Pairing {
            token: token.clone(),
            workspace,
            binding_id,
            expires: Instant::now() + Duration::from_secs(120),
        });
        Ok(
            json!({"challenge":serde_json::to_string(&json!({"socket":server.socket,"ticket":token}))?,"expires_in_seconds":120}),
        )
    }
    pub(crate) fn connected(id: &str) -> bool {
        SERVER.get().is_some_and(|s| {
            s.state
                .lock()
                .is_ok_and(|state| state.windows.contains_key(id))
        })
    }
    pub(crate) fn call(context: &Context, action: &str, args: Value) -> anyhow::Result<Value> {
        anyhow::ensure!(
            ["status", "import", "open", "selected"].contains(&action),
            "Unsupported Cursor command"
        );
        let server = server()?;
        anyhow::ensure!(
            !server.stopping.load(Ordering::SeqCst),
            "Cursor bridge is shutting down"
        );
        let window = server
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor bridge unavailable"))?
            .windows
            .get(&context.binding_id)
            .cloned()
            .context("Cursor window is disconnected")?;
        let mut stream = window
            .stream
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor window unavailable"))?;
        let timeout = native_import::remaining().min(Duration::from_secs(60));
        anyhow::ensure!(!timeout.is_zero(), "Cursor request deadline exceeded");
        stream.get_mut().set_read_timeout(Some(timeout))?;
        let id = uuid::Uuid::new_v4().to_string();
        let result = (|| -> anyhow::Result<Value> {
            write_frame(
                stream.get_mut(),
                &json!({"protocol":1,"boot_id":server.boot,"binding_id":context.binding_id,"lease":window.lease,"request_id":id,"workspace":context.profile.workspace,"action":action,"args":args}),
            )?;
            let reply = frame(&mut *stream)?;
            anyhow::ensure!(
                reply["protocol"] == 1
                    && reply["boot_id"] == server.boot
                    && reply["lease"] == window.lease
                    && reply["request_id"] == id,
                "Cursor bridge response identity mismatch"
            );
            anyhow::ensure!(
                reply.get("error").is_none(),
                "Cursor command failed; outcome may require reconciliation"
            );
            Ok(reply["result"].clone())
        })();
        if result.is_err() {
            let mut state = server
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("Cursor bridge unavailable"))?;
            if state
                .windows
                .get(&context.binding_id)
                .is_some_and(|current| Arc::ptr_eq(current, &window))
            {
                state.windows.remove(&context.binding_id);
            }
        }
        result
    }
    pub(crate) fn disconnect(id: String, workspace: &Path) -> anyhow::Result<Value> {
        let _lock = REGISTRY_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("Cursor registry unavailable"))?;
        let mut registrations = registrations()?;
        let found = registrations
            .iter()
            .find(|r| r.context.binding_id == id)
            .context("Cursor binding unavailable")?;
        anyhow::ensure!(
            found.context.profile.workspace == workspace,
            "Cursor binding workspace mismatch"
        );
        // Revoke the credential and read access, retaining the frozen identity
        // needed to explicitly reconnect an interrupted import operation.
        for registration in &mut registrations {
            if registration.context.binding_id == id {
                registration.credential_hash.clear();
            }
        }
        save_registrations(&registrations)?;
        if let Some(server) = SERVER.get()
            && let Ok(mut state) = server.state.lock()
            && let Some(window) = state.windows.remove(&id)
        {
            let _ = window.cancellation.shutdown(std::net::Shutdown::Both);
        }
        Ok(json!({"disconnected":true}))
    }
    pub(crate) fn shutdown() {
        if let Some(server) = SERVER.get() {
            server.stopping.store(true, Ordering::SeqCst);
            if let Ok(mut state) = server.state.lock() {
                state.pairing.clear();
                for window in state.windows.values() {
                    let _ = window.cancellation.shutdown(std::net::Shutdown::Both);
                }
                state.windows.clear();
            }
            let _ = fs::remove_file(&server.socket);
            if let Some(parent) = server.socket.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    pub(crate) fn initialize() {
        if registrations().is_ok_and(|r| !r.is_empty()) {
            let _ = server();
        }
    }
}

#[cfg(target_os = "macos")]
use local::{begin, connected, disconnect};
#[cfg(target_os = "macos")]
pub(super) use local::{call, initialize, shutdown};
#[cfg(not(target_os = "macos"))]
fn begin(_: PathBuf, _: Option<String>) -> anyhow::Result<Value> {
    anyhow::bail!("Cursor IDE native bridge is only verified on macOS")
}
#[cfg(not(target_os = "macos"))]
fn connected(_: &str) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
fn disconnect(_: String, _: &Path) -> anyhow::Result<Value> {
    anyhow::bail!("Cursor IDE native bridge unavailable")
}
#[cfg(not(target_os = "macos"))]
pub(super) fn call(_: &Context, _: &str, _: Value) -> anyhow::Result<Value> {
    anyhow::bail!("Cursor IDE native bridge unavailable")
}
#[cfg(not(target_os = "macos"))]
pub(super) fn initialize() {}
#[cfg(not(target_os = "macos"))]
pub(super) fn shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_profile_two_windows_have_one_source_without_merging_distinct_workspaces() {
        let path = std::env::temp_dir();
        let profile = CursorIdeProfile {
            id: "profile".into(),
            db_path: path.join("User/globalStorage/state.vscdb"),
            version: VERSION.into(),
            workspace: path.join("workspace"),
        };
        let mut other = profile.clone();
        other.workspace = path.join("other");
        assert_eq!(
            unique_profiles([profile.clone(), profile.clone(), other.clone()]),
            vec![profile, other]
        );
    }
    #[test]
    fn binding_and_version_contract_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<Request>(
                json!({"action":"connect","workspaceId":"w","path":"/external"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Registration>(
                json!({"context":{},"credential_hash":"abc","credential":"plaintext"})
            )
            .is_err()
        );
    }
}
