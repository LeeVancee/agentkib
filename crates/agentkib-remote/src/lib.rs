//! LAN-only, mutually authenticated, read-only device transport.
mod tls;

use anyhow::{Context, Result, bail, ensure};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    runtime::Runtime,
    sync::Semaphore,
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tokio_util::sync::CancellationToken;

const SERVICE: &str = "_agentkib._tcp.local.";
const PROTOCOL: u64 = 1;
const MAX_FRAME: usize = 4 * 1024 * 1024;
const MAX_REQUEST: usize = 16 * 1024;
const CODE_TTL: u64 = 300;

pub trait Source: Send + Sync + 'static {
    fn ensure_available(&self) -> Result<()> {
        Ok(())
    }
    fn availability_epoch(&self) -> Result<u64> {
        self.ensure_available()?;
        Ok(0)
    }
    fn catalog(&self) -> Result<Value>;
    fn events(&self, session_id: &str, cursor: Option<&str>, limit: usize) -> Result<Value>;
}

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    approved_at: u64,
    last_seen: Option<u64>,
    #[serde(default)]
    grant_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Connection {
    id: String,
    name: String,
    address: String,
    #[serde(default = "disconnected")]
    status: String,
    #[serde(default)]
    last_seen: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}
fn disconnected() -> String {
    "disconnected".into()
}
#[derive(Clone, Serialize, Deserialize)]
struct Config {
    name: String,
    enabled: bool,
    address: Option<String>,
    authorized: BTreeMap<String, Device>,
    connections: BTreeMap<String, Connection>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            name: "AgentKib".into(),
            enabled: false,
            address: None,
            authorized: BTreeMap::new(),
            connections: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Serialize)]
struct Pending {
    id: String,
    device_id: String,
    name: String,
    verification: String,
    expires_at: u64,
    status: String,
}
struct Code {
    value: String,
    expires_at: u64,
    attempts: u8,
}
struct State {
    config: Config,
    code: Option<Code>,
    pending: BTreeMap<String, Pending>,
    discovered: BTreeMap<String, Value>,
    listener: CancellationToken,
    grants: BTreeMap<String, CancellationToken>,
    generation: u64,
}
struct Inner {
    state: Mutex<State>,
    identity: tls::TlsIdentity,
    source: Arc<dyn Source>,
    directory: PathBuf,
    stop: CancellationToken,
    permits: Arc<Semaphore>,
    read_permits: Arc<Semaphore>,
    mdns: Option<mdns_sd::ServiceDaemon>,
    allow_loopback: bool,
    #[cfg(test)]
    handshake_barriers: Mutex<BTreeMap<u16, tokio::sync::oneshot::Sender<()>>>,
}
struct Engine(Option<Runtime>);
impl std::ops::Deref for Engine {
    type Target = Runtime;
    fn deref(&self) -> &Runtime {
        self.0.as_ref().expect("runtime alive")
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            runtime.shutdown_timeout(Duration::from_secs(1));
        }
    }
}
pub struct RemoteService {
    inner: Arc<Inner>,
    runtime: Engine,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn text<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 1024)
        .with_context(|| format!("invalid {key}"))
}
fn name(value: &str) -> Result<String> {
    ensure!(
        !value.trim().is_empty()
            && value.chars().count() <= 64
            && !value.chars().any(char::is_control),
        "invalid device name"
    );
    Ok(value.trim().into())
}
fn allowed(ip: Ipv4Addr, test: bool) -> bool {
    ip.is_private() || (test && ip.is_loopback())
}
fn address(value: &str, test: bool) -> Result<SocketAddr> {
    let result: SocketAddr = value
        .parse()
        .context("use a private IPv4 address and port")?;
    ensure!(
        matches!(result.ip(), IpAddr::V4(ip) if allowed(ip,test)),
        "private IPv4 address required"
    );
    ensure!(result.port() != 0 || test, "port required");
    Ok(result)
}
fn interfaces(test: bool) -> Vec<Value> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if allowed(ip, test) => {
                Some(json!({"name":i.name,"address":ip.to_string()}))
            }
            _ => None,
        })
        .collect()
}

