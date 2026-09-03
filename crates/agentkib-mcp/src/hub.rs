use std::borrow::Cow;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use agentkib_core::{
    AgentKind, McpHubStatus, McpNetworkSettings, McpServerConfig, McpToolDescriptor,
};
use agentkib_store::Store;
use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{ConnectInfo, Path as AxumPath, Query};
use axum::routing::get;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData, ServerHandler};
use serde_json::Value;
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

use crate::OAuthManager;
use crate::builtin;
use crate::config::load_visible_servers;
use crate::runtime::RuntimeManager;

pub struct HubController {
    runtime: Arc<Runtime>,
    manager: RuntimeManager,
    oauth: OAuthManager,
    database_path: std::path::PathBuf,
    state: Arc<Mutex<ControllerState>>,
}

struct ControllerState {
    settings: McpNetworkSettings,
    cancellation: Option<CancellationToken>,
    status: McpHubStatus,
}

impl HubController {
    pub fn new(settings: McpNetworkSettings) -> Result<Self> {
        Self::with_database(settings, agentkib_store::default_database_path()?)
    }

    fn with_database(
        settings: McpNetworkSettings,
        database_path: std::path::PathBuf,
    ) -> Result<Self> {
        let bind_address = bind_address(&settings).to_string();
        Ok(Self {
            runtime: Arc::new(Runtime::new()?),
            manager: RuntimeManager::new(),
            oauth: OAuthManager::default(),
            database_path,
            state: Arc::new(Mutex::new(ControllerState {
                settings: settings.clone(),
                cancellation: None,
                status: McpHubStatus {
                    running: false,
                    bind_address,
                    port: settings.port,
                    lan_enabled: settings.lan_enabled,
                    accessible_addresses: accessible_addresses(&settings),
                    runtime_count: 0,
                    error_count: 0,
                    last_error: None,
                },
            })),
        })
    }

    pub fn start(&self) -> Result<()> {
        let settings = self
            .state
            .lock()
            .expect("MCP Hub controller state lock")
            .settings
            .clone();
        let listener = bind_listener(&settings)?;
        self.start_with_listener(settings, listener);
        Ok(())
    }

    fn start_with_listener(&self, settings: McpNetworkSettings, listener: std::net::TcpListener) {
        let cancellation = CancellationToken::new();
        {
            let mut state = self.state.lock().expect("MCP Hub controller state lock");
            state.settings = settings.clone();
            state.cancellation = Some(cancellation.clone());
            state.status.running = true;
            state.status.bind_address = bind_address(&settings).to_string();
            state.status.port = settings.port;
            state.status.lan_enabled = settings.lan_enabled;
            state.status.accessible_addresses = accessible_addresses(&settings);
            state.status.last_error = None;
        }
        let state = self.state.clone();
        let manager = self.manager.clone();
        let oauth = self.oauth.clone();
        let database_path = self.database_path.clone();
        self.runtime.spawn(async move {
            let reaper_manager = manager.clone();
            let reaper_cancellation = cancellation.child_token();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    tokio::select! {
                        _ = reaper_cancellation.cancelled() => break,
                        _ = interval.tick() => {
                            reaper_manager.reap_idle(chrono::Duration::minutes(15)).await;
                        }
                    }
                }
            });
            if let Err(error) = run_server(
                settings,
                manager,
                oauth,
                database_path,
                cancellation,
                listener,
            )
            .await
            {
                let mut value = state.lock().expect("MCP Hub controller state lock");
                value.status.running = false;
                value.status.error_count += 1;
                value.status.last_error = Some(error.to_string());
            }
        });
    }

    pub fn restart(&self, settings: McpNetworkSettings) -> Result<()> {
        if settings.lan_enabled && !settings.lan_risk_accepted {
            anyhow::bail!("LAN mode requires explicit risk acceptance");
        }
        let (old_settings, old_cancellation, was_running) = {
            let state = self.state.lock().expect("MCP Hub controller state lock");
            (
                state.settings.clone(),
                state.cancellation.clone(),
                state.status.running,
            )
        };
        let old_address = SocketAddr::new(bind_address(&old_settings), old_settings.port);
        let new_address = SocketAddr::new(bind_address(&settings), settings.port);
        if was_running && old_address == new_address {
            return Ok(());
        }

        if new_address != old_address && settings.port != old_settings.port {
            // Reserve the new endpoint before touching the currently healthy Hub. A
            // fixed-port collision therefore leaves the old service untouched.
            let listener = bind_listener(&settings)?;
            if let Some(old) = old_cancellation {
                old.cancel();
            }
            self.start_with_listener(settings, listener);
            return Ok(());
        }

        if let Some(old) = old_cancellation {
            old.cancel();
        }
        let listener = wait_for_listener(&settings).inspect_err(|_| {
            if let Ok(listener) = wait_for_listener(&old_settings) {
                self.start_with_listener(old_settings, listener);
            }
        })?;
        self.start_with_listener(settings, listener);
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Some(cancellation) = self
            .state
            .lock()
            .expect("MCP Hub controller state lock")
            .cancellation
            .take()
        {
            cancellation.cancel();
        }
        self.runtime.block_on(self.manager.stop(None));
        self.state
            .lock()
            .expect("MCP Hub controller state lock")
            .status
            .running = false;
    }

    pub fn status(&self) -> McpHubStatus {
        let runtime_statuses = self.runtime.block_on(self.manager.statuses());
        let mut status = self
            .state
            .lock()
            .expect("MCP Hub controller state lock")
            .status
            .clone();
        status.runtime_count = runtime_statuses
            .iter()
            .filter(|value| matches!(value.state, agentkib_core::McpRuntimeState::Running))
            .count();
        status.error_count += runtime_statuses
            .iter()
            .filter(|value| matches!(value.state, agentkib_core::McpRuntimeState::Error))
            .count();
        status
    }

    pub fn settings(&self) -> McpNetworkSettings {
        self.state
            .lock()
            .expect("MCP Hub controller state lock")
            .settings
            .clone()
    }

    pub fn runtime_statuses(&self) -> Vec<agentkib_core::McpRuntimeStatus> {
        self.runtime.block_on(self.manager.statuses())
    }

    pub fn probe(&self, server: &McpServerConfig) -> Result<Vec<McpToolDescriptor>> {
        self.runtime.block_on(self.manager.probe(server))
    }

    pub fn stop_runtime(&self, server_id: Option<&str>) {
        self.runtime.block_on(self.manager.stop(server_id));
    }

    pub fn start_oauth(&self, server: &McpServerConfig) -> Result<String> {
        let redirect_uri = format!(
            "http://127.0.0.1:{}/oauth/callback/{}",
            self.settings().port,
            server.id
        );
        self.runtime
            .block_on(self.oauth.start(server, &redirect_uri))
    }
}

