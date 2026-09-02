use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Codex,
    ClaudeCode,
    Cursor,
    #[serde(rename = "opencode")]
    OpenCode,
    OpenClaw,
    Hermes,
    GrokBuild,
    #[serde(rename = "deepseek-harness")]
    DeepSeekHarness,
}

impl AgentKind {
    pub const ALL: [Self; 8] = [
        Self::Codex,
        Self::ClaudeCode,
        Self::Cursor,
        Self::OpenCode,
        Self::OpenClaw,
        Self::Hermes,
        Self::GrokBuild,
        Self::DeepSeekHarness,
    ];

    /// Agents whose native configuration AgentKib may generate today.
    /// DeepSeek Harness remains read-only while its persistence contracts are beta.
    pub const WRITABLE: [Self; 7] = [
        Self::Codex,
        Self::ClaudeCode,
        Self::Cursor,
        Self::OpenCode,
        Self::OpenClaw,
        Self::Hermes,
        Self::GrokBuild,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Cursor => "cursor",
            Self::OpenCode => "opencode",
            Self::OpenClaw => "openclaw",
            Self::Hermes => "hermes",
            Self::GrokBuild => "grok-build",
            Self::DeepSeekHarness => "deepseek-harness",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstructionSet {
    #[serde(default)]
    pub shared: String,
    #[serde(default)]
    pub scoped: Vec<ScopedInstruction>,
    #[serde(default)]
    pub platform_overrides: BTreeMap<AgentKind, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedInstruction {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub targets: Vec<AgentKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum ConnectionTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionDefinition {
    pub name: String,
    #[serde(flatten)]
    pub transport: ConnectionTransport,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub targets: Vec<AgentKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryPolicy {
    #[serde(default = "default_true")]
    pub require_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestMcpConfig {
    #[serde(default = "default_mcp_config_path")]
    pub config: String,
}

impl Default for ManifestMcpConfig {
    fn default() -> Self {
        Self {
            config: default_mcp_config_path(),
        }
    }
}

fn default_mcp_config_path() -> String {
    "mcp.json".into()
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            require_approval: true,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AdapterState {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub generated_hashes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub workspace: WorkspaceIdentity,
    #[serde(default)]
    pub instructions: InstructionSet,
    #[serde(default)]
    pub skills: Vec<SkillDefinition>,
    #[serde(default)]
    pub mcp: ManifestMcpConfig,
    /// Legacy schema v1 connections. They are imported into `.agentkib/mcp.json`
    /// when the user applies the migration ChangeSet.
    #[serde(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<ConnectionDefinition>,
    #[serde(default)]
    pub memories: MemoryPolicy,
    #[serde(default)]
    pub adapters: BTreeMap<AgentKind, AdapterState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpPackageKind {
    Npm,
    Pypi,
    Remote,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum McpServerTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<PathBuf>,
    },
    StreamableHttp {
        url: String,
    },
    /// Accepted only for importing older native configurations.
    Sse {
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(flatten)]
    pub transport: McpServerTransport,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_credentials: Option<serde_json::Value>,
    #[serde(skip)]
    pub local_config_path: Option<PathBuf>,
    #[serde(default)]
    pub targets: Vec<AgentKind>,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub lan_allow_tools: Vec<String>,
    #[serde(default)]
    pub supports_parallel_tool_calls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<McpPackageReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPackageReference {
    pub kind: McpPackageKind,
    pub identifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfigDocument {
    #[serde(default = "default_mcp_document_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

impl Default for McpConfigDocument {
    fn default() -> Self {
        Self {
            schema_version: default_mcp_document_version(),
            servers: Vec::new(),
        }
    }
}

fn default_mcp_document_version() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpRuntimeState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpNetworkSettings {
    pub port: u16,
    pub lan_enabled: bool,
    #[serde(default)]
    pub lan_risk_accepted: bool,
}

impl Default for McpNetworkSettings {
    fn default() -> Self {
        Self {
            port: 47_653,
            lan_enabled: false,
            lan_risk_accepted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpHubStatus {
    pub running: bool,
    pub bind_address: String,
    pub port: u16,
    pub lan_enabled: bool,
    #[serde(default)]
    pub accessible_addresses: Vec<String>,
    pub runtime_count: usize,
    pub error_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpRuntimeStatus {
    pub server_id: String,
    pub server_name: String,
    pub config_hash: String,
    pub state: McpRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpInstallation {
    pub id: String,
    pub name: String,
    pub package_kind: McpPackageKind,
    pub identifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_path: Option<PathBuf>,
    pub status: String,
    pub installed_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpRegistryEntry {
    pub name: String,
    pub description: String,
    pub version: String,
    pub package_kind: McpPackageKind,
    pub identifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub required_env: Vec<String>,
    #[serde(default)]
    pub runtime_arguments: Vec<String>,
    #[serde(default)]
    pub package_arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDescriptor {
    pub server_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpMigrationCandidate {
    pub id: String,
    pub agent: AgentKind,
    pub scope: String,
    pub name: String,
    pub source_path: PathBuf,
    pub transport: String,
    pub endpoint: String,
    pub has_secret_values: bool,
    pub supported: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthStart {
    pub authorization_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetKind {
    Instruction,
    Skill,
    Connection,
    Agent,
    Hook,
    Memory,
    Configuration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRecord {
    pub agent: AgentKind,
    pub kind: AssetKind,
    pub path: PathBuf,
    pub exists: bool,
    pub size: u64,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub summary_params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDetection {
    pub agent: AgentKind,
    pub detected: bool,
    pub asset_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceScan {
    pub root: PathBuf,
    pub manifest_exists: bool,
    pub agents: Vec<AgentDetection>,
    pub assets: Vec<AssetRecord>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceValidation {
    pub valid: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceStatus {
    Healthy,
    Attention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoveryEvidence {
    SessionCwd,
    ConfiguredWorkspace,
    ScanMarker,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryCandidate {
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub source_agent: Option<AgentKind>,
    pub evidence: DiscoveryEvidence,
    pub last_active_at: Option<DateTime<Utc>>,
    pub session_count: u64,
    pub explicit_workspace: bool,
    pub repository_group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSource {
    pub agent: Option<AgentKind>,
    pub evidence: DiscoveryEvidence,
    pub session_count: u64,
    pub last_active_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub repository_group_id: Option<String>,
    pub manifest_workspace_id: Option<String>,
    pub status: WorkspaceStatus,
    pub asset_count: u64,
    pub warning_count: u64,
    pub last_active_at: Option<DateTime<Utc>>,
    pub last_scanned_at: Option<DateTime<Utc>>,
    pub sources: Vec<WorkspaceSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryGroup {
    pub id: String,
    pub workspaces: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstallation {
    pub agent: AgentKind,
    pub installed: bool,
    pub configured: bool,
    pub version: Option<String>,
    pub home: Option<PathBuf>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolState {
    Current,
    UpdateAvailable,
    Uninstalled,
    Conflict,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolChannel {
    OfficialInstaller,
    Npm,
    Pnpm,
    Bun,
    Yarn,
    Homebrew,
    Volta,
    DesktopApp,
    Nix,
    Local,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolEnvironment {
    System,
    Standalone,
    Nvm,
    Fnm,
    Mise,
    Volta,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolInstallation {
    pub id: String,
    pub path: PathBuf,
    pub resolved_path: PathBuf,
    pub version: Option<String>,
    pub runnable: bool,
    pub error: Option<String>,
    pub channel: AgentToolChannel,
    pub environment: AgentToolEnvironment,
    pub manager_path: Option<PathBuf>,
    pub is_path_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolActionKind {
    Install,
    Update,
    OpenDocumentation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolActionMode {
    Execute,
    CopyCommand,
    OpenDocumentation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolShell {
    Posix,
    Powershell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolAction {
    pub id: String,
    pub kind: AgentToolActionKind,
    pub mode: AgentToolActionMode,
    pub channel: AgentToolChannel,
    pub shell: Option<AgentToolShell>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub target_version: Option<String>,
    pub installation_id: Option<String>,
    pub manager_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolStatus {
    pub agent: AgentKind,
    pub installed: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub recommended_version: Option<String>,
    pub upstream_version: Option<String>,
    pub state: AgentToolState,
    pub channel: AgentToolChannel,
    pub installations: Vec<AgentToolInstallation>,
    pub warnings: Vec<String>,
    pub official_url: String,
    pub release_url: Option<String>,
    pub actions: Vec<AgentToolAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolExecutionStatus {
    Succeeded,
    Failed,
    TimedOut,
    Busy,
    Unchanged,
    VerificationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolExecutionResult {
    pub agent: AgentKind,
    pub action_id: String,
    pub status: AgentToolExecutionStatus,
    pub exit_code: Option<i32>,
    pub output: String,
    pub installation_id: Option<String>,
    pub before_version: Option<String>,
    pub after_version: Option<String>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentToolCacheStatus {
    Fresh,
    Cached,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolSnapshot {
    pub tools: Vec<AgentToolStatus>,
    pub checked_at: DateTime<Utc>,
    pub latest_checked_at: Option<DateTime<Utc>>,
    pub cache_status: AgentToolCacheStatus,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogScope {
    Workspace,
    AgentHome,
    AgentkibHome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillSourceKind {
    OpenaiCurated,
    Github,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillSource {
    pub kind: SkillSourceKind,
    pub repository: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub path: String,
    pub resolved_commit: String,
    pub tree_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillFileEntry {
    pub path: String,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub source: SkillSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillCatalogEntry {
    #[serde(flatten)]
    pub candidate: SkillCandidate,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillCatalogSnapshot {
    pub entries: Vec<SkillCatalogEntry>,
    pub cached_at: DateTime<Utc>,
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstalledSkillStatus {
    Current,
    UpdateAvailable,
    Modified,
    Unmanaged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledSkill {
    /// Stable lifecycle identifier derived from the library directory name.
    pub name: String,
    /// User-facing package name read from SKILL.md frontmatter.
    pub display_name: String,
    pub description: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
    pub status: InstalledSkillStatus,
    pub source: Option<SkillSource>,
    pub installed_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub can_rollback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillOperationKind {
    Install,
    Update,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillOperationPreview {
    pub token: String,
    pub operation: SkillOperationKind,
    pub skill: SkillCandidate,
    pub files: Vec<SkillFileEntry>,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub total_size: u64,
    pub local_modified: bool,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemovedSkill {
    pub id: String,
    /// Stable lifecycle identifier derived from the former library directory name.
    pub name: String,
    /// User-facing package name captured when the package was removed.
    pub display_name: String,
    pub removed_at: DateTime<Utc>,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillFilePreview {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogAsset {
    pub id: String,
    pub scope: CatalogScope,
    pub workspace_id: Option<String>,
    pub agent: Option<AgentKind>,
    pub kind: AssetKind,
    pub name: String,
    pub path: PathBuf,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub summary_params: BTreeMap<String, String>,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryReport {
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub discovered_count: usize,
    pub removed_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRoot {
    pub id: String,
    pub path: PathBuf,
    pub enabled: bool,
    pub max_depth: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcludedWorkspace {
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub action: String,
    pub detail: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSection {
    pub source: PathBuf,
    pub scope: String,
    pub content: String,
    pub precedence: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPreview {
    pub agent: AgentKind,
    pub project: PathBuf,
    pub cwd: PathBuf,
    pub sections: Vec<ContextSection>,
    pub visible_skills: Vec<String>,
    pub visible_connections: Vec<String>,
    pub approved_memories: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoctorStatus {
    Healthy,
    Attention,
    Unavailable,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorAssetStatus {
    pub status: DoctorStatus,
    pub expected: usize,
    pub actual: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorAgentRow {
    pub agent: AgentKind,
    pub detected: bool,
    pub installed: bool,
    pub enabled: bool,
    pub writable: bool,
    pub instructions: DoctorAssetStatus,
    pub skills: DoctorAssetStatus,
    pub mcp: DoctorAssetStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorIssue {
    pub id: String,
    pub code: String,
    pub severity: DoctorSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_kind: Option<AssetKind>,
    pub repairable: bool,
    pub evidence: Vec<DoctorEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextDoctorSummary {
    pub workspace_id: String,
    pub error_count: usize,
    pub warning_count: usize,
    pub info_count: usize,
    pub repairable_count: usize,
    pub checked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextDoctorReport {
    pub summary: ContextDoctorSummary,
    pub matrix: Vec<DoctorAgentRow>,
    pub issues: Vec<DoctorIssue>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeScope {
    Project,
    AgentHome,
    ApplicationData,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub target: PathBuf,
    pub scope: ChangeScope,
    pub original_hash: Option<String>,
    pub before: String,
    pub after: String,
    pub risk: RiskLevel,
    pub validator: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub id: String,
    pub project_root: PathBuf,
    pub created_at: DateTime<Utc>,
    pub changes: Vec<FileChange>,
    pub requires_home_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyReport {
    pub changeset_id: String,
    pub applied: Vec<PathBuf>,
    pub backup_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    UserPreference,
    ProjectFact,
    Decision,
    Constraint,
    FailedAttempt,
    OpenLoop,
    TaskState,
    AgentObservation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Pending,
    Approved,
    Rejected,
    Invalidated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub project_id: String,
    pub memory_type: MemoryType,
    pub content: String,
    pub status: MemoryStatus,
    pub source_agent: Option<String>,
    pub source_thread: Option<String>,
    pub source_reference: Option<String>,
    pub created_at: DateTime<Utc>,
    pub approved_at: Option<DateTime<Utc>>,
    pub invalidated_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryProposal {
    pub project_id: String,
    pub memory_type: MemoryType,
    pub content: String,
    pub source_agent: Option<String>,
    pub source_thread: Option<String>,
    pub source_reference: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_harness_uses_the_public_stable_id() {
        assert_eq!(
            serde_json::to_string(&AgentKind::DeepSeekHarness).unwrap(),
            "\"deepseek-harness\""
        );
        assert_eq!(
            serde_json::from_str::<AgentKind>("\"deepseek-harness\"").unwrap(),
            AgentKind::DeepSeekHarness
        );
        assert!(!AgentKind::WRITABLE.contains(&AgentKind::DeepSeekHarness));
    }

    #[test]
    fn opencode_is_a_stable_writable_agent() {
        assert_eq!(
            serde_json::to_string(&AgentKind::OpenCode).unwrap(),
            "\"opencode\""
        );
        assert_eq!(
            serde_json::from_str::<AgentKind>("\"opencode\"").unwrap(),
            AgentKind::OpenCode
        );
        assert!(AgentKind::ALL.contains(&AgentKind::OpenCode));
        assert!(AgentKind::WRITABLE.contains(&AgentKind::OpenCode));
    }

    #[test]
    fn grok_build_uses_the_public_stable_id_and_is_writable() {
        assert_eq!(
            serde_json::to_string(&AgentKind::GrokBuild).unwrap(),
            "\"grok-build\""
        );
        assert_eq!(
            serde_json::from_str::<AgentKind>("\"grok-build\"").unwrap(),
            AgentKind::GrokBuild
        );
        assert!(AgentKind::WRITABLE.contains(&AgentKind::GrokBuild));
    }
}