impl RemoteService {
    pub fn new(directory: PathBuf, source: Arc<dyn Source>) -> Result<Self> {
        Self::construct(directory, source, false)
    }
    fn construct(directory: PathBuf, source: Arc<dyn Source>, test: bool) -> Result<Self> {
        let directory = directory.join("remote");
        let identity = tls::TlsIdentity::load(&directory)?;
        let path = directory.join("devices.json");
        let mut config: Config = if path.exists() {
            ensure!(
                !std::fs::symlink_metadata(&path)?.file_type().is_symlink()
                    && std::fs::metadata(&path)?.len() < 1024 * 1024,
                "invalid device configuration"
            );
            tls::restrict(&path, false)?;
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            Config::default()
        };
        for c in config.connections.values_mut() {
            c.status = disconnected();
            c.error = None;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let mdns = if test {
            None
        } else {
            mdns_sd::ServiceDaemon::new().ok()
        };
        if let Some(daemon) = &mdns {
            daemon.disable_interface(mdns_sd::IfKind::All)?;
            for interface in interfaces(false) {
                if let Some(ip) = interface["address"]
                    .as_str()
                    .and_then(|s| s.parse::<IpAddr>().ok())
                {
                    daemon.enable_interface(mdns_sd::IfKind::Addr(ip))?;
                }
            }
        }
        let restore = config.clone();
        config.enabled = false;
        let grants = config
            .authorized
            .keys()
            .map(|id| (id.clone(), CancellationToken::new()))
            .collect();
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                config,
                code: None,
                pending: BTreeMap::new(),
                discovered: BTreeMap::new(),
                listener: CancellationToken::new(),
                grants,
                generation: 0,
            }),
            identity,
            source,
            directory,
            stop: CancellationToken::new(),
            permits: Arc::new(Semaphore::new(16)),
            read_permits: Arc::new(Semaphore::new(16)),
            mdns,
            allow_loopback: test,
            #[cfg(test)]
            handshake_barriers: Mutex::new(BTreeMap::new()),
        });
        if let Some(mdns) = &inner.mdns
            && let Ok(receiver) = mdns.browse(SERVICE)
        {
            let weak = Arc::downgrade(&inner);
            runtime.spawn(async move {
                    while let Ok(event) = receiver.recv_async().await {
                        let Some(inner) = weak.upgrade() else { break };
                        if inner.stop.is_cancelled() { break; }
                        match event {
                            mdns_sd::ServiceEvent::ServiceResolved(info) => {
                                let Some(id) = info.get_property_val_str("id").filter(|id| id.len()==64 && id.bytes().all(|c|c.is_ascii_hexdigit())) else { continue };
                                if id == inner.identity.id { continue; }
                                let Some(ip) = info.get_addresses_v4().into_iter().find(|ip|ip.is_private()) else {continue};
                                let host_name = info.get_property_val_str("name").and_then(|n|name(n).ok()).unwrap_or_else(||"AgentKib".into());
                                let mut state = inner.state.lock().unwrap();
                                if state.discovered.len() < 128 { state.discovered.insert(info.get_fullname().into(),json!({"id":id,"name":host_name,"address":format!("{ip}:{}",info.get_port())})); }
                            }
                            mdns_sd::ServiceEvent::ServiceRemoved(_,full) => { inner.state.lock().unwrap().discovered.remove(&full); }
                            _ => {}
                        }
                    }
                });
        }
        let service = Self {
            inner,
            runtime: Engine(Some(runtime)),
        };
        service.runtime.spawn(service.inner.clone().monitor());
        let config = restore;
        if config.enabled
            && let Some(addr) = config.address
            && service.request(json!({"operation":"configure","enabled":true,"address":addr,"name":config.name})).is_err() {
                    service.inner.state.lock().unwrap().config.enabled=false;
        }
        Ok(service)
    }
    pub fn request(&self, params: Value) -> Result<Value> {
        self.runtime.block_on(self.inner.clone().request(params))
    }
    pub fn shutdown(&self) {
        self.inner.stop.cancel();
        self.inner.state.lock().unwrap().listener.cancel();
        if let Some(mdns) = &self.inner.mdns {
            let _ = mdns.shutdown();
        }
    }
}
impl Drop for RemoteService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Inner {
    fn persist(&self, config: &Config) -> Result<()> {
        tls::write_private(&self.directory.join("devices.json"), config)
    }
    fn status(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        state.pending.retain(|_, p| p.expires_at > now());
        if state.code.as_ref().is_some_and(|c| c.expires_at <= now()) {
            state.code = None;
        }
        json!({"local":{"id":self.identity.id,"name":state.config.name,"enabled":state.config.enabled,"address":state.config.address},
            "interfaces":interfaces(self.allow_loopback),"discovered":state.discovered.values().collect::<Vec<_>>(),
            "pending":state.pending.values().filter(|p|p.status=="pending").collect::<Vec<_>>(),"authorized":state.config.authorized.values().collect::<Vec<_>>(),
            "connections":state.config.connections.values().collect::<Vec<_>>(),"pairing_code":state.code.as_ref().map(|c|&c.value),"pairing_expires_at":state.code.as_ref().map(|c|c.expires_at)})
    }
    async fn request(self: Arc<Self>, p: Value) -> Result<Value> {
        ensure!(!self.stop.is_cancelled(), "remote service stopped");
        match text(&p, "operation")? {
            "status" | "discover" => Ok(self.status()),
            "configure" => {
                let enabled = p
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .context("enabled required")?;
                let label = name(text(&p, "name")?)?;
                let bind = if enabled {
                    let bind = address(text(&p, "address")?, self.allow_loopback)?;
                    ensure!(
                        interfaces(self.allow_loopback)
                            .iter()
                            .any(|i| i["address"] == bind.ip().to_string()),
                        "select a local network interface"
                    );
                    Some(bind)
                } else {
                    None
                };
                // Bind before committing state so a busy port cannot produce false success.
                let current = self.state.lock().unwrap().config.clone();
                let same = enabled
                    && current.enabled
                    && current.address.as_deref() == p.get("address").and_then(Value::as_str);
                let listener = if same {
                    None
                } else if let Some(bind) = bind {
                    Some(TcpListener::bind(bind).await?)
                } else {
                    None
                };
                let actual = listener
                    .as_ref()
                    .map(|l| l.local_addr().map(|v| v.to_string()))
                    .transpose()?
                    .or(current.address.clone());
                let token = {
                    let mut state = self.state.lock().unwrap();
                    let mut next = state.config.clone();
                    next.enabled = enabled;
                    next.name = label;
                    next.address = actual;
                    self.persist(&next)?;
                    if !same {
                        state.listener.cancel();
                        state.listener = CancellationToken::new();
                        state.generation += 1;
                        state.code = None;
                        state.pending.clear();
                    }
                    state.config = next;
                    state.listener.clone()
                };
                if let Some(mdns) = &self.mdns {
                    // DNS labels have a 63-byte limit; the complete certificate ID remains in TXT.
                    let instance = &self.identity.id[..32];
                    let _ = mdns.unregister(&format!("{instance}.{SERVICE}"));
                    if enabled {
                        let config = self.state.lock().unwrap().config.clone();
                        let addr: SocketAddr = config
                            .address
                            .as_deref()
                            .context("missing address")?
                            .parse()?;
                        let properties = [
                            ("id", self.identity.id.as_str()),
                            ("name", config.name.as_str()),
                            ("version", "1"),
                        ];
                        if let Ok(info) = mdns_sd::ServiceInfo::new(
                            SERVICE,
                            instance,
                            &format!("{instance}.local."),
                            addr.ip(),
                            addr.port(),
                            &properties[..],
                        ) {
                            let _ = mdns.register(info);
                        }
                    }
                }
                if let Some(listener) = listener {
                    tokio::spawn(self.clone().serve(listener, token));
                }
                Ok(self.status())
            }
            "generate-code" => {
                let mut state = self.state.lock().unwrap();
                ensure!(state.config.enabled, "enable sharing first");
                // Rejection sampling avoids modulo bias for the 100-million-code space.
                let n = loop {
                    let n = OsRng.next_u32();
                    if n < 4_200_000_000 {
                        break n % 100_000_000;
                    }
                };
                state.pending.clear();
                state.code = Some(Code {
                    value: format!("{n:08}"),
                    expires_at: now() + CODE_TTL,
                    attempts: 0,
                });
                drop(state);
                Ok(self.status())
            }
            "approve" | "reject" => {
                let mut state = self.state.lock().unwrap();
                let id = text(&p, "id")?;
                let pending = state.pending.get(id).context("pairing expired")?.clone();
                ensure!(
                    pending.status == "pending" && pending.expires_at > now(),
                    "pairing expired"
                );
                if p["operation"] == "approve" {
                    let mut next = state.config.clone();
                    ensure!(next.authorized.len() < 128, "device limit reached");
                    next.authorized.insert(
                        pending.device_id.clone(),
                        Device {
                            id: pending.device_id.clone(),
                            name: pending.name.clone(),
                            approved_at: now(),
                            last_seen: None,
                            grant_id: pending.id.clone(),
                        },
                    );
                    self.persist(&next)?;
                    state.config = next;
                    if let Some(previous) = state
                        .grants
                        .insert(pending.device_id.clone(), CancellationToken::new())
                    {
                        previous.cancel();
                    }
                }
                state.pending.get_mut(id).unwrap().status = if p["operation"] == "approve" {
                    "approved"
                } else {
                    "rejected"
                }
                .into();
                state.code = None;
                // An approval consumes the single pairing ceremony; other pending requests cannot survive it.
                state.pending.retain(|key, _| key == id);
                drop(state);
                Ok(self.status())
            }
            "revoke" => {
                let mut state = self.state.lock().unwrap();
                let mut next = state.config.clone();
                next.authorized.remove(text(&p, "id")?);
                self.persist(&next)?;
                state.config = next;
                if let Some(grant) = state.grants.remove(text(&p, "id")?) {
                    grant.cancel();
                }
                state.pending.retain(|_, item| item.device_id != p["id"]);
                state.generation += 1;
                drop(state);
                Ok(self.status())
            }
            "pair" => {
                let addr = text(&p, "address")?.to_owned();
                address(&addr, self.allow_loopback)?;
                let code = text(&p, "code")?;
                ensure!(
                    code.len() == 8 && code.bytes().all(|c| c.is_ascii_digit()),
                    "8 digit pairing code required"
                );
                let own_name = self.state.lock().unwrap().config.name.clone();
                let (response, peer, verification) = self
                    .exchange(
                        &addr,
                        None,
                        json!({"op":"pair","code":code,"name":own_name}),
                    )
                    .await?;
                ensure!(peer != self.identity.id, "cannot pair with this device");
                let pending_id = text(&response, "id")?.to_owned();
                let host_name = name(text(&response, "name")?)?;
                let expires = response["expires_at"]
                    .as_u64()
                    .context("invalid pairing response")?
                    .min(now() + CODE_TTL);
                {
                    let mut state = self.state.lock().unwrap();
                    ensure!(state.config.connections.len() < 128, "host limit reached");
                    state.config.connections.insert(
                        peer.clone(),
                        Connection {
                            id: peer.clone(),
                            name: host_name,
                            address: addr.clone(),
                            status: "pending".into(),
                            last_seen: None,
                            error: None,
                        },
                    );
                }
                tokio::spawn(self.clone().poll_pair(peer.clone(), pending_id, expires));
                Ok(
                    json!({"id":peer,"verification":verification,"status":"pending","expires_at":expires}),
                )
            }
            "disconnect" | "remove" => {
                let mut state = self.state.lock().unwrap();
                let mut next = state.config.clone();
                let id = text(&p, "id")?;
                if p["operation"] == "remove" {
                    next.connections.remove(id);
                } else if let Some(c) = next.connections.get_mut(id) {
                    c.status = disconnected();
                    c.error = None;
                }
                self.persist(&next)?;
                state.config = next;
                state.generation += 1;
                drop(state);
                Ok(self.status())
            }
            "connect" | "catalog" | "events" => {
                let id = text(&p, "id")?.to_owned();
                let (connection, generation) = {
                    let state = self.state.lock().unwrap();
                    (
                        state
                            .config
                            .connections
                            .get(&id)
                            .context("unknown host")?
                            .clone(),
                        state.generation,
                    )
                };
                ensure!(
                    connection.status != "pending"
                        && connection.status != "rejected"
                        && connection.status != "expired",
                    "pairing not approved"
                );
                if p["operation"] != "connect" {
                    ensure!(connection.status != "disconnected", "REMOTE_DISCONNECTED");
                }
                let body = if p["operation"] == "events" {
                    let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(50);
                    ensure!((1..=100).contains(&limit), "invalid page limit");
                    let session = text(&p, "sessionId")?;
                    if let Some(cursor) = p.get("cursor").filter(|c| !c.is_null()) {
                        ensure!(
                            cursor.as_str().is_some_and(|s| s.len() <= 1024),
                            "invalid cursor"
                        );
                    }
                    json!({"op":"events","session_id":session,"cursor":p.get("cursor"),"limit":limit})
                } else {
                    json!({"op":if p["operation"]=="connect" {"hello"} else {"catalog"}})
                };
                let result = self.exchange(&connection.address, Some(&id), body).await;
                let mut state = self.state.lock().unwrap();
                ensure!(
                    state.generation == generation && state.config.connections.contains_key(&id),
                    "REMOTE_DISCONNECTED"
                );
                let c = state.config.connections.get_mut(&id).unwrap();
                match result {
                    Ok((value, _, _)) => {
                        c.status = "online".into();
                        c.last_seen = Some(now());
                        c.error = None;
                        drop(state);
                        if p["operation"] == "connect" {
                            Ok(self.status())
                        } else {
                            Ok(value)
                        }
                    }
                    Err(err) => {
                        let status = error_status(&err.to_string());
                        c.status = status.into();
                        c.error = Some(status.into());
                        Err(err)
                    }
                }
            }
            _ => bail!("unsupported remote operation"),
        }
    }