async fn run_server(
    settings: McpNetworkSettings,
    manager: RuntimeManager,
    oauth: OAuthManager,
    database_path: std::path::PathBuf,
    cancellation: CancellationToken,
    listener: std::net::TcpListener,
) -> Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let service: StreamableHttpService<HubService, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(HubService::new(manager.clone(), database_path.clone())),
            Default::default(),
            server_config(&settings, cancellation.child_token()),
        );
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/oauth/callback/{server_id}",
            get(
                move |AxumPath(server_id), Query(query): Query<OAuthCallbackQuery>| {
                    oauth_callback(oauth.clone(), server_id, query)
                },
            ),
        )
        .route_service("/mcp/v1/workspaces/{workspace_id}/agents/{agent}", service);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(cancellation.cancelled_owned())
    .await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct OAuthCallbackQuery {
    code: String,
    state: String,
    iss: Option<String>,
}

async fn oauth_callback(
    oauth: OAuthManager,
    server_id: String,
    query: OAuthCallbackQuery,
) -> (axum::http::StatusCode, &'static str) {
    match oauth
        .complete(&server_id, &query.code, &query.state, query.iss.as_deref())
        .await
    {
        Ok(()) => (
            axum::http::StatusCode::OK,
            "AgentKib MCP authorization completed. You can close this window.",
        ),
        Err(_) => (
            axum::http::StatusCode::BAD_REQUEST,
            "AgentKib MCP authorization failed. Return to AgentKib and try again.",
        ),
    }
}

fn bind_listener(settings: &McpNetworkSettings) -> Result<std::net::TcpListener> {
    let address = SocketAddr::new(bind_address(settings), settings.port);
    let listener = std::net::TcpListener::bind(address)
        .with_context(|| format!("Unable to bind AgentKib MCP Hub to {address}"))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

fn wait_for_listener(settings: &McpNetworkSettings) -> Result<std::net::TcpListener> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match bind_listener(settings) {
            Ok(listener) => return Ok(listener),
            Err(error) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
                drop(error);
            }
            Err(error) => return Err(error),
        }
    }
}

fn server_config(
    settings: &McpNetworkSettings,
    cancellation: CancellationToken,
) -> StreamableHttpServerConfig {
    let port = settings.port;
    let config = StreamableHttpServerConfig::default()
        .with_json_response(true)
        .with_cancellation_token(cancellation)
        .with_allowed_origins([
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ]);
    if settings.lan_enabled {
        config.disable_allowed_hosts()
    } else {
        config.with_allowed_hosts([
            "127.0.0.1".to_string(),
            "localhost".to_string(),
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
        ])
    }
}

fn bind_address(settings: &McpNetworkSettings) -> IpAddr {
    if settings.lan_enabled {
        IpAddr::from([0, 0, 0, 0])
    } else {
        IpAddr::from([127, 0, 0, 1])
    }
}

fn accessible_addresses(settings: &McpNetworkSettings) -> Vec<String> {
    let mut addresses = vec![format!("127.0.0.1:{}", settings.port)];
    if settings.lan_enabled
        && let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0")
        && socket.connect("8.8.8.8:80").is_ok()
        && let Ok(address) = socket.local_addr()
        && !address.ip().is_loopback()
    {
        addresses.push(format!("{}:{}", address.ip(), settings.port));
    }
    addresses
}

#[derive(Clone)]
struct HubService {
    manager: RuntimeManager,
    database_path: std::path::PathBuf,
}

impl HubService {
    fn new(manager: RuntimeManager, database_path: std::path::PathBuf) -> Self {
        Self {
            manager,
            database_path,
        }
    }

    fn request_scope(context: &RequestContext<RoleServer>) -> Result<RequestScope> {
        let parts = context
            .extensions
            .get::<http::request::Parts>()
            .context("MCP request is missing HTTP context")?;
        let segments: Vec<_> = parts.uri.path().trim_matches('/').split('/').collect();
        let workspace_index = segments
            .iter()
            .position(|value| *value == "workspaces")
            .context("MCP workspace path is invalid")?;
        let workspace_segment = segments
            .get(workspace_index + 1)
            .context("MCP workspace id is missing")?;
        let workspace_id = agentkib_core::decode_url_path_segment(workspace_segment)?;
        let agent = segments
            .get(workspace_index + 3)
            .context("MCP Agent is missing")?;
        let agent = parse_agent(agent)?;
        let remote = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|value| !value.0.ip().is_loopback())
            .unwrap_or(false);
        Ok(RequestScope {
            workspace_id,
            agent,
            remote,
        })
    }

    fn workspace_and_servers(
        &self,
        scope: &RequestScope,
    ) -> Result<(std::path::PathBuf, Vec<McpServerConfig>)> {
        let store = Store::open(&self.database_path)?;
        let project = store.workspace_path(&scope.workspace_id)?;
        let servers = load_visible_servers(Some(&project), scope.agent)?;
        Ok((project, servers))
    }
}

impl ServerHandler for HubService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("AgentKib local MCP Hub")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let scope = Self::request_scope(&context).map_err(protocol_error)?;
        let (_project, servers) = self.workspace_and_servers(&scope).map_err(protocol_error)?;
        let mut tools = if scope.remote {
            Vec::new()
        } else {
            builtin::definitions()
        };
        for server in servers {
            let server_tools = self.manager.cached_tools(&server).map_err(protocol_error)?;
            for mut tool in server_tools {
                if scope.remote
                    && !server
                        .lan_allow_tools
                        .iter()
                        .any(|name| name == tool.name.as_ref())
                {
                    continue;
                }
                tool.name = Cow::Owned(format!("{}__{}", server.id, tool.name));
                tools.push(tool);
            }
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let scope = Self::request_scope(&context).map_err(protocol_error)?;
        let (project, servers) = self.workspace_and_servers(&scope).map_err(protocol_error)?;
        let arguments = Value::Object(request.arguments.clone().unwrap_or_default());
        if builtin::BUILTIN_TOOL_NAMES.contains(&request.name.as_ref()) {
            if scope.remote {
                return Ok(builtin::error_result(
                    "Built-in AgentKib tools are not exposed over unauthenticated LAN mode",
                )
                .into());
            }
            return Ok(builtin::call(
                &project,
                &scope.workspace_id,
                scope.agent,
                request.name.as_ref(),
                &arguments,
            )
            .unwrap_or_else(builtin::error_result)
            .into());
        }
        let Some((server_id, tool_name)) = request.name.split_once("__") else {
            return Ok(builtin::error_result("Unknown MCP tool").into());
        };
        let Some(server) = servers.iter().find(|server| server.id == server_id) else {
            return Ok(builtin::error_result("MCP server is not visible in this scope").into());
        };
        if scope.remote && !server.lan_allow_tools.iter().any(|name| name == tool_name) {
            return Ok(builtin::error_result("Tool is not allowed over LAN").into());
        }
        let result = self
            .manager
            .call(server, tool_name, request.arguments)
            .await
            .unwrap_or_else(builtin::error_result);
        Ok(result.into())
    }
}

struct RequestScope {
    workspace_id: String,
    agent: AgentKind,
    remote: bool,
}

fn parse_agent(value: &str) -> Result<AgentKind> {
    match value {
        "codex" => Ok(AgentKind::Codex),
        "claude-code" => Ok(AgentKind::ClaudeCode),
        "cursor" => Ok(AgentKind::Cursor),
        "opencode" => Ok(AgentKind::OpenCode),
        "openclaw" | "open-claw" => Ok(AgentKind::OpenClaw),
        "hermes" => Ok(AgentKind::Hermes),
        "grok" | "grok-build" => Ok(AgentKind::GrokBuild),
        "deepseek-harness" | "dsh" => Ok(AgentKind::DeepSeekHarness),
        _ => anyhow::bail!("Unknown Agent: {value}"),
    }
}