    async fn poll_pair(self: Arc<Self>, id: String, pending: String, expires: u64) {
        loop {
            tokio::select! {_=self.stop.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(700))=>{}}
            let connection = {
                let state = self.state.lock().unwrap();
                state
                    .config
                    .connections
                    .get(&id)
                    .filter(|c| c.status == "pending")
                    .cloned()
            };
            let Some(connection) = connection else { return };
            if now() >= expires {
                if let Some(c) = self.state.lock().unwrap().config.connections.get_mut(&id) {
                    c.status = "expired".into();
                }
                return;
            }
            match self
                .exchange(
                    &connection.address,
                    Some(&id),
                    json!({"op":"pair-status","id":pending}),
                )
                .await
            {
                Ok((v, _, _)) if v["status"] == "approved" => {
                    let mut state = self.state.lock().unwrap();
                    if state
                        .config
                        .connections
                        .get(&id)
                        .is_none_or(|c| c.status != "pending")
                    {
                        return;
                    }
                    let mut next = state.config.clone();
                    let c = next.connections.get_mut(&id).unwrap();
                    c.status = "online".into();
                    c.last_seen = Some(now());
                    if self.persist(&next).is_ok() {
                        state.config = next;
                    } else if let Some(c) = state.config.connections.get_mut(&id) {
                        c.status = "offline".into();
                        c.error = Some("persistence-failed".into());
                    }
                    return;
                }
                Ok((v, _, _)) if v["status"] == "rejected" => {
                    if let Some(c) = self.state.lock().unwrap().config.connections.get_mut(&id) {
                        c.status = "rejected".into();
                    }
                    return;
                }
                Err(e) if e.to_string().contains("IDENTITY_CHANGED") => {
                    if let Some(c) = self.state.lock().unwrap().config.connections.get_mut(&id) {
                        c.status = "identity-changed".into();
                    }
                    return;
                }
                _ => {}
            }
        }
    }

    async fn monitor(self: Arc<Self>) {
        let mut attempts: BTreeMap<String, (u64, u32)> = BTreeMap::new();
        let mut active = std::collections::BTreeSet::new();
        type Heartbeat = (String, u64, Result<(Value, String, String)>);
        let mut tasks: tokio::task::JoinSet<Heartbeat> = tokio::task::JoinSet::new();
        loop {
            tokio::select! {_=self.stop.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(500))=>{}}
            while let Some(Ok((id, generation, result))) = tasks.try_join_next() {
                active.remove(&id);
                let mut state = self.state.lock().unwrap();
                if state.generation != generation {
                    continue;
                }
                let Some(current) = state
                    .config
                    .connections
                    .get_mut(&id)
                    .filter(|c| matches!(c.status.as_str(), "online" | "offline"))
                else {
                    continue;
                };
                match result {
                    Ok(_) => {
                        current.status = "online".into();
                        current.last_seen = Some(now());
                        current.error = None;
                        attempts.remove(&id);
                    }
                    Err(e) => {
                        let status = error_status(&e.to_string());
                        current.status = status.into();
                        current.error = Some(status.into());
                        let count = attempts
                            .get(&id)
                            .map_or(0, |(_, n)| *n)
                            .saturating_add(1)
                            .min(6);
                        attempts.insert(id, (now() + (1u64 << count), count));
                    }
                }
            }
            let connections = self
                .state
                .lock()
                .unwrap()
                .config
                .connections
                .values()
                .filter(|c| matches!(c.status.as_str(), "online" | "offline"))
                .cloned()
                .collect::<Vec<_>>();
            for connection in connections {
                if active.len() >= 16 || active.contains(&connection.id) {
                    continue;
                }
                if connection.status == "offline"
                    && attempts
                        .get(&connection.id)
                        .is_some_and(|(at, _)| *at > now())
                {
                    continue;
                }
                let generation = self.state.lock().unwrap().generation;
                active.insert(connection.id.clone());
                let inner = self.clone();
                tasks.spawn(async move {
                    let result = inner
                        .exchange(
                            &connection.address,
                            Some(&connection.id),
                            json!({"op":"heartbeat"}),
                        )
                        .await;
                    (connection.id, generation, result)
                });
            }
        }
    }

    async fn exchange(
        &self,
        addr: &str,
        pin: Option<&str>,
        body: Value,
    ) -> Result<(Value, String, String)> {
        let addr = address(addr, self.allow_loopback)?;
        let work = async {
            let socket = TcpStream::connect(addr).await.context("REMOTE_OFFLINE")?;
            let mut stream = TlsConnector::from(self.identity.client.clone())
                .connect(
                    rustls::pki_types::ServerName::try_from("agentkib.local")?,
                    socket,
                )
                .await
                .context("REMOTE_OFFLINE")?;
            let cert = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|v| v.first())
                .context("missing device certificate")?;
            let peer = tls::fingerprint(cert);
            ensure!(pin.is_none_or(|p| p == peer), "REMOTE_IDENTITY_CHANGED");
            let exporter = stream.get_ref().1.export_keying_material(
                [0u8; 32],
                b"agentkib-pairing-v1",
                None,
            )?;
            let verification = verification(&exporter, &self.identity.id, &peer);
            write_frame(
                &mut stream,
                &json!({"version":PROTOCOL,"request":body}),
                MAX_REQUEST,
            )
            .await?;
            let response = read_frame(&mut stream, MAX_FRAME).await?;
            ensure!(response["version"] == PROTOCOL, "REMOTE_PROTOCOL_MISMATCH");
            if let Some(error) = response["error"].as_str() {
                bail!(
                    "{}",
                    match error {
                        "revoked" => "REMOTE_REVOKED",
                        "sharing-disabled" => "REMOTE_SHARING_DISABLED",
                        "index-disabled" => "REMOTE_INDEX_DISABLED",
                        "pairing-invalid" => "REMOTE_PAIRING_INVALID",
                        "limit" => "REMOTE_LIMIT",
                        "TRANSCRIPT_CURSOR_INVALID" => "TRANSCRIPT_CURSOR_INVALID",
                        "TRANSCRIPT_CURSOR_STALE" => "TRANSCRIPT_CURSOR_STALE",
                        "TRANSCRIPT_UNREADABLE" => "TRANSCRIPT_UNREADABLE",
                        "TRANSCRIPT_SCAN_STATE_LIMIT" => "TRANSCRIPT_SCAN_STATE_LIMIT",
                        _ => "REMOTE_REQUEST_FAILED",
                    }
                );
            }
            Ok((response["result"].clone(), peer, verification))
        };
        tokio::select! {_=self.stop.cancelled()=>bail!("REMOTE_DISCONNECTED"), result=tokio::time::timeout(Duration::from_secs(10),work)=>result.context("REMOTE_OFFLINE")?}
    }

    async fn serve(self: Arc<Self>, listener: TcpListener, stop: CancellationToken) {
        loop {
            let accepted = tokio::select! {_=self.stop.cancelled()=>return,_=stop.cancelled()=>return,r=listener.accept()=>r};
            let Ok((socket, peer)) = accepted else {
                continue;
            };
            if !matches!(peer.ip(),IpAddr::V4(ip) if allowed(ip,self.allow_loopback)) {
                continue;
            }
            let Ok(permit) = self.permits.clone().try_acquire_owned() else {
                continue;
            };
            let inner = self.clone();
            let stopped = stop.clone();
            tokio::spawn(async move {
                let _permit = permit;
                tokio::select! { _=inner.stop.cancelled()=>{},_=tokio::time::timeout(Duration::from_secs(10),inner.clone().serve_one(socket,stopped))=>{} }
            });
        }
    }
    async fn serve_one(self: Arc<Self>, socket: TcpStream, stop: CancellationToken) -> Result<()> {
        #[cfg(test)]
        let peer_port = socket.peer_addr()?.port();
        let mut stream = TlsAcceptor::from(self.identity.server.clone())
            .accept(socket)
            .await?;
        let cert = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|v| v.first())
            .context("client certificate required")?;
        let peer = tls::fingerprint(cert);
        let grant = self
            .state
            .lock()
            .unwrap()
            .grants
            .get(&peer)
            .cloned()
            .unwrap_or_default();
        let exporter =
            stream
                .get_ref()
                .1
                .export_keying_material([0u8; 32], b"agentkib-pairing-v1", None)?;
        let verify = verification(&exporter, &peer, &self.identity.id);
        #[cfg(test)]
        if let Some(barrier) = self.handshake_barriers.lock().unwrap().remove(&peer_port) {
            let _ = barrier.send(());
        }
        let request = tokio::select! {_=grant.cancelled()=>bail!("revoked"),_=stop.cancelled()=>bail!("sharing-disabled"),r=read_frame(&mut stream,MAX_REQUEST)=>r?};
        ensure!(request["version"] == PROTOCOL, "unsupported protocol");
        // Approval may occur while this TLS peer is still sending its request.
        // Bind protected operations to the current registered grant, never the
        // temporary pairing token captured before reading the frame.
        let grant = if matches!(
            request["request"]["op"].as_str(),
            Some("pair" | "pair-status")
        ) {
            CancellationToken::new()
        } else {
            let grant = self.state.lock().unwrap().grants.get(&peer).cloned();
            let Some(grant) = grant else {
                write_frame(
                    &mut stream,
                    &json!({"version":PROTOCOL,"error":"revoked"}),
                    MAX_FRAME,
                )
                .await?;
                return Ok(());
            };
            grant
        };
        let reading_history = matches!(
            request["request"]["op"].as_str(),
            Some("catalog" | "events")
        );
        let epoch = if reading_history {
            Some(self.source.availability_epoch())
        } else {
            None
        };
        let result = tokio::select! {biased;_=stop.cancelled()=>Err(anyhow::anyhow!("sharing-disabled")),_=grant.cancelled()=>Err(anyhow::anyhow!("revoked")),r=self.clone().network_request(&peer,&verify,&request["request"])=>r};
        let success = result.is_ok();
        let mut value = match result {
            Ok(v) => json!({"version":PROTOCOL,"result":v}),
            Err(e) => json!({"version":PROTOCOL,"error":wire_error(&e.to_string())}),
        };
        if serde_json::to_vec(&value)?.len() > MAX_FRAME {
            value = json!({"version":PROTOCOL,"error":"limit"});
        }
        if success {
            let availability = async {
                if let Some(epoch) = epoch {
                    let epoch = epoch?;
                    loop {
                        ensure!(self.source.availability_epoch()? == epoch, "index-disabled");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
                std::future::pending::<Result<()>>().await
            };
            tokio::select! {biased;_=grant.cancelled()=>bail!("revoked"),_=stop.cancelled()=>bail!("sharing-disabled"),r=availability=>r?,r=write_frame(&mut stream,&value,MAX_FRAME)=>r?}
        } else {
            write_frame(&mut stream, &value, MAX_FRAME).await?;
        }
        stream.shutdown().await?;
        Ok(())
    }
    async fn network_request(
        self: Arc<Self>,
        peer: &str,
        verify: &str,
        p: &Value,
    ) -> Result<Value> {
        let op = text(p, "op")?;
        ensure!(
            self.state.lock().unwrap().config.enabled,
            "sharing-disabled"
        );
        if op == "pair" {
            let device_name = name(text(p, "name")?)?;
            let mut state = self.state.lock().unwrap();
            let code = state.code.as_mut().context("pairing-invalid")?;
            if code.expires_at <= now() || code.attempts >= 5 {
                state.code = None;
                bail!("pairing-invalid");
            }
            code.attempts += 1;
            if p["code"].as_str() != Some(&code.value) {
                if code.attempts >= 5 {
                    state.code = None;
                }
                bail!("pairing-invalid");
            }
            // Exactly one request can consume a valid code; host consent is still required.
            let expires = code.expires_at;
            state.code = None;
            state.pending.clear();
            let id = uuid::Uuid::new_v4().to_string();
            let pending = Pending {
                id: id.clone(),
                device_id: peer.into(),
                name: device_name,
                verification: verify.into(),
                expires_at: expires,
                status: "pending".into(),
            };
            state.pending.insert(id.clone(), pending);
            return Ok(json!({"id":id,"name":state.config.name,"expires_at":expires}));
        }
        if op == "pair-status" {
            let state = self.state.lock().unwrap();
            let pending = state
                .pending
                .get(text(p, "id")?)
                .filter(|v| v.device_id == peer && v.expires_at > now())
                .context("pairing-invalid")?;
            return Ok(json!({"status":pending.status}));
        }
        let (listener, grant) = {
            let state = self.state.lock().unwrap();
            let device = state.config.authorized.get(peer).context("revoked")?;
            (state.listener.clone(), device.grant_id.clone())
        };
        self.source.ensure_available()?;
        let source = self.source.clone();
        let value = match op {
            "hello" => {
                json!({"id":self.identity.id,"capabilities":["catalog","events"],"version":PROTOCOL})
            }
            "heartbeat" => {
                for _ in 0..10 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let state = self.state.lock().unwrap();
                    ensure!(state.config.enabled, "sharing-disabled");
                    ensure!(!listener.is_cancelled(), "sharing-disabled");
                    ensure!(
                        state
                            .config
                            .authorized
                            .get(peer)
                            .is_some_and(|d| d.grant_id == grant),
                        "revoked"
                    );
                    drop(state);
                    self.source.ensure_available()?;
                }
                json!({"capabilities":["catalog","events"]})
            }
            "catalog" => self.read_source(move || source.catalog()).await?,
            "events" => {
                let session = text(p, "session_id")?.to_owned();
                let cursor = p
                    .get("cursor")
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_str().filter(|s| s.len() <= 1024).context("limit"))
                    .transpose()?
                    .map(str::to_owned);
                let limit = p["limit"]
                    .as_u64()
                    .filter(|v| (1..=100).contains(v))
                    .context("limit")? as usize;
                self.read_source(move || source.events(&session, cursor.as_deref(), limit))
                    .await?
            }
            _ => bail!("unsupported operation"),
        };
        let mut state = self.state.lock().unwrap();
        ensure!(state.config.enabled, "sharing-disabled");
        ensure!(!listener.is_cancelled(), "sharing-disabled");
        ensure!(
            state
                .config
                .authorized
                .get(peer)
                .is_some_and(|d| d.grant_id == grant),
            "revoked"
        );
        state.config.authorized.get_mut(peer).unwrap().last_seen = Some(now());
        Ok(value)
    }

    async fn read_source(
        &self,
        read: impl FnOnce() -> Result<Value> + Send + 'static,
    ) -> Result<Value> {
        // Dropping a JoinHandle (timeout/revoke/disconnect) does not cancel a
        // blocking task. Its budget must live with the work, not the socket.
        let permit = self
            .read_permits
            .clone()
            .try_acquire_owned()
            .context("limit")?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            read()
        })
        .await?
    }
}