fn protocol_error(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    use rmcp::service::ServiceExt;
    use rmcp::transport::StreamableHttpClientTransport;
    use tempfile::tempdir;

    use super::*;

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn wait_for_health(port: u16) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
                if stream
                    .write_all(
                        b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    )
                    .is_err()
                {
                    std::thread::sleep(Duration::from_millis(25));
                    continue;
                }
                let mut response = String::new();
                if stream.read_to_string(&mut response).is_ok()
                    && response.starts_with("HTTP/1.1 200")
                    && response.ends_with("ok")
                {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn starts_one_http_hub_and_releases_the_port_on_shutdown() {
        let settings = McpNetworkSettings {
            port: free_port(),
            ..Default::default()
        };
        let hub = HubController::new(settings.clone()).unwrap();
        hub.start().unwrap();
        assert!(wait_for_health(settings.port));
        hub.shutdown();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && TcpStream::connect(("127.0.0.1", settings.port)).is_ok()
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(TcpListener::bind(("127.0.0.1", settings.port)).is_ok());
    }

    #[test]
    fn reports_a_fixed_port_collision_instead_of_drifting() {
        let settings = McpNetworkSettings {
            port: free_port(),
            ..Default::default()
        };
        let first = HubController::new(settings.clone()).unwrap();
        first.start().unwrap();
        assert!(wait_for_health(settings.port));
        let second = HubController::new(settings.clone()).unwrap();
        assert!(second.start().is_err());
        assert!(!second.status().running);
        assert_eq!(second.status().port, settings.port);
        assert!(second.status().last_error.is_none());
        second.shutdown();
        first.shutdown();
    }

    #[test]
    fn failed_port_change_keeps_the_existing_hub_running() {
        let old_settings = McpNetworkSettings {
            port: free_port(),
            ..Default::default()
        };
        let blocked_port = free_port();
        let _blocker = TcpListener::bind(("127.0.0.1", blocked_port)).unwrap();
        let hub = HubController::new(old_settings.clone()).unwrap();
        hub.start().unwrap();
        assert!(wait_for_health(old_settings.port));

        assert!(
            hub.restart(McpNetworkSettings {
                port: blocked_port,
                ..Default::default()
            })
            .is_err()
        );
        assert!(wait_for_health(old_settings.port));
        assert_eq!(hub.status().port, old_settings.port);
        hub.shutdown();
    }

    #[test]
    fn can_switch_from_loopback_to_lan_on_the_same_port() {
        let settings = McpNetworkSettings {
            port: free_port(),
            ..Default::default()
        };
        let hub = HubController::new(settings.clone()).unwrap();
        hub.start().unwrap();
        assert!(wait_for_health(settings.port));

        hub.restart(McpNetworkSettings {
            port: settings.port,
            lan_enabled: true,
            lan_risk_accepted: true,
        })
        .unwrap();
        assert!(wait_for_health(settings.port));
        assert!(hub.status().lan_enabled);
        hub.shutdown();
    }

    #[test]
    fn negotiates_mcp_and_lists_the_eight_builtin_tools() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(project.join(".git")).unwrap();
        let database = dir.path().join("agentkib.db");
        let workspace = Store::open(&database)
            .unwrap()
            .add_workspace(&project)
            .unwrap();
        let settings = McpNetworkSettings {
            port: free_port(),
            ..Default::default()
        };
        let hub = HubController::with_database(settings.clone(), database).unwrap();
        hub.start().unwrap();
        assert!(wait_for_health(settings.port));
        let url = format!(
            "http://127.0.0.1:{}/mcp/v1/workspaces/{}/agents/codex",
            settings.port, workspace.id
        );
        hub.runtime.block_on(async {
            let running = ().serve(StreamableHttpClientTransport::from_uri(url)).await.unwrap();
            let names: Vec<_> = running
                .peer()
                .list_all_tools()
                .await
                .unwrap()
                .into_iter()
                .map(|tool| tool.name.to_string())
                .collect();
            for name in builtin::BUILTIN_TOOL_NAMES {
                assert!(names.contains(&name.to_string()));
            }
            running.cancel().await.unwrap();
        });
        hub.shutdown();
    }

    #[test]
    fn decodes_workspace_path_segments_before_store_lookup() {
        assert_eq!(
            agentkib_core::decode_url_path_segment("team%2Fproject%3Ftag%23one%20two").unwrap(),
            "team/project?tag#one two"
        );
        assert!(agentkib_core::decode_url_path_segment("team%GG").is_err());
    }
}