fn verification(exporter: &[u8], client: &str, server: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(exporter);
    hash.update(client.as_bytes());
    hash.update(server.as_bytes());
    let digest = hash.finalize();
    let n = u32::from_be_bytes(digest[..4].try_into().unwrap()) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}
fn error_status(error: &str) -> &'static str {
    if error.contains("REVOKED") {
        "revoked"
    } else if error.contains("SHARING_DISABLED") {
        "sharing-disabled"
    } else if error.contains("INDEX_DISABLED") {
        "index-disabled"
    } else if error.contains("IDENTITY_CHANGED") {
        "identity-changed"
    } else {
        "offline"
    }
}
fn wire_error(error: &str) -> &'static str {
    if error.contains("index-disabled") || error.contains("INDEX_DISABLED") {
        "index-disabled"
    } else if error.contains("sharing-disabled") {
        "sharing-disabled"
    } else if error.contains("revoked") {
        "revoked"
    } else if error.contains("pairing-invalid") {
        "pairing-invalid"
    } else if let Some(code) = [
        "TRANSCRIPT_CURSOR_INVALID",
        "TRANSCRIPT_CURSOR_STALE",
        "TRANSCRIPT_UNREADABLE",
        "TRANSCRIPT_SCAN_STATE_LIMIT",
    ]
    .into_iter()
    .find(|code| error.contains(code))
    {
        // Return only known codes, never the host's file paths or error detail.
        code
    } else if error.contains("limit") || error.contains("response-too-large") {
        "limit"
    } else {
        "request-failed"
    }
}
async fn read_frame<S: AsyncRead + Unpin>(s: &mut S, max: usize) -> Result<Value> {
    let len = s.read_u32().await? as usize;
    ensure!(len > 0 && len <= max, "limit");
    let mut bytes = vec![0; len];
    s.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn write_frame<S: AsyncWrite + Unpin>(s: &mut S, value: &Value, max: usize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= max, "limit");
    s.write_u32(bytes.len() as u32).await?;
    s.write_all(&bytes).await?;
    s.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[test]
    fn cancelled_read_futures_keep_budget_until_blocking_work_finishes() {
        let pair = Pair::new();
        pair.host.runtime.block_on(async {
            let started = Arc::new(AtomicU64::new(0));
            let mut releases = Vec::new();
            let mut tasks = Vec::new();
            for _ in 0..16 {
                let inner = pair.host.inner.clone();
                let started = started.clone();
                let (release, blocked) = std::sync::mpsc::channel();
                releases.push(release);
                tasks.push(tokio::spawn(async move {
                    inner
                        .read_source(move || {
                            started.fetch_add(1, Ordering::SeqCst);
                            blocked.recv().unwrap();
                            Ok(json!({}))
                        })
                        .await
                }));
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while started.load(Ordering::SeqCst) != 16 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            // Timeout and revoke drop the same read future. Blocking closures
            // continue after abort, and must not admit another batch of reads.
            for task in tasks {
                task.abort();
                let _ = task.await;
            }
            let extra = pair
                .host
                .inner
                .read_source(|| Ok(json!({"unexpected":true})))
                .await;
            for release in releases {
                release.send(()).unwrap();
            }
            assert!(extra.unwrap_err().to_string().contains("limit"));
            tokio::time::timeout(Duration::from_secs(5), async {
                while pair.host.inner.read_permits.available_permits() != 16 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert!(pair.host.inner.read_source(|| Ok(json!({}))).await.is_ok());
        });
    }

    #[test]
    fn history_errors_cross_the_wire_without_private_details() {
        assert_eq!(
            wire_error("TRANSCRIPT_CURSOR_STALE: /private/workspace/transcript.jsonl"),
            "TRANSCRIPT_CURSOR_STALE"
        );
        assert_eq!(
            wire_error("cannot read /private/workspace"),
            "request-failed"
        );
        assert_eq!(wire_error("revoked: TRANSCRIPT_CURSOR_STALE"), "revoked");
    }

    struct Fixture {
        enabled: AtomicBool,
        slow: AtomicBool,
        started: AtomicBool,
        large: AtomicBool,
        epoch: AtomicU64,
    }
    impl Fixture {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                enabled: AtomicBool::new(true),
                slow: AtomicBool::new(false),
                started: AtomicBool::new(false),
                large: AtomicBool::new(false),
                epoch: AtomicU64::new(0),
            })
        }
    }
    impl Source for Fixture {
        fn availability_epoch(&self) -> Result<u64> {
            self.ensure_available()?;
            Ok(self.epoch.load(Ordering::SeqCst))
        }
        fn ensure_available(&self) -> Result<()> {
            ensure!(self.enabled.load(Ordering::SeqCst), "index-disabled");
            Ok(())
        }
        fn catalog(&self) -> Result<Value> {
            self.ensure_available()?;
            if self.large.load(Ordering::SeqCst) {
                return Ok(json!({"synthetic": "x".repeat(3*1024*1024)}));
            }
            Ok(json!({"workspaces":[{"id":"workspace-one","sessions":[{"id":"opaque-session"}]}]}))
        }
        fn events(&self, id: &str, _: Option<&str>, _: usize) -> Result<Value> {
            self.ensure_available()?;
            ensure!(id == "opaque-session", "unknown session");
            self.started.store(true, Ordering::SeqCst);
            if self.slow.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
            }
            self.ensure_available()?;
            Ok(json!({"events":[{"text":"synthetic message"}],"cursor":null}))
        }
    }
    struct Pair {
        host: RemoteService,
        client: RemoteService,
        source: Arc<Fixture>,
        _host_dir: tempfile::TempDir,
        _client_dir: tempfile::TempDir,
        address: String,
    }
    impl Pair {
        fn new() -> Self {
            let hd = tempfile::tempdir().unwrap();
            let cd = tempfile::tempdir().unwrap();
            let source = Fixture::new();
            let host = RemoteService::construct(hd.path().into(), source.clone(), true).unwrap();
            let client = RemoteService::construct(cd.path().into(), Fixture::new(), true).unwrap();
            let status=host.request(json!({"operation":"configure","enabled":true,"address":"127.0.0.1:0","name":"Host"})).unwrap();
            let address = status["local"]["address"].as_str().unwrap().into();
            Self {
                host,
                client,
                source,
                _host_dir: hd,
                _client_dir: cd,
                address,
            }
        }
        fn pending(&self) -> Value {
            let code = self
                .host
                .request(json!({"operation":"generate-code"}))
                .unwrap()["pairing_code"]
                .clone();
            self.client
                .request(json!({"operation":"pair","address":self.address,"code":code}))
                .unwrap()
        }
        fn approve(&self) -> String {
            let response = self.pending();
            let pending =
                self.host.request(json!({"operation":"status"})).unwrap()["pending"][0].clone();
            assert_eq!(response["verification"], pending["verification"]);
            self.host
                .request(json!({"operation":"approve","id":pending["id"]}))
                .unwrap();
            let id = response["id"].as_str().unwrap().to_owned();
            wait(|| {
                self.client.inner.state.lock().unwrap().config.connections[&id].status == "online"
            });
            id
        }
    }
    fn wait(mut f: impl FnMut() -> bool) {
        for _ in 0..80 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("condition timed out");
    }

    #[test]
    fn tls_pairing_requires_host_consent_and_verification_matches() {
        let pair = Pair::new();
        let response = pair.pending();
        let id = response["id"].as_str().unwrap();
        let status = pair.host.request(json!({"operation":"status"})).unwrap();
        assert_eq!(
            status["pending"][0]["verification"],
            response["verification"]
        );
        assert!(
            pair.client
                .request(json!({"operation":"catalog","id":id}))
                .is_err()
        );
        assert!(status["pairing_code"].is_null());
        pair.host
            .request(json!({"operation":"approve","id":status["pending"][0]["id"]}))
            .unwrap();
        wait(|| pair.client.inner.state.lock().unwrap().config.connections[id].status == "online");
        let catalog = pair
            .client
            .request(json!({"operation":"catalog","id":id}))
            .unwrap();
        assert_eq!(catalog["workspaces"][0]["id"], "workspace-one");
        let events = pair
            .client
            .request(json!({"operation":"events","id":id,"sessionId":"opaque-session","limit":100}))
            .unwrap();
        assert_eq!(events["events"].as_array().unwrap().len(), 1);
        assert!(
            pair.client
                .request(json!({"operation":"events","id":id,"sessionId":"../../secret"}))
                .is_err()
        );
    }
    #[test]
    fn unauthorized_tls_client_cannot_read_or_forward_rpc() {
        let p = Pair::new();
        for op in [
            "catalog",
            "events",
            "settings.setSessionIndexEnabled",
            "shell",
        ] {
            let result = p.client.runtime.block_on(p.client.inner.exchange(
                &p.address,
                None,
                json!({"op":op,"session_id":"opaque-session","limit":100}),
            ));
            assert!(result.unwrap_err().to_string().contains("REVOKED"));
        }
        assert!(p.host.request(json!({"operation":"shell"})).is_err());
    }
    #[test]
    fn five_wrong_codes_invalidate_and_expiry_is_enforced() {
        let p = Pair::new();
        let code = p
            .host
            .request(json!({"operation":"generate-code"}))
            .unwrap()["pairing_code"]
            .clone();
        let wrong = if code == "00000000" {
            "00000001"
        } else {
            "00000000"
        };
        for _ in 0..5 {
            assert!(
                p.client
                    .request(json!({"operation":"pair","address":p.address,"code":wrong}))
                    .is_err()
            );
        }
        assert!(p.host.request(json!({"operation":"status"})).unwrap()["pairing_code"].is_null());
        assert!(
            p.client
                .request(json!({"operation":"pair","address":p.address,"code":code}))
                .is_err()
        );
        p.host
            .request(json!({"operation":"generate-code"}))
            .unwrap();
        p.host
            .inner
            .state
            .lock()
            .unwrap()
            .code
            .as_mut()
            .unwrap()
            .expires_at = now() - 1;
        assert!(p.host.request(json!({"operation":"status"})).unwrap()["pairing_code"].is_null());
    }
    #[test]
    fn rejected_and_regenerated_pairing_cannot_authorize() {
        let p = Pair::new();
        let r = p.pending();
        let pending = p.host.request(json!({"operation":"status"})).unwrap()["pending"][0].clone();
        p.host
            .request(json!({"operation":"reject","id":pending["id"]}))
            .unwrap();
        wait(|| {
            p.client.inner.state.lock().unwrap().config.connections[r["id"].as_str().unwrap()]
                .status
                == "rejected"
        });
        assert!(
            p.host
                .request(json!({"operation":"approve","id":pending["id"]}))
                .is_err()
        );
        let _ = p.pending();
        let pending = p.host.request(json!({"operation":"status"})).unwrap()["pending"][0].clone();
        p.host
            .request(json!({"operation":"generate-code"}))
            .unwrap();
        assert!(
            p.host
                .request(json!({"operation":"approve","id":pending["id"]}))
                .is_err()
        );
    }
    #[test]
    fn revoke_prevents_read_and_authorization_is_one_way() {
        let p = Pair::new();
        let id = p.approve();
        assert!(
            p.client.request(json!({"operation":"status"})).unwrap()["authorized"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        p.host
            .request(json!({"operation":"revoke","id":p.client.inner.identity.id}))
            .unwrap();
        let err = p
            .client
            .request(json!({"operation":"catalog","id":id}))
            .unwrap_err();
        assert!(err.to_string().contains("REVOKED"));
    }
    #[test]
    fn revoke_during_events_discards_in_flight_data() {
        let p = Pair::new();
        let id = p.approve();
        p.source.slow.store(true, Ordering::SeqCst);
        std::thread::scope(|scope| {
            let request = scope.spawn(|| {
                p.client
                    .request(json!({"operation":"events","id":id,"sessionId":"opaque-session"}))
            });
            wait(|| p.source.started.load(Ordering::SeqCst));
            p.host
                .request(json!({"operation":"revoke","id":p.client.inner.identity.id}))
                .unwrap();
            assert!(
                request
                    .join()
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("REVOKED")
            );
        });
    }
    #[test]
    fn heartbeat_reports_index_disabled_and_sharing_disabled() {
        let p = Pair::new();
        let id = p.approve();
        p.source.enabled.store(false, Ordering::SeqCst);
        wait(|| {
            p.client.inner.state.lock().unwrap().config.connections[&id].status == "index-disabled"
        });
        p.source.enabled.store(true, Ordering::SeqCst);
        p.client
            .request(json!({"operation":"connect","id":id}))
            .unwrap();
        std::thread::sleep(Duration::from_millis(800));
        p.host
            .request(json!({"operation":"configure","enabled":false,"name":"Host"}))
            .unwrap();
        wait(|| {
            p.client.inner.state.lock().unwrap().config.connections[&id].status
                == "sharing-disabled"
        });
    }
    #[test]
    fn certificate_identity_and_trust_survive_restart_codes_do_not() {
        let p = Pair::new();
        let id = p.approve();
        let hostid = p.host.inner.identity.id.clone();
        let clientid = p.client.inner.identity.id.clone();
        p.host
            .request(json!({"operation":"generate-code"}))
            .unwrap();
        p.host.shutdown();
        p.client.shutdown();
        wait(|| std::net::TcpListener::bind(&p.address).is_ok());
        let hd = p._host_dir.path().to_path_buf();
        let cd = p._client_dir.path().to_path_buf();
        let new_host = RemoteService::construct(hd, Fixture::new(), true).unwrap();
        let new_client = RemoteService::construct(cd, Fixture::new(), true).unwrap();
        assert_eq!(new_host.inner.identity.id, hostid);
        assert_eq!(new_client.inner.identity.id, clientid);
        assert!(new_host.request(json!({"operation":"status"})).unwrap()["pairing_code"].is_null());
        assert!(
            new_host
                .inner
                .state
                .lock()
                .unwrap()
                .config
                .authorized
                .contains_key(&clientid)
        );
        assert!(
            new_client
                .inner
                .state
                .lock()
                .unwrap()
                .config
                .connections
                .contains_key(&id)
        );
        assert_eq!(
            new_host.request(json!({"operation":"status"})).unwrap()["local"]["enabled"],
            true
        );
        new_client
            .request(json!({"operation":"connect","id":id}))
            .unwrap();
    }
    #[test]
    fn exact_certificate_pin_cannot_be_silently_replaced() {
        let p = Pair::new();
        let id = p.approve();
        let other = Pair::new();
        p.client
            .inner
            .state
            .lock()
            .unwrap()
            .config
            .connections
            .get_mut(&id)
            .unwrap()
            .address = other.address;
        assert!(
            p.client
                .request(json!({"operation":"connect","id":id}))
                .unwrap_err()
                .to_string()
                .contains("IDENTITY_CHANGED")
        );
    }
    #[test]
    fn private_address_and_page_bounds_are_enforced() {
        for addr in [
            "0.0.0.0:3000",
            "8.8.8.8:3000",
            "127.0.0.1:3000",
            "[::1]:3000",
            "example.com:443",
        ] {
            assert!(address(addr, false).is_err());
        }
        assert!(address("192.168.1.2:42987", false).is_ok());
        let p = Pair::new();
        let id = p.approve();
        assert!(
            p.client
                .request(
                    json!({"operation":"events","id":id,"sessionId":"opaque-session","limit":201})
                )
                .is_err()
        );
        p.client.runtime.block_on(async {
            let (mut a, mut b) = tokio::io::duplex(32);
            a.write_u32(MAX_FRAME as u32 + 1).await.unwrap();
            assert!(read_frame(&mut b, MAX_FRAME).await.is_err());
        });
    }
    #[cfg(unix)]
    #[test]
    fn private_identity_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let p = Pair::new();
        let path = p._host_dir.path().join("remote/identity.json");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn unrelated_revocation_and_outbound_disconnect_do_not_revoke_reader() {
        let p = Pair::new();
        let id = p.approve();
        p.source.slow.store(true, Ordering::SeqCst);
        std::thread::scope(|scope| {
            let read = scope.spawn(|| {
                p.client
                    .request(json!({"operation":"events","id":id,"sessionId":"opaque-session"}))
            });
            wait(|| p.source.started.load(Ordering::SeqCst));
            p.host
                .request(json!({"operation":"revoke","id":"other-device"}))
                .unwrap();
            p.host
                .request(json!({"operation":"disconnect","id":"other-host"}))
                .unwrap();
            assert!(read.join().unwrap().is_ok());
        });
    }
    #[test]
    fn disabling_index_during_events_never_returns_history() {
        let p = Pair::new();
        let id = p.approve();
        p.source.slow.store(true, Ordering::SeqCst);
        std::thread::scope(|scope| {
            let read = scope.spawn(|| {
                p.client
                    .request(json!({"operation":"events","id":id,"sessionId":"opaque-session"}))
            });
            wait(|| p.source.started.load(Ordering::SeqCst));
            p.source.enabled.store(false, Ordering::SeqCst);
            assert!(
                read.join()
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("INDEX_DISABLED")
            );
        });
    }
    fn interrupted_stream(action: &str) {
        interrupted_stream_after(action, Duration::ZERO);
    }
    fn interrupted_stream_after(action: &str, change_delay: Duration) {
        let p = Pair::new();
        p.approve();
        p.source.large.store(true, Ordering::SeqCst);
        let reading = AtomicBool::new(false);
        let changed = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                wait(|| reading.load(Ordering::SeqCst));
                std::thread::sleep(change_delay);
                if action == "revoke" {
                    p.host
                        .request(json!({"operation":"revoke","id":p.client.inner.identity.id}))
                        .unwrap();
                } else if action == "disable" {
                    p.source.enabled.store(false, Ordering::SeqCst);
                } else {
                    p.source.epoch.fetch_add(2, Ordering::SeqCst);
                }
                changed.store(true, Ordering::SeqCst);
            });
            p.client.runtime.block_on(async {
                let socket = tokio::net::TcpSocket::new_v4().unwrap();
                socket.set_recv_buffer_size(1024).unwrap();
                let tcp = socket.connect(p.address.parse().unwrap()).await.unwrap();
                let mut stream = TlsConnector::from(p.client.inner.identity.client.clone())
                    .connect(
                        rustls::pki_types::ServerName::try_from("agentkib.local").unwrap(),
                        tcp,
                    )
                    .await
                    .unwrap();
                write_frame(
                    &mut stream,
                    &json!({"version":PROTOCOL,"request":{"op":"catalog"}}),
                    MAX_REQUEST,
                )
                .await
                .unwrap();
                let size = stream.read_u32().await.unwrap();
                assert!(size > 3 * 1024 * 1024);
                reading.store(true, Ordering::SeqCst);
                // Revocation persists the grant change before cancelling the stream.
                // Measure cancellation only after that operation has completed; a
                // fixed sleep races filesystem latency on loaded CI runners.
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !changed.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("authorization change must complete");
                // Keep the reader blocked for two availability polling intervals.
                tokio::time::sleep(Duration::from_millis(200)).await;
                let mut buffer = vec![0; size as usize];
                let result =
                    tokio::time::timeout(Duration::from_secs(2), stream.read_exact(&mut buffer))
                        .await;
                assert!(
                    matches!(&result, Ok(Err(_))),
                    "authorization changes must close the partial response immediately: {result:?}"
                );
            });
        });
    }
    #[test]
    fn revocation_interrupts_a_slow_reading_connection_mid_response() {
        interrupted_stream("revoke");
    }
    #[test]
    fn slow_revocation_completion_does_not_consume_the_stream_close_deadline() {
        interrupted_stream_after("revoke", Duration::from_millis(2300));
    }
    #[test]
    fn tls_opened_before_approval_rebinds_the_new_grant_for_stream_revocation() {
        let p = Pair::new();
        p.pending();
        p.source.large.store(true, Ordering::SeqCst);
        let pending = p
            .host
            .inner
            .state
            .lock()
            .unwrap()
            .pending
            .values()
            .next()
            .unwrap()
            .id
            .clone();
        let approved = AtomicBool::new(false);
        let reading = AtomicBool::new(false);
        let revoked = AtomicBool::new(false);
        let (socket, ready) = p.client.runtime.block_on(async {
            let socket = tokio::net::TcpSocket::new_v4().unwrap();
            socket.set_recv_buffer_size(1024).unwrap();
            socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
            let (tx, rx) = tokio::sync::oneshot::channel();
            p.host
                .inner
                .handshake_barriers
                .lock()
                .unwrap()
                .insert(socket.local_addr().unwrap().port(), tx);
            (socket, rx)
        });
        std::thread::scope(|scope| {
            scope.spawn(|| {
                ready.blocking_recv().unwrap();
                assert!(
                    !p.host
                        .inner
                        .state
                        .lock()
                        .unwrap()
                        .grants
                        .contains_key(&p.client.inner.identity.id)
                );
                p.host
                    .request(json!({"operation":"approve","id":pending}))
                    .unwrap();
                approved.store(true, Ordering::SeqCst);
                wait(|| reading.load(Ordering::SeqCst));
                p.host
                    .request(json!({"operation":"revoke","id":p.client.inner.identity.id}))
                    .unwrap();
                revoked.store(true, Ordering::SeqCst);
            });
            p.client.runtime.block_on(async {
                let tcp = socket.connect(p.address.parse().unwrap()).await.unwrap();
                let mut stream = TlsConnector::from(p.client.inner.identity.client.clone())
                    .connect(
                        rustls::pki_types::ServerName::try_from("agentkib.local").unwrap(),
                        tcp,
                    )
                    .await
                    .unwrap();
                while !approved.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                write_frame(
                    &mut stream,
                    &json!({"version":PROTOCOL,"request":{"op":"catalog"}}),
                    MAX_REQUEST,
                )
                .await
                .unwrap();
                let size = stream.read_u32().await.unwrap();
                assert!(size > 3 * 1024 * 1024);
                reading.store(true, Ordering::SeqCst);
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !revoked.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("revocation must complete");
                tokio::time::sleep(Duration::from_millis(200)).await;
                let mut buffer = vec![0; size as usize];
                assert!(
                    tokio::time::timeout(Duration::from_secs(2), stream.read_exact(&mut buffer))
                        .await
                        .is_ok_and(|r| r.is_err())
                );
            });
        });
    }
    #[test]
    fn index_disable_interrupts_a_slow_reading_connection_mid_response() {
        interrupted_stream("disable");
    }
    #[test]
    fn quick_index_disable_and_reenable_interrupts_old_response() {
        interrupted_stream("toggle");
    }
    #[cfg(unix)]
    #[test]
    fn existing_permissions_are_hardened_and_symlink_directories_rejected() {
        use std::os::unix::{fs::PermissionsExt, fs::symlink};
        let dir = tempfile::tempdir().unwrap();
        let first = tls::TlsIdentity::load(&dir.path().join("remote")).unwrap();
        let file = dir.path().join("remote/identity.json");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let second = tls::TlsIdentity::load(&dir.path().join("remote")).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let linked = dir.path().join("linked");
        symlink(dir.path().join("remote"), &linked).unwrap();
        assert!(tls::TlsIdentity::load(&linked).is_err());
    }
}
