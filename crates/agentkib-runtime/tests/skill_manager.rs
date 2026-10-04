#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use agentkib_store::Store;
use serde_json::{Value, json};

struct Runtime {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<Value>,
    id: u64,
}

impl Runtime {
    fn start(root: &Path) -> Self {
        Self::start_with_env(root, &[])
    }

    fn start_with_env(root: &Path, overrides: &[(&str, &Path)]) -> Self {
        Self::start_configured(root, overrides, true)
    }

    fn start_with_default_library(root: &Path) -> Self {
        Self::start_configured(root, &[], false)
    }

    fn start_configured(root: &Path, overrides: &[(&str, &Path)], custom_library: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agentkib-runtime"));
        command
            .env_clear()
            .env("HOME", root.join("home"))
            .env("PATH", "/usr/bin:/bin")
            .env("AGENTKIB_BENCHMARK_DATA_DIR", root.join("data"));
        if custom_library {
            command.env("AGENTKIB_HOME", root.join("library"));
        }
        let mut child = command
            .envs(overrides.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        let mut runtime = Self {
            child,
            stdin,
            responses,
            id: 0,
        };
        runtime.call(
            "agentkib.handshake",
            json!({
                "protocolVersion": agentkib_protocol::PROTOCOL_VERSION,
                "client": {"name": "skill-manager-fixture", "version": "0"}
            }),
        );
        runtime
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        writeln!(
            self.stdin,
            "{}",
            json!({
                "jsonrpc": "2.0", "id": self.id, "method": method, "params": params
            })
        )
        .unwrap();
        loop {
            let response = self
                .responses
                .recv_timeout(Duration::from_secs(30))
                .unwrap_or_else(|error| panic!("Runtime response for {method}: {error}"));
            if response.get("id").is_some() {
                assert_eq!(response["id"], self.id, "{response}");
                return response;
            }
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let response = self.request(method, params);
        assert!(response.get("error").is_none(), "{method}: {response}");
        response["result"].clone()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn empty_runtime_fixture() -> tempfile::TempDir {
    let fixture = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = fixture.path();
    fs::create_dir_all(root.join("home")).unwrap();
    fs::create_dir_all(root.join("data")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fs::write(
        root.join("data/preferences.json"),
        json!({"mcp_network": {"port": port, "lan_enabled": false, "lan_risk_accepted": false}})
            .to_string(),
    )
    .unwrap();
    fixture
}

fn write_skill_fixture(path: &Path, name: &str) -> Vec<u8> {
    fs::create_dir_all(path).unwrap();
    let content = format!("---\nname: {name}\ndescription: Native source fixture\n---\nReview\n");
    fs::write(path.join("SKILL.md"), &content).unwrap();
    content.into_bytes()
}

#[test]
fn nameless_local_skill_keeps_its_name_and_bytes_through_library_and_deployment_lifecycle() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let source = root.join("home/.claude/skills/reviewer");
    let project = root.join("project");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(project.join(".git")).unwrap();
    let original = "---\r\ndescription: Review the current changes\r\ndisable-model-invocation: true\r\n---\r\n# Review\r\nKeep this body unchanged.\r\n";
    fs::write(source.join("SKILL.md"), original).unwrap();
    let other = write_skill_fixture(&root.join("library/skills/reviewer"), "reviewer");
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path":project}));
    let inventory = runtime.call("skills.inventory", json!({}));
    let observed = inventory["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == source.to_str().unwrap())
        .unwrap();
    let preview = runtime.call(
        "skills.prepareImport",
        json!({"observation_id":observed["id"]}),
    );
    assert_eq!(preview["skill"]["name"], "reviewer");
    let file = runtime.call(
        "skills.readPreviewFile",
        json!({"token":preview["token"],"path":"SKILL.md"}),
    );
    assert_eq!(file["after"], original);
    let installed = runtime.call(
        "skills.applyOperation",
        json!({"token":preview["token"],"confirmed":true}),
    );
    let library_id = installed["name"].clone();
    assert_ne!(library_id, "reviewer");
    assert_eq!(installed["display_name"], "reviewer");
    assert_eq!(installed["warnings"], json!([]), "{installed}");
    drop(runtime);

    let mut runtime = Runtime::start(root);
    let installed = runtime.call("skills.listInstalled", json!({}));
    let imported = installed
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == library_id)
        .unwrap();
    assert_eq!(imported["display_name"], "reviewer");
    assert_eq!(imported["description"], "Review the current changes");
    let detail = runtime.call("skills.getDetail", json!({"library_id":library_id}));
    assert_eq!(detail["name"], "reviewer");
    assert_eq!(detail["local_source"], source.to_str().unwrap());
    let file = runtime.call(
        "skills.readDetailFile",
        json!({"library_id":library_id,"path":"SKILL.md"}),
    );
    assert_eq!(file["after"], original);
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["agent"] == "claude-code" && item["workspace_id"] == workspace["id"])
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":library_id,"target_ids":[target["id"]]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let deployed = project.join(".claude/skills/reviewer");
    assert_eq!(
        fs::read(deployed.join("SKILL.md")).unwrap(),
        original.as_bytes()
    );
    let deployments = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(deployments[0]["package_name"], "reviewer");
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"undeploy","deployment_id":deployments[0]["id"]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    assert!(!deployed.exists());
    let removed = runtime.call(
        "skills.uninstall",
        json!({"name":library_id,"confirmed":true}),
    );
    assert_eq!(removed["display_name"], "reviewer");
    let restored = runtime.call(
        "skills.restore",
        json!({"id":removed["id"],"confirmed":true}),
    );
    assert_eq!(restored["name"], library_id);
    assert_eq!(restored["display_name"], "reviewer");
    assert_eq!(restored["warnings"], json!([]), "{restored}");
    assert_eq!(
        fs::read(Path::new(restored["path"].as_str().unwrap()).join("SKILL.md")).unwrap(),
        original.as_bytes()
    );
    assert_eq!(
        fs::read(source.join("SKILL.md")).unwrap(),
        original.as_bytes()
    );
    assert_eq!(
        fs::read(root.join("library/skills/reviewer/SKILL.md")).unwrap(),
        other
    );
}

#[test]
fn opencode_compatibility_scans_hidden_nested_and_inherited_sources_without_new_write_targets() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let repository = root.join("repository");
    let project = repository.join("packages/app");
    fs::create_dir_all(repository.join(".git")).unwrap();
    fs::create_dir_all(&project).unwrap();
    let sources = [
        ("home/.claude/skills/parent", "parent", false, false),
        ("home/.claude/skills/parent/child", "child", false, true),
        ("home/.claude/skills/.hidden", "hidden", false, true),
        ("home/.agents/skills/.shared", "shared", false, true),
        (
            "repository/.claude/skills/inherited-claude",
            "inherited-claude",
            true,
            true,
        ),
        (
            "repository/.agents/skills/inherited-shared",
            "inherited-shared",
            true,
            true,
        ),
        (
            "repository/packages/app/.claude/skills/parent",
            "project-parent",
            true,
            false,
        ),
        (
            "repository/packages/app/.claude/skills/parent/child",
            "project-child",
            true,
            true,
        ),
    ];
    let originals = sources
        .iter()
        .map(|(relative, name, _, _)| write_skill_fixture(&root.join(relative), name))
        .collect::<Vec<_>>();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path":project}));
    assert_eq!(workspace["path"], project.to_str().unwrap());
    let targets = runtime.call("skills.targets", json!({}));
    assert!(targets.as_array().unwrap().iter().all(|target| {
        target["scope"] != "workspace"
            || Path::new(target["root"].as_str().unwrap()).starts_with(&project)
    }));
    let inventory = runtime.call("skills.inventory", json!({}));
    assert_eq!(inventory["warnings"], json!([]), "{inventory}");
    for ((relative, _, scoped, only_opencode), original) in sources.iter().zip(originals) {
        let source = root.join(relative);
        let expected_workspace = if *scoped {
            workspace["id"].clone()
        } else {
            Value::Null
        };
        let matches = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                item["path"] == source.to_str().unwrap()
                    && item["workspace_id"] == expected_workspace
            })
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1, "{}: {inventory}", source.display());
        let observed = matches[0];
        assert_eq!(observed["owner"], "external");
        assert_eq!(observed["status"], "observed");
        if *only_opencode {
            assert_eq!(observed["agents"], json!(["opencode"]), "{observed}");
        } else {
            assert!(
                observed["agents"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("opencode"))
            );
        }
        let preview = runtime.call(
            "skills.prepareImport",
            json!({"observation_id":observed["id"]}),
        );
        let imported = runtime.call(
            "skills.applyOperation",
            json!({"token":preview["token"],"confirmed":true}),
        );
        assert_eq!(
            fs::read(Path::new(imported["path"].as_str().unwrap()).join("SKILL.md")).unwrap(),
            original
        );
        assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), original);
    }
    assert!(!repository.join(".agentkib").exists());
    assert!(!project.join(".agentkib").exists());
}

#[test]
fn opencode_compatibility_extensions_respect_disabled_and_independent_native_sources() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let repository = root.join("repository");
    let project = repository.join("packages/app");
    let explicit = root.join("home/.claude");
    fs::create_dir_all(repository.join(".git")).unwrap();
    fs::create_dir_all(&project).unwrap();
    write_skill_fixture(&explicit.join("skills/parent"), "parent");
    let sources = [
        (repository.join(".agents/skills/inherited"), "inherited"),
        (explicit.join("skills/parent/child"), "child"),
        (explicit.join("skills/.hidden"), "hidden"),
    ];
    let originals = sources
        .iter()
        .map(|(path, name)| write_skill_fixture(path, name))
        .collect::<Vec<_>>();
    for (flag, native, expected) in [
        ("OPENCODE_DISABLE_PROJECT_CONFIG", false, [true, true, true]),
        (
            "OPENCODE_DISABLE_EXTERNAL_SKILLS",
            false,
            [false, false, false],
        ),
        (
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
            false,
            [true, false, false],
        ),
        (
            "OPENCODE_DISABLE_EXTERNAL_SKILLS",
            true,
            [false, true, false],
        ),
    ] {
        let mut overrides = vec![(flag, Path::new("1"))];
        if native {
            overrides.push(("OPENCODE_CONFIG_DIR", explicit.as_path()));
        }
        let mut runtime = Runtime::start_with_env(root, &overrides);
        runtime.call("workspace.add", json!({"path":project}));
        let inventory = runtime.call("skills.inventory", json!({}));
        for ((path, _), readable) in sources.iter().zip(expected) {
            let observed = inventory["observations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["path"] == path.to_str().unwrap())
                .unwrap_or_else(|| panic!("Missing {}: {inventory}", path.display()));
            assert_eq!(
                observed["agents"],
                if readable {
                    json!(["opencode"])
                } else {
                    json!([])
                },
                "{flag}, native={native}: {observed}"
            );
            assert_eq!(
                observed["status"],
                if readable {
                    "observed"
                } else {
                    "native-restricted"
                },
                "{observed}"
            );
        }
    }
    for ((path, _), original) in sources.iter().zip(originals) {
        assert_eq!(fs::read(path.join("SKILL.md")).unwrap(), original);
    }
    assert!(!repository.join(".agentkib").exists());
    assert!(!project.join(".agentkib").exists());
}

#[test]
fn opencode_readonly_sources_are_discovered_and_imported_without_native_writes() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let custom = root.join("custom");
    fs::create_dir_all(project.join(".git")).unwrap();
    let sources = [
        ("home/.config/opencode/skills/normal", "normal"),
        ("home/.opencode/skills/home-dot", "home-dot"),
        ("project/.opencode/skills/project-skill", "project-skill"),
        ("custom/skills/custom", "custom"),
        ("home/.config/opencode/skill/singular", "singular"),
        ("extra/extra", "extra"),
    ];
    let originals = sources
        .iter()
        .map(|(relative, name)| write_skill_fixture(&root.join(relative), name))
        .collect::<Vec<_>>();
    let config = root.join("home/.config/opencode/opencode.json");
    let config_content = json!({"skills":{"paths":[root.join("extra")]}}).to_string();
    fs::write(&config, &config_content).unwrap();
    let mut runtime = Runtime::start_with_env(root, &[("OPENCODE_CONFIG_DIR", &custom)]);
    runtime.call("workspace.add", json!({"path":project}));
    let inventory = runtime.call("skills.inventory", json!({}));
    assert_eq!(inventory["warnings"], json!([]), "{inventory}");
    for ((relative, _), original) in sources.iter().zip(&originals) {
        let source = root.join(relative);
        let observation = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == source.to_str().unwrap())
            .unwrap_or_else(|| panic!("Missing {}: {inventory}", source.display()));
        assert!(
            observation["agents"]
                .as_array()
                .unwrap()
                .contains(&json!("opencode"))
        );
        assert_eq!(observation["status"], "observed", "{observation}");
        assert_eq!(observation["owner"], "external");
        let preview = runtime.call(
            "skills.prepareImport",
            json!({"observation_id":observation["id"]}),
        );
        let installed = runtime.call(
            "skills.applyOperation",
            json!({"token":preview["token"],"confirmed":true}),
        );
        let imported = Path::new(installed["path"].as_str().unwrap()).join("SKILL.md");
        assert_eq!(fs::read(imported).unwrap(), *original);
        assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), *original);
        assert_eq!(fs::read_dir(source).unwrap().count(), 1);
    }
    assert_eq!(fs::read_to_string(config).unwrap(), config_content);
    assert!(!project.join(".agentkib").exists());
    assert!(!custom.join(".agentkib").exists());
    assert!(!root.join("home/.opencode/.agentkib").exists());
}

#[test]
fn opencode_project_disable_keeps_explicit_sources_independently_readable() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let explicit = project.join(".opencode");
    let package = explicit.join("skills/reviewer");
    fs::create_dir_all(project.join(".git")).unwrap();
    let original = write_skill_fixture(&package, "reviewer");
    for explicitly_enabled in [false, true] {
        let mut overrides = vec![("OPENCODE_DISABLE_PROJECT_CONFIG", Path::new("1"))];
        if explicitly_enabled {
            overrides.push(("OPENCODE_CONFIG_DIR", explicit.as_path()));
        }
        let mut runtime = Runtime::start_with_env(root, &overrides);
        let workspace = runtime.call("workspace.add", json!({"path":project}));
        let targets = runtime.call("skills.targets", json!({}));
        let target = targets
            .as_array()
            .unwrap()
            .iter()
            .find(|target| {
                target["agent"] == "opencode" && target["workspace_id"] == workspace["id"]
            })
            .unwrap();
        assert_eq!(
            target["visible_to"]
                .as_array()
                .unwrap()
                .contains(&json!("opencode")),
            explicitly_enabled,
            "{target}"
        );
        let inventory = runtime.call("skills.inventory", json!({}));
        let observation = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| {
                item["path"] == package.to_str().unwrap() && item["workspace_id"] == workspace["id"]
            })
            .unwrap();
        assert_eq!(
            observation["status"],
            if explicitly_enabled {
                "observed"
            } else {
                "native-restricted"
            },
            "{observation}"
        );
        assert_eq!(
            observation["agents"]
                .as_array()
                .unwrap()
                .contains(&json!("opencode")),
            explicitly_enabled
        );
        assert_eq!(
            observation["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item
                    .as_str()
                    .unwrap()
                    .contains("OPENCODE_DISABLE_PROJECT_CONFIG")),
            !explicitly_enabled
        );
        assert_eq!(fs::read(package.join("SKILL.md")).unwrap(), original);
        assert!(!project.join(".agentkib").exists());
    }
}

#[test]
fn deployment_views_refresh_visibility_without_rewriting_ownership_receipts() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let original = write_skill_fixture(&root.join("library/skills/reviewer"), "reviewer");
    let mut runtime = Runtime::start(root);
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "claude-code" && target["scope"] == "personal")
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true,"approve_home":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    drop(runtime);
    let receipt = root.join("library/skill-deployments.json");
    let receipt_bytes = fs::read(&receipt).unwrap();
    for disabled in [true, false] {
        let overrides = if disabled {
            vec![("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", Path::new("1"))]
        } else {
            vec![]
        };
        let mut runtime = Runtime::start_with_env(root, &overrides);
        let deployments = runtime.call("skills.listDeployments", json!({}));
        let deployment = &deployments[0];
        assert_eq!(deployment["status"], "current");
        assert_eq!(deployment["agents"], json!(["claude-code"]));
        assert_eq!(
            deployment["visible_to"]
                .as_array()
                .unwrap()
                .contains(&json!("opencode")),
            !disabled,
            "{deployment}"
        );
        assert!(
            deployment["visible_to"]
                .as_array()
                .unwrap()
                .contains(&json!("claude-code"))
        );
        assert_eq!(
            deployment["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item
                    .as_str()
                    .unwrap()
                    .contains("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")),
            disabled,
            "{deployment}"
        );
        assert_eq!(fs::read(&receipt).unwrap(), receipt_bytes);
        assert_eq!(
            fs::read(root.join("home/.claude/skills/reviewer/SKILL.md")).unwrap(),
            original
        );
    }
}

#[test]
fn personal_reservations_block_other_libraries_across_restart_until_recovery() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let original = root.join("library");
    let other = root.join("other-library");
    for library in [&original, &other] {
        fs::create_dir_all(library.join("skills/reviewer")).unwrap();
        fs::write(
            library.join("skills/reviewer/SKILL.md"),
            "---\nname: reviewer\ndescription: Reservation fixture\n---\nReview\n",
        )
        .unwrap();
    }
    let mut runtime = Runtime::start(root);
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["scope"] == "personal")
        .unwrap();
    let request = json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]});
    let preview = runtime.call("skills.prepareDeployment", request.clone());
    let token = preview["token"].as_str().unwrap();
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":token,"confirmed":true,"approve_home":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    drop(runtime);

    // Reconstruct the reachable crash state after the durable reservation/journal,
    // before staging or native activation. The shared scope index remains on disk.
    let journal_path = original
        .join("deployment-operations")
        .join(format!("{token}.json"));
    let mut journal: Value = serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    let after_record = journal["targets"][0]["after_record"].clone();
    journal["targets"][0]["phase"] = json!("reserved");
    journal["targets"][0]["result"] = Value::Null;
    journal["report"] = Value::Null;
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::remove_file(original.join("skill-deployments.json")).unwrap();
    fs::write(
        original.join("skill-deployment-reservations.json"),
        json!({"schema_version":1,"deployments":[after_record]}).to_string(),
    )
    .unwrap();
    let native = root.join("home/.agents/skills/reviewer");
    fs::remove_dir_all(&native).unwrap();

    let mut other_runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other)]);
    let blocked = other_runtime.call("skills.prepareDeployment", request.clone());
    assert!(
        !blocked["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{blocked}"
    );
    let rejected = other_runtime.call(
        "skills.applyDeployment",
        json!({"token":blocked["token"],"confirmed":true,"approve_home":true}),
    );
    assert_eq!(rejected["results"][0]["success"], false);
    assert!(!native.exists());
    assert!(!other.join("skill-deployments.json").exists());
    drop(other_runtime);

    let mut runtime = Runtime::start(root);
    let recovered = runtime.call(
        "skills.applyDeployment",
        json!({"token":token,"confirmed":true,"approve_home":true}),
    );
    assert_eq!(
        recovered["results"][0]["status"], "recovered",
        "{recovered}"
    );
    drop(runtime);
    let mut other_runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other)]);
    let allowed = other_runtime.call("skills.prepareDeployment", request);
    assert!(
        allowed["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{allowed}"
    );
    let deployed = other_runtime.call(
        "skills.applyDeployment",
        json!({"token":allowed["token"],"confirmed":true,"approve_home":true}),
    );
    assert_eq!(deployed["results"][0]["success"], true, "{deployed}");
    drop(other_runtime);
    let bytes = fs::read(native.join("SKILL.md")).unwrap();
    let receipt = fs::read(other.join("skill-deployments.json")).unwrap();
    let mut runtime = Runtime::start(root);
    runtime.call(
        "skills.applyDeployment",
        json!({"token":token,"confirmed":true,"approve_home":true}),
    );
    assert_eq!(fs::read(native.join("SKILL.md")).unwrap(), bytes);
    assert_eq!(
        fs::read(other.join("skill-deployments.json")).unwrap(),
        receipt
    );
}

#[test]
fn a_later_project_registration_cannot_adopt_another_librarys_personal_deployment() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let home = root.join("home");
    let source = root.join("library/skills/reviewer");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Personal fixture\n---\nReview\n",
    )
    .unwrap();
    fs::write(source.join("AGENTS.md"), "Owned instructions\n").unwrap();
    let mut runtime = Runtime::start(root);
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["scope"] == "personal")
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true,"approve_home":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let native = home.join(".agents/skills/reviewer");
    let receipt = root.join("library/skill-deployments.json");
    let original_receipt = fs::read(&receipt).unwrap();
    assert!(!home.join(".agentkib/skill-library-roots.json").exists());
    drop(runtime);

    let other_library = root.join("other-library");
    let mut runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other_library)]);
    runtime.call("workspace.add", json!({"path":home}));
    let mut manifest = runtime.call("workspace.prepareManifest", json!({"project":home}));
    assert!(
        manifest["skills"].as_array().unwrap().is_empty(),
        "{manifest}"
    );
    assert!(
        manifest["instructions"]["scoped"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{manifest}"
    );
    manifest["instructions"]["scoped"] = json!([{
        "path":".agents/skills/reviewer", "content":"Legacy replacement\n"
    }]);
    let response = runtime.request(
        "changes.plan",
        json!({"project":home,"manifest":manifest,"includeHome":false}),
    );
    assert!(
        response["error"]["data"]["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("Skill deployment")),
        "{response}"
    );
    assert_eq!(
        fs::read_to_string(native.join("AGENTS.md")).unwrap(),
        "Owned instructions\n"
    );
    assert_eq!(fs::read(receipt).unwrap(), original_receipt);
    assert!(!home.join(".agentkib/skill-library-roots.json").exists());
}

#[test]
fn a_home_git_repository_does_not_reinterpret_default_personal_receipts() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let home = root.join("home");
    let project = home.join("project");
    let package = home.join(".agentkib/skills/reviewer");
    fs::create_dir(home.join(".git")).unwrap();
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&package).unwrap();
    fs::write(
        package.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Home fixture\n---\nReview\n",
    )
    .unwrap();
    let mut runtime = Runtime::start_with_default_library(root);
    runtime.call("workspace.add", json!({"path":project}));
    runtime.call("workspace.prepareManifest", json!({"project":project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["scope"] == "personal")
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true,"approve_home":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let receipt = home.join(".agentkib/skill-deployments.json");
    let original = fs::read(&receipt).unwrap();
    let manifest = runtime.call("workspace.prepareManifest", json!({"project":project}));
    let plan = runtime.call(
        "changes.plan",
        json!({"project":project,"manifest":manifest,"includeHome":false}),
    );
    runtime.call(
        "changes.apply",
        json!({"changeSet":plan,"approveHome":false}),
    );
    assert_eq!(fs::read(&receipt).unwrap(), original);
    assert!(home.join(".agents/skills/reviewer/SKILL.md").is_file());
    drop(runtime);
    let mut restarted = Runtime::start_with_default_library(root);
    restarted.call("workspace.prepareManifest", json!({"project":project}));
    assert_eq!(fs::read(receipt).unwrap(), original);
}

#[test]
fn delayed_agent_home_changeset_checks_deployments_in_its_target_ancestor() {
    let fixture = empty_runtime_fixture();
    let other_fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let unrelated = other_fixture.path().join("unrelated");
    let native = project.join(".claude/skills/reviewer");
    let source = root.join("library/skills/reviewer");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&unrelated).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Delayed Home fixture\n---\nOwned instructions\n",
    )
    .unwrap();

    let mut other = Runtime::start_with_env(other_fixture.path(), &[("HOME", &native)]);
    let mut manifest = other.call("workspace.prepareManifest", json!({"project":unrelated}));
    for (agent, state) in manifest["adapters"].as_object_mut().unwrap() {
        state["enabled"] = json!(agent == "open-claw");
    }
    let initial = other.call(
        "changes.plan",
        json!({"project":unrelated,"manifest":manifest,"includeHome":true}),
    );
    other.call(
        "changes.apply",
        json!({"changeSet":initial,"approveHome":true}),
    );
    assert!(native.join(".openclaw/openclaw.json").is_file());
    assert!(!native.join("SKILL.md").exists());

    // Keep the applied project manifest, then plan its missing Home output normally.
    // The resulting ChangeSet must be entirely AgentHome without removing any changes.
    fs::remove_dir_all(&native).unwrap();
    let manifest = other.call("workspace.prepareManifest", json!({"project":unrelated}));
    let delayed = other.call(
        "changes.plan",
        json!({"project":unrelated,"manifest":manifest,"includeHome":true}),
    );
    let changes = delayed["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{delayed}");
    assert_eq!(changes[0]["scope"], "agent-home", "{delayed}");
    assert!(changes[0]["original_hash"].is_null(), "{delayed}");

    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path":project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| {
            target["agent"] == "claude-code" && target["workspace_id"] == workspace["id"]
        })
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    let deployed = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(deployed["results"][0]["success"], true, "{deployed}");
    let receipt = project.join(".agentkib/skill-deployments.json");
    let original_receipt = fs::read(&receipt).unwrap();
    let original_package = fs::read(native.join("SKILL.md")).unwrap();
    assert!(!native.join(".openclaw").exists());

    let rejected = other.request(
        "changes.apply",
        json!({"changeSet":delayed,"approveHome":true}),
    );
    assert!(
        rejected["error"]["data"]["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("Skill deployment")),
        "{rejected}"
    );
    assert!(!native.join(".openclaw").exists());
    assert_eq!(fs::read(native.join("SKILL.md")).unwrap(), original_package);
    assert_eq!(fs::read(receipt).unwrap(), original_receipt);
    let records = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(records.as_array().unwrap().len(), 1, "{records}");
    assert_eq!(records[0]["status"], "current", "{records}");
}

#[test]
fn directory_only_deployment_changes_are_reviewable_before_they_are_applied() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let package = root.join("library/skills/reviewer");
    let project = root.join("project");
    fs::create_dir_all(package.join("output/old")).unwrap();
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::write(
        package.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Directories fixture\n---\nReview\n",
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path":project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["workspace_id"] == workspace["id"])
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    assert!(
        preview["targets"][0]["added"]
            .as_array()
            .unwrap()
            .contains(&json!("output/old/"))
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let native = project.join(".agents/skills/reviewer");
    assert!(native.join("output/old").is_dir());
    fs::rename(package.join("output/old"), package.join("output/new")).unwrap();
    let detail = runtime.call("skills.getDetail", json!({"library_id":"reviewer"}));
    assert!(
        detail["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "output/new/")
    );
    let update = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"update","deployment_id":report["results"][0]["deployment_id"]}),
    );
    assert_eq!(update["targets"][0]["added"], json!(["output/new/"]));
    assert_eq!(update["targets"][0]["removed"], json!(["output/old/"]));
    assert_eq!(update["targets"][0]["modified"], json!([]));
    assert!(native.join("output/old").is_dir());
    assert!(!native.join("output/new").exists());
    let result = runtime.call(
        "skills.applyDeployment",
        json!({"token":update["token"],"confirmed":true}),
    );
    assert_eq!(result["results"][0]["success"], true, "{result}");
    assert!(!native.join("output/old").exists());
    assert!(native.join("output/new").is_dir());
}

#[test]
fn openclaw_nondefault_state_only_sees_personal_shared_skills_when_explicitly_configured() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let shared = root.join("home/.agents/skills");
    let state = root.join("native-state");
    fs::create_dir_all(shared.join("reviewer")).unwrap();
    fs::create_dir(&state).unwrap();
    fs::write(
        shared.join("reviewer/SKILL.md"),
        "---\nname: reviewer\ndescription: Visibility fixture\n---\nReview\n",
    )
    .unwrap();
    fs::write(state.join("openclaw.json"), "{}").unwrap();
    let mut runtime = Runtime::start_with_env(root, &[("OPENCLAW_STATE_DIR", &state)]);
    for explicit in [false, true] {
        if explicit {
            fs::write(
                state.join("openclaw.json"),
                json!({"skills":{"load":{"extraDirs":[shared]}}}).to_string(),
            )
            .unwrap();
        }
        let targets = runtime.call("skills.targets", json!({}));
        let codex = targets
            .as_array()
            .unwrap()
            .iter()
            .find(|target| target["agent"] == "codex" && target["scope"] == "personal")
            .unwrap();
        assert_eq!(
            codex["visible_to"]
                .as_array()
                .unwrap()
                .contains(&json!("open-claw")),
            explicit
        );
        let inventory = runtime.call("skills.inventory", json!({}));
        let observation = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == json!(shared.join("reviewer")))
            .unwrap();
        assert_eq!(
            observation["agents"]
                .as_array()
                .unwrap()
                .contains(&json!("open-claw")),
            explicit,
            "{observation}"
        );
    }
}

#[test]
fn deployment_source_identity_survives_switching_to_a_same_named_library_package() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let original_library = root.join("library");
    let other_library = root.join("other-library");
    fs::create_dir_all(project.join(".git")).unwrap();
    for (library, body) in [
        (&original_library, "Source A"),
        (&other_library, "Source B"),
    ] {
        fs::create_dir_all(library.join("skills/reviewer")).unwrap();
        fs::write(
            library.join("skills/reviewer/SKILL.md"),
            format!("---\nname: reviewer\ndescription: {body}\n---\n{body}\n"),
        )
        .unwrap();
    }
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["workspace_id"] == workspace["id"])
        .unwrap();
    let deploy_request =
        json!({"operation":"deploy", "library_id":"reviewer", "target_ids":[target["id"]]});
    let preview = runtime.call("skills.prepareDeployment", deploy_request.clone());
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let deployment_id = report["results"][0]["deployment_id"].clone();
    let receipt = project.join(".agentkib/skill-deployments.json");
    let original_receipt = fs::read(&receipt).unwrap();
    let native = project.join(".agents/skills/reviewer/SKILL.md");
    let original_content = fs::read(&native).unwrap();
    drop(runtime);

    let mut runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other_library)]);
    let records = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(records[0]["library_root"], json!(original_library));
    assert_eq!(records[0]["source_is_current_library"], false);
    let inventory = runtime.call("skills.inventory", json!({}));
    let observed = inventory["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|observation| observation["path"] == json!(native.parent().unwrap()))
        .unwrap();
    assert_eq!(observed["owner"], "agentkib");
    assert!(observed["library_id"].is_null(), "{observed}");
    for request in [
        deploy_request,
        json!({"operation":"update","deployment_id":deployment_id}),
    ] {
        let response = runtime.request("skills.prepareDeployment", request);
        if response.get("error").is_none() {
            let preview = &response["result"];
            assert!(
                !preview["targets"][0]["conflicts"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "{response}"
            );
            let report = runtime.call(
                "skills.applyDeployment",
                json!({"token":preview["token"],"confirmed":true}),
            );
            assert_eq!(report["results"][0]["success"], false, "{report}");
        }
        assert_eq!(fs::read(&receipt).unwrap(), original_receipt);
        assert_eq!(fs::read(&native).unwrap(), original_content);
    }
    // A foreign deployment must not prevent removal of B's unrelated package.
    runtime.call(
        "skills.uninstall",
        json!({"name":"reviewer","confirmed":true}),
    );
    assert_eq!(fs::read(&native).unwrap(), original_content);
    drop(runtime);

    let mut runtime = Runtime::start(root);
    let records = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(records[0]["source_is_current_library"], true);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"update","deployment_id":deployment_id}),
    );
    assert!(
        preview["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{preview}"
    );
}

#[test]
fn parent_manifest_cannot_discover_or_rewrite_nested_project_deployments() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let child = project.join("packages/app");
    let source = root.join("library/skills/reviewer");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&child).unwrap();
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Nested package\n---\nBody\n",
    )
    .unwrap();
    fs::write(source.join("AGENTS.md"), "Native package instructions\n").unwrap();
    let mut runtime = Runtime::start(root);
    runtime.call("workspace.add", json!({"path":project}));
    let workspace = runtime.call("workspace.add", json!({"path":child}));
    let mut manifest = runtime.call("workspace.prepareManifest", json!({"project":project}));
    manifest["instructions"]["scoped"] = json!([{"path":"packages/app/.agents/skills/reviewer","content":"Native package instructions\n"}]);
    let plan_request = json!({"project":project,"manifest":manifest,"includeHome":false});
    let delayed = runtime.call("changes.plan", plan_request.clone());
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["workspace_id"] == workspace["id"])
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation":"deploy","library_id":"reviewer","target_ids":[target["id"]]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token":preview["token"],"confirmed":true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let discovered = runtime.call("workspace.prepareManifest", json!({"project":project}));
    assert!(
        discovered["instructions"]["scoped"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{discovered}"
    );
    for response in [
        runtime.request("changes.plan", plan_request),
        runtime.request(
            "changes.apply",
            json!({"changeSet":delayed,"approveHome":false}),
        ),
    ] {
        assert!(
            response["error"]["data"]["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("Skill deployment")),
            "{response}"
        );
    }
    let native = child.join(".agents/skills/reviewer");
    assert_eq!(
        fs::read_to_string(native.join("AGENTS.md")).unwrap(),
        "Native package instructions\n"
    );
    assert!(!native.join("CLAUDE.md").exists());
    assert_eq!(
        runtime.call("skills.listDeployments", json!({}))[0]["status"],
        "current"
    );
}

#[test]
fn switching_libraries_cannot_create_a_project_owner_over_a_personal_receipt() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let claude_home = project.join(".claude");
    let other_library = root.join("other-library");
    fs::create_dir_all(project.join(".git")).unwrap();
    for library in [root.join("library"), other_library.clone()] {
        fs::create_dir_all(library.join("skills/reviewer")).unwrap();
        fs::write(
            library.join("skills/reviewer/SKILL.md"),
            "---\nname: reviewer\ndescription: Cross-library fixture\n---\nBody\n",
        )
        .unwrap();
    }
    let mut runtime = Runtime::start_with_env(root, &[("CLAUDE_CONFIG_DIR", &claude_home)]);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let personal = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "claude-code" && target["scope"] == "personal")
        .unwrap();
    let prepare =
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": [personal["id"]]});
    let preview = runtime.call("skills.prepareDeployment", prepare.clone());
    let deployed = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true, "approve_home": true}),
    );
    assert_eq!(deployed["results"][0]["success"], true, "{deployed}");
    let withdraw = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "undeploy", "deployment_id": deployed["results"][0]["deployment_id"]}),
    );
    let removed = runtime.call(
        "skills.applyDeployment",
        json!({"token": withdraw["token"], "confirmed": true, "approve_home": true}),
    );
    assert_eq!(removed["results"][0]["success"], true, "{removed}");
    assert_eq!(removed["results"][0]["status"], "inactive");
    let original_receipts = fs::read(root.join("library/skill-deployments.json")).unwrap();
    drop(runtime);

    let mut runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other_library)]);
    let targets = runtime.call("skills.targets", json!({}));
    let project_target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| {
            target["agent"] == "claude-code" && target["workspace_id"] == workspace["id"]
        })
        .unwrap();
    assert_eq!(project_target["writable"], true);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": [project_target["id"]]}),
    );
    assert!(
        preview["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|conflict| {
                conflict.as_str().is_some_and(|message| {
                    message.contains("owned") || message.contains("reserved")
                })
            }),
        "{preview}"
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true}),
    );
    assert_eq!(report["results"][0]["success"], false, "{report}");
    assert_eq!(report["results"][0]["status"], "conflict");
    assert!(!project.join(".agentkib/skill-deployments.json").exists());
    assert!(!claude_home.join("skills/reviewer").exists());
    assert_eq!(
        fs::read(root.join("library/skill-deployments.json")).unwrap(),
        original_receipts
    );
    drop(runtime);

    let mut runtime = Runtime::start_with_env(root, &[("CLAUDE_CONFIG_DIR", &claude_home)]);
    let deployments = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(deployments.as_array().unwrap().len(), 1);
    assert_eq!(deployments[0]["status"], "inactive");
    let preview = runtime.call("skills.prepareDeployment", prepare);
    assert!(
        preview["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{preview}"
    );
}

#[test]
fn library_removal_reads_a_project_withdrawal_performed_from_another_library() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let other_library = root.join("other-library");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(root.join("library/skills/reviewer")).unwrap();
    fs::write(
        root.join("library/skills/reviewer/SKILL.md"),
        "---\nname: reviewer\ndescription: Withdrawal fixture\n---\nBody\n",
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["workspace_id"] == workspace["id"])
        .unwrap();
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": [target["id"]]}),
    );
    let deployed = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true}),
    );
    assert_eq!(deployed["results"][0]["success"], true, "{deployed}");
    drop(runtime);

    let mut runtime = Runtime::start_with_env(root, &[("AGENTKIB_HOME", &other_library)]);
    let withdraw = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "undeploy", "deployment_id": deployed["results"][0]["deployment_id"]}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token": withdraw["token"], "confirmed": true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    assert_eq!(report["results"][0]["status"], "inactive");
    assert!(!project.join(".agents/skills/reviewer").exists());
    let current_receipts = fs::read(project.join(".agentkib/skill-deployments.json")).unwrap();
    drop(runtime);

    let mut runtime = Runtime::start(root);
    let deployments = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(deployments[0]["status"], "inactive");
    let removed = runtime.call(
        "skills.uninstall",
        json!({"name": "reviewer", "confirmed": true}),
    );
    assert_eq!(removed["name"], "reviewer");
    assert!(!root.join("library/skills/reviewer").exists());
    assert!(
        Path::new(removed["path"].as_str().unwrap())
            .join("SKILL.md")
            .is_file()
    );
    assert_eq!(
        fs::read(project.join(".agentkib/skill-deployments.json")).unwrap(),
        current_receipts
    );
}

#[test]
fn native_entries_and_ordered_permissions_are_reflected_by_the_manager_rpcs() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(project.join("skills/reviewer")).unwrap();
    fs::write(
        project.join("skills/reviewer/SKILL.md"),
        "---\nname: reviewer\ndescription: OpenClaw entry fixture\n---\nBody\n",
    )
    .unwrap();
    fs::create_dir_all(root.join("home/.openclaw")).unwrap();
    fs::write(
        root.join("home/.openclaw/openclaw.json"),
        json!({"agents": {"entries": {"writer": {"workspace": project}}}}).to_string(),
    )
    .unwrap();
    let opencode = root.join("home/.config/opencode");
    let skill = opencode.join("skills/internal-foo");
    fs::create_dir_all(&skill).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: internal-foo\ndescription: Permission fixture\n---\nBody\n",
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "open-claw" && target["workspace_id"] == workspace["id"])
        .unwrap();
    assert_eq!(target["writable"], true, "{target}");
    // Keep the source key order literal: serde_json::Value sorts map keys.
    for (rules, expected_status) in [
        (r#"{"*":"allow","internal-*":"deny"}"#, "native-restricted"),
        (
            r#"{"internal-foo":"allow","*":"deny"}"#,
            "native-restricted",
        ),
        (r#"{"*":"deny","internal-?oo":"allow"}"#, "observed"),
    ] {
        fs::write(
            opencode.join("opencode.jsonc"),
            format!(
                "{{ // Ordered permission fixture\n \"permission\": {{ \"skill\": {rules} }} }}"
            ),
        )
        .unwrap();
        let inventory = runtime.call("skills.inventory", json!({}));
        let observations = inventory["observations"].as_array().unwrap();
        let openclaw = observations
            .iter()
            .find(|item| item["path"] == project.join("skills/reviewer").to_str().unwrap())
            .unwrap();
        assert_eq!(openclaw["status"], "observed", "{openclaw}");
        let opencode = observations
            .iter()
            .find(|item| item["path"] == skill.to_str().unwrap())
            .unwrap();
        assert_eq!(opencode["status"], expected_status, "{rules}: {opencode}");
    }
    for (agents, expected_status) in [
        (
            json!({"entries":{"writer":{"workspace":project,"skills":[]}}}),
            "native-restricted",
        ),
        (
            json!({"defaults":{"skills":[]},"entries":{"writer":{"workspace":project}}}),
            "native-restricted",
        ),
        (
            json!({"defaults":{"skills":[]},"entries":{"writer":{"workspace":project,"skills":["reviewer"]}}}),
            "observed",
        ),
        (
            json!({"entries":{"writer":{"workspace":project,"skills":[]},"reader":{"workspace":project,"skills":["reviewer"]}}}),
            "observed",
        ),
    ] {
        fs::write(
            root.join("home/.openclaw/openclaw.json"),
            json!({"agents":agents}).to_string(),
        )
        .unwrap();
        let inventory = runtime.call("skills.inventory", json!({}));
        let openclaw = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == json!(project.join("skills/reviewer")))
            .unwrap();
        assert_eq!(openclaw["status"], expected_status, "{agents}: {openclaw}");
    }
}

#[test]
fn opencode_permissions_include_native_directory_and_custom_configuration_files() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let skill = project.join(".opencode/skills/reviewer");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&skill).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Native config fixture\n---\nBody\n",
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    runtime.call("workspace.add", json!({"path":project}));
    let assert_restricted = |runtime: &mut Runtime| {
        let inventory = runtime.call("skills.inventory", json!({}));
        let observed = inventory["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == json!(skill))
            .unwrap();
        assert_eq!(observed["status"], "native-restricted", "{observed}");
    };
    for config in [
        root.join("home/.config/opencode/config.json"),
        project.join(".opencode/opencode.json"),
        project.join(".opencode/opencode.jsonc"),
    ] {
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, r#"{"permission":{"skill":{"reviewer":"deny"}}}"#).unwrap();
        assert_restricted(&mut runtime);
        fs::remove_file(config).unwrap();
    }
    drop(runtime);
    let config = root.join("custom.json");
    fs::write(&config, r#"{"permission":{"skill":{"reviewer":"deny"}}}"#).unwrap();
    let mut runtime = Runtime::start_with_env(root, &[("OPENCODE_CONFIG", &config)]);
    assert_restricted(&mut runtime);
}

#[test]
fn hermes_project_visibility_requires_the_actual_git_root_before_trust() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let nested = project.join("packages/client");
    let skill = nested.join(".hermes/skills/reviewer");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&skill).unwrap();
    fs::create_dir_all(root.join("home/.hermes")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: reviewer\ndescription: Hermes visibility fixture\n---\nBody\n",
    )
    .unwrap();
    let config = root.join("home/.hermes/config.yaml");
    fs::write(
        &config,
        json!({"skills":{"trusted_project_dirs":[project,nested]}}).to_string(),
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path":nested}));
    assert_eq!(workspace["path"], json!(nested));
    let visibility = |runtime: &mut Runtime| {
        runtime.call("skills.inventory", json!({}))["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == json!(skill))
            .unwrap()["status"]
            .clone()
    };
    assert_eq!(visibility(&mut runtime), "native-restricted");
    fs::create_dir(nested.join(".git")).unwrap();
    assert_eq!(visibility(&mut runtime), "observed");
}

#[test]
fn personal_deployment_inside_project_blocks_legacy_writes_across_library_changes() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    let claude_home = project.join(".claude");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(project.join("source")).unwrap();
    let source = root.join("library/skills/reviewer");
    fs::create_dir_all(&source).unwrap();
    let managed = "---\nname: reviewer\ndescription: Library fixture\n---\nManaged body\n";
    fs::write(source.join("SKILL.md"), managed).unwrap();
    fs::write(
        project.join("source/SKILL.md"),
        "---\nname: reviewer\ndescription: Legacy fixture\n---\nLegacy body\n",
    )
    .unwrap();
    let mut runtime = Runtime::start_with_env(root, &[("CLAUDE_CONFIG_DIR", &claude_home)]);
    runtime.call("workspace.add", json!({"path": project}));
    let mut manifest = runtime.call("workspace.prepareManifest", json!({"project": project}));
    manifest["skills"] =
        json!([{"name": "reviewer", "path": "source", "targets": ["claude-code"]}]);
    for (agent, state) in manifest["adapters"].as_object_mut().unwrap() {
        state["enabled"] = json!(agent == "claude-code");
    }
    let manifest_path = project.join(".agentkib/manifest.yaml");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "claude-code" && target["scope"] == "personal")
        .unwrap();
    let prepare =
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": [target["id"]]});
    let blocked = runtime.call("skills.prepareDeployment", prepare.clone());
    assert!(
        !blocked["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{blocked}"
    );
    assert!(!claude_home.join("skills/reviewer").exists());

    // An older ChangeSet can outlive its manifest. Its apply-time ownership
    // check must still reject a deployment created after the preview.
    fs::remove_file(&manifest_path).unwrap();
    let plan_params = json!({"project": project, "manifest": manifest, "includeHome": false});
    let delayed = runtime.call("changes.plan", plan_params.clone());
    let preview = runtime.call("skills.prepareDeployment", prepare);
    assert!(
        preview["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{preview}"
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true, "approve_home": true}),
    );
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let native = claude_home.join("skills/reviewer/SKILL.md");
    assert_eq!(fs::read_to_string(&native).unwrap(), managed);
    assert!(project.join(".agentkib/skill-library-roots.json").is_file());
    assert!(root.join("library/skill-deployments.json").is_file());
    assert!(!project.join(".agentkib/skill-deployments.json").exists());

    let discovered = runtime.call("workspace.prepareManifest", json!({"project": project}));
    assert!(
        discovered["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| {
                !skill["path"]
                    .as_str()
                    .unwrap()
                    .starts_with(".claude/skills/reviewer")
            })
    );
    let apply_params = json!({"changeSet": delayed, "approveHome": false});
    let assert_ownership_error = |response: Value| {
        assert!(
            response["error"]["data"]["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("overlaps a Skill deployment")),
            "{response}"
        );
    };
    assert_ownership_error(runtime.request("changes.apply", apply_params.clone()));
    assert_ownership_error(runtime.request("changes.plan", plan_params.clone()));
    assert_eq!(fs::read_to_string(&native).unwrap(), managed);
    drop(runtime);

    // Ownership is persisted independently of the currently selected library.
    let other_library = root.join("other-library");
    let mut runtime = Runtime::start_with_env(
        root,
        &[
            ("CLAUDE_CONFIG_DIR", &claude_home),
            ("AGENTKIB_HOME", &other_library),
        ],
    );
    assert_ownership_error(runtime.request("changes.plan", plan_params));
    assert_ownership_error(runtime.request("changes.apply", apply_params));
    assert_eq!(fs::read_to_string(&native).unwrap(), managed);
    assert!(!manifest_path.exists());
}

#[test]
fn replaced_deployment_link_does_not_merge_receipts_or_claim_external_installations() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    let source = root.join("library/skills/reviewer");
    fs::create_dir_all(&source).unwrap();
    let first = "---\nname: reviewer\ndescription: Link fixture\n---\nFirst\n";
    let second = first.replace("First", "Second");
    fs::write(source.join("SKILL.md"), first).unwrap();
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let selected = targets
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| {
            target["workspace_id"] == workspace["id"]
                && [
                    agentkib_core::AgentKind::Codex,
                    agentkib_core::AgentKind::ClaudeCode,
                ]
                .iter()
                .any(|agent| target["agent"] == json!(agent))
        })
        .map(|target| target["id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 2);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": selected}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true}),
    );
    assert!(
        report["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["success"] == true)
    );
    let codex = project.join(".agents/skills/reviewer");
    let claude = project.join(".claude/skills/reviewer");
    fs::remove_dir_all(&claude).unwrap();
    symlink(&codex, &claude).unwrap();
    let receipt_path = project.join(".agentkib/skill-deployments.json");
    let original_receipts = fs::read(&receipt_path).unwrap();
    let listed = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let record = |path: &Path| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["target"] == path.to_str().unwrap())
            .unwrap()
    };
    assert_eq!(record(&codex)["status"], "current");
    assert_eq!(record(&claude)["status"], "modified");
    assert_ne!(record(&codex)["id"], record(&claude)["id"]);
    let codex_id = record(&codex)["id"].clone();
    let claude_id = record(&claude)["id"].clone();
    assert_eq!(runtime.call("skills.listDeployments", json!({})), listed);
    assert_eq!(fs::read(&receipt_path).unwrap(), original_receipts);
    let blocked = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "undeploy", "deployment_id": claude_id}),
    );
    assert!(
        !blocked["targets"][0]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    fs::write(source.join("SKILL.md"), &second).unwrap();
    let update = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "update", "deployment_id": codex_id}),
    );
    assert_eq!(update["targets"][0]["conflicts"], json!([]), "{update}");
    let updated = runtime.call(
        "skills.applyDeployment",
        json!({"token": update["token"], "confirmed": true}),
    );
    assert_eq!(updated["results"][0]["success"], true, "{updated}");
    assert_eq!(fs::read_to_string(codex.join("SKILL.md")).unwrap(), second);
    assert_eq!(fs::read_link(&claude).unwrap(), codex);

    let external = root.join("home/.cc-switch/skills/reviewer");
    fs::create_dir_all(&external).unwrap();
    fs::write(external.join("SKILL.md"), first).unwrap();
    fs::remove_file(&claude).unwrap();
    symlink(&external, &claude).unwrap();
    let inventory = runtime.call("skills.inventory", json!({}));
    let external_observation = inventory["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == external.to_str().unwrap())
        .unwrap();
    assert_eq!(external_observation["owner"], "external");
    assert!(external_observation["library_id"].is_null());
    assert_eq!(
        runtime
            .call("skills.listDeployments", json!({}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fs::read_to_string(external.join("SKILL.md")).unwrap(),
        first
    );
}

#[test]
fn mixed_scope_operation_recovers_from_its_listed_project_without_extra_home_approval() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    let store = Store::open(&root.join("data/agentkib.db")).unwrap();
    store.add_scan_root(&project, 1).unwrap();
    drop(store);
    let source = root.join("library/skills/reviewer");
    let external = root.join("home/.agents/skills/reviewer");
    let content = "---\nname: reviewer\ndescription: Mixed scope fixture\n---\nBody\n";
    for path in [&source, &external] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("SKILL.md"), content).unwrap();
    }
    let mut runtime = Runtime::start(root);
    let workspace = runtime.call("workspace.add", json!({"path": project}));
    let targets = runtime.call("skills.targets", json!({}));
    let selected = targets
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| {
            target["agent"] == "codex"
                && (target["scope"] == "personal" || target["workspace_id"] == workspace["id"])
        })
        .map(|target| target["id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 2);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": "reviewer", "target_ids": selected}),
    );
    assert_eq!(preview["requires_home_approval"], false);
    let token = preview["token"].as_str().unwrap();
    let apply = json!({"token": token, "confirmed": true, "approve_home": false});
    let report = runtime.call("skills.applyDeployment", apply.clone());
    assert_eq!(
        report["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|result| result["success"] == true)
            .count(),
        1
    );
    assert_eq!(
        runtime.call("skills.applyDeployment", apply.clone())["results"],
        report["results"]
    );
    drop(runtime);

    // Recreate a crash after native activation and before the project's receipt commit.
    // The skipped personal target never acquired a receipt or required Home approval.
    let journal_path = root
        .join("library/deployment-operations")
        .join(format!("{token}.json"));
    let mut journal: Value = serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    let pending = journal["targets"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|target| target["capability"]["scope"] == "workspace")
        .unwrap();
    pending["phase"] = json!("activated");
    pending["result"] = Value::Null;
    let reservation = pending["after_record"].clone();
    journal["report"] = Value::Null;
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::remove_file(project.join(".agentkib/skill-deployments.json")).unwrap();
    fs::write(
        project.join(".agentkib/skill-deployment-reservations.json"),
        serde_json::to_vec(&json!({"schema_version": 1, "deployments": [reservation]})).unwrap(),
    )
    .unwrap();

    let mut runtime = Runtime::start(root);
    let listed = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["scope"], "workspace");
    assert_eq!(listed[0]["status"], "recovery-required");
    assert_eq!(listed[0]["operation_id"], token);
    let native = project.join(".agents/skills/reviewer");
    let catalog = runtime.call("catalog.searchAssets", json!({}));
    assert!(
        catalog
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| { asset["path"] == native.to_str().unwrap() })
    );
    let operation_audits = || {
        Store::open(&root.join("data/agentkib.db"))
            .unwrap()
            .list_activity(500)
            .unwrap()
            .iter()
            .filter(|activity| activity.action == "skill.deployment" && activity.detail == token)
            .count()
    };
    let audits_before = operation_audits();
    let recovered = runtime.call("skills.applyDeployment", apply.clone());
    assert!(
        recovered["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|result| result["status"] == "recovered")
    );
    assert_eq!(recovered["warnings"], json!([]));
    assert!(!native.exists());
    // All results are unsuccessful for the originally requested operation, but
    // completing recovery still removes the stale native catalog rows and is audited.
    assert!(
        recovered["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| { result["success"] == false })
    );
    let catalog = runtime.call("catalog.searchAssets", json!({}));
    assert!(
        !catalog
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| { asset["path"] == native.to_str().unwrap() })
    );
    assert_eq!(operation_audits(), audits_before + 1);
    assert_eq!(
        fs::read_to_string(external.join("SKILL.md")).unwrap(),
        content
    );
    assert!(!root.join("home/.agents/.agentkib").exists());
    assert_eq!(
        runtime.call("skills.applyDeployment", apply)["results"],
        recovered["results"]
    );
    assert_eq!(runtime.call("skills.listDeployments", json!({})), json!([]));
}

#[test]
fn legacy_file_rpc_reads_current_text_independently_of_previous_version() {
    let fixture = empty_runtime_fixture();
    let root = fixture.path();
    let current = root.join("library/skills/reviewer");
    let previous = root.join("library/backups/skills/reviewer");
    for package in [&current, &previous] {
        fs::create_dir_all(package.join("references")).unwrap();
        fs::write(
            package.join("SKILL.md"),
            "---\nname: reviewer\ndescription: Fixture\n---\nFixture\n",
        )
        .unwrap();
    }
    fs::write(
        current.join("references/guide.md"),
        "Current readable guide",
    )
    .unwrap();
    fs::write(previous.join("references/guide.md"), [0, 255, 42]).unwrap();
    fs::write(
        root.join("library/skills.lock.json"),
        json!({
            "schema_version": 1,
            "skills": {},
            "previous": {"reviewer": {
                "source": null,
                "content_sha256": "previous",
                "installed_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z"
            }}
        })
        .to_string(),
    )
    .unwrap();
    let mut runtime = Runtime::start(root);
    let versions = runtime.call(
        "skills.readDetailFile",
        json!({"library_id": "reviewer", "path": "references/guide.md"}),
    );
    assert_eq!(versions["binary"], true);
    assert_eq!(versions["after"], "Current readable guide");
    let current_file = runtime.call(
        "skills.readFile",
        json!({"name": "reviewer", "path": "references/guide.md"}),
    );
    assert_eq!(current_file["content"], "Current readable guide");
    assert_eq!(current_file["path"], "references/guide.md");
}

#[test]
fn reregistered_project_keeps_deployment_lifecycle_without_read_time_migration() {
    let fixture = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(root.join("home")).unwrap();
    fs::create_dir_all(root.join("data")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fs::write(
        root.join("data/preferences.json"),
        json!({"mcp_network": {"port": port, "lan_enabled": false, "lan_risk_accepted": false}})
            .to_string(),
    )
    .unwrap();
    let source = root.join("library/skills/reregistered");
    fs::create_dir_all(&source).unwrap();
    let first = "---\nname: reregistered\ndescription: Registration fixture\n---\nFirst\n";
    let second = first.replace("First", "Second");
    fs::write(source.join("SKILL.md"), first).unwrap();
    let mut runtime = Runtime::start(root);
    let mut workspace_id = runtime.call("workspace.add", json!({"path": project}))["id"].clone();
    let targets = runtime.call("skills.targets", json!({}));
    let target = targets
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["agent"] == "codex" && target["workspace_id"] == workspace_id)
        .unwrap();
    let apply = |runtime: &mut Runtime, params| {
        let preview = runtime.call("skills.prepareDeployment", params);
        assert_eq!(preview["targets"][0]["conflicts"], json!([]), "{preview}");
        let report = runtime.call(
            "skills.applyDeployment",
            json!({"token": preview["token"], "confirmed": true, "approve_home": false}),
        );
        assert_eq!(report["results"][0]["success"], true, "{report}");
        report
    };
    let report = apply(
        &mut runtime,
        json!({"operation": "deploy", "library_id": "reregistered", "target_ids": [target["id"]]}),
    );
    let deployment_id = report["results"][0]["deployment_id"].clone();
    let receipt = project.join(".agentkib/skill-deployments.json");
    let deployed = project.join(".agents/skills/reregistered");
    fs::write(source.join("SKILL.md"), &second).unwrap();
    for (operation, expected) in [
        ("update", Some(second.as_str())),
        ("rollback", Some(first)),
        ("undeploy", None),
    ] {
        let previous_receipt = fs::read(&receipt).unwrap();
        runtime.call("workspace.exclude", json!({"id": workspace_id}));
        let registered = runtime.call("workspace.add", json!({"path": project}));
        assert_ne!(registered["id"], workspace_id);
        workspace_id = registered["id"].clone();
        let deployments = runtime.call("skills.listDeployments", json!({}));
        assert_eq!(deployments[0]["id"], deployment_id);
        assert_eq!(deployments[0]["workspace_id"], workspace_id);
        runtime.call("skills.inventory", json!({}));
        assert_eq!(fs::read(&receipt).unwrap(), previous_receipt);
        apply(
            &mut runtime,
            json!({"operation": operation, "deployment_id": deployment_id}),
        );
        if let Some(expected) = expected {
            assert_eq!(
                fs::read_to_string(deployed.join("SKILL.md")).unwrap(),
                expected
            );
        } else {
            assert!(!deployed.exists());
        }
        let stored: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        assert_eq!(stored["deployments"][0]["workspace_id"], workspace_id);
    }
}

#[test]
fn native_restrictions_and_project_trust_survive_deployment_content_drift() {
    let fixture = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    let store = Store::open(&root.join("data/agentkib.db")).unwrap();
    let workspace = store.add_workspace(&project).unwrap();
    drop(store);
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fs::write(
        root.join("data/preferences.json"),
        json!({"mcp_network": {"port": port, "lan_enabled": false, "lan_risk_accepted": false}})
            .to_string(),
    )
    .unwrap();
    let source = root.join("library/skills/native-state");
    fs::create_dir_all(&source).unwrap();
    let content = "---\nname: native-state\ndescription: Native state fixture\n---\n# Fixture\n";
    fs::write(source.join("SKILL.md"), content).unwrap();
    let openclaw_home = root.join("home/.openclaw");
    fs::create_dir_all(&openclaw_home).unwrap();
    fs::write(
        openclaw_home.join("openclaw.json"),
        json!({"skills": {"entries": {"native-state": {"enabled": false}}}}).to_string(),
    )
    .unwrap();

    let mut runtime = Runtime::start(root);
    let targets = runtime.call("skills.targets", json!({}));
    let selected = targets
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| {
            (target["agent"] == json!(agentkib_core::AgentKind::OpenClaw)
                && target["scope"] == "personal")
                || (target["agent"] == "hermes" && target["workspace_id"] == workspace.id)
        })
        .map(|target| target["id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 2);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": "native-state", "target_ids": selected}),
    );
    let report = runtime.call(
        "skills.applyDeployment",
        json!({"token": preview["token"], "confirmed": true, "approve_home": true}),
    );
    assert!(
        report["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["success"] == true),
        "{report}"
    );
    let destinations = [
        (
            openclaw_home.join("skills/native-state"),
            "native-restricted",
        ),
        (project.join(".hermes/skills/native-state"), "pending-trust"),
    ];
    for modified in [false, true] {
        if modified {
            for (path, _) in &destinations {
                fs::write(path.join("SKILL.md"), format!("{content}\nLocal edit\n")).unwrap();
            }
        }
        let inventory = runtime.call("skills.inventory", json!({}));
        let deployments = runtime.call("skills.listDeployments", json!({}));
        for (path, expected_native) in &destinations {
            let observation = inventory["observations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|observation| observation["path"] == path.to_str().unwrap())
                .unwrap();
            assert_eq!(observation["owner"], "agentkib");
            assert_eq!(observation["library_id"], "native-state");
            assert_eq!(observation["status"], *expected_native, "{observation}");
            let deployment = deployments
                .as_array()
                .unwrap()
                .iter()
                .find(|deployment| deployment["target"] == path.to_str().unwrap())
                .unwrap();
            assert_eq!(
                deployment["status"],
                if modified { "modified" } else { "current" }
            );
        }
    }
}

#[test]
fn external_link_import_shared_deployment_and_restart_retry_use_the_full_rpc_chain() {
    let fixture = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = fixture.path();
    let project = root.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    let store = Store::open(&root.join("data/agentkib.db")).unwrap();
    let workspace = store.add_workspace(&project).unwrap();
    drop(store);
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fs::write(
        root.join("data/preferences.json"),
        json!({
            "mcp_network": {"port": port, "lan_enabled": false, "lan_risk_accepted": false}
        })
        .to_string(),
    )
    .unwrap();
    let external = root.join("home/.cc-switch/skills/fixture-skill");
    fs::create_dir_all(external.join("custom")).unwrap();
    fs::create_dir_all(external.join("agents")).unwrap();
    fs::write(
        external.join("SKILL.md"),
        "---\nname: fixture-skill\ndescription: RPC fixture\n---\n# Fixture\n",
    )
    .unwrap();
    fs::write(external.join("custom/image.bin"), [0, 255, 13, 10]).unwrap();
    fs::write(
        external.join("custom/run.sh"),
        "#!/bin/sh\nprintf fixture\n",
    )
    .unwrap();
    fs::set_permissions(
        external.join("custom/run.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(external.join("LICENSE"), "Fixture license").unwrap();
    fs::write(
        external.join("agents/openai.yaml"),
        "interface:\n  display_name: Fixture\n",
    )
    .unwrap();
    let manager_metadata = root.join("home/.cc-switch/metadata.json");
    fs::write(&manager_metadata, "{\"owner\":\"cc-switch\"}").unwrap();
    let external_link = root.join("home/.claude/skills/fixture-skill");
    fs::create_dir_all(external_link.parent().unwrap()).unwrap();
    symlink(&external, &external_link).unwrap();

    let mut runtime = Runtime::start(root);
    let inventory = runtime.call("skills.inventory", json!({}));
    let observed = inventory["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == external_link.to_str().unwrap())
        .unwrap();
    assert_eq!(observed["owner"], "external");
    let observation_id = observed["id"].clone();
    let detail = runtime.call(
        "skills.getDetail",
        json!({"observation_id": observation_id}),
    );
    let entries = detail["files"].as_array().unwrap();
    assert_eq!(entries.len(), 7);
    assert!(entries.iter().any(|entry| entry["path"] == "agents/"));
    assert!(entries.iter().any(|entry| entry["path"] == "custom/"));
    let import = runtime.call(
        "skills.prepareImport",
        json!({"observation_id": observation_id}),
    );
    let binary = runtime.call(
        "skills.readPreviewFile",
        json!({"token": import["token"], "path": "custom/image.bin"}),
    );
    assert_eq!(binary["binary"], true);
    assert_eq!(binary["after_size"], 4);
    assert!(
        runtime
            .request(
                "skills.readPreviewFile",
                json!({"token": import["token"], "path": "../metadata.json"})
            )
            .get("error")
            .is_some()
    );
    let installed = runtime.call(
        "skills.applyOperation",
        json!({"token": import["token"], "confirmed": true}),
    );
    let library_id = installed["name"].clone();
    assert_eq!(installed["content_sha256"].as_str().unwrap().len(), 64);
    let imported = runtime.call("skills.getDetail", json!({"library_id": library_id}));
    assert_eq!(imported["local_source"], external_link.to_str().unwrap());
    let targets = runtime.call("skills.targets", json!({}));
    let selected = targets
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| {
            target["workspace_id"] == workspace.id
                && (target["agent"] == "codex" || target["agent"] == "antigravity")
        })
        .map(|target| target["id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 2);
    let preview = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "deploy", "library_id": library_id, "target_ids": selected}),
    );
    assert_eq!(preview["targets"].as_array().unwrap().len(), 1);
    assert_eq!(preview["targets"][0]["agents"].as_array().unwrap().len(), 2);
    let apply_params = json!({"token": preview["token"], "confirmed": true, "approve_home": false});
    let report = runtime.call("skills.applyDeployment", apply_params.clone());
    assert_eq!(report["results"][0]["success"], true, "{report}");
    let deployed = project.join(".agents/skills/fixture-skill");
    assert_eq!(
        fs::read(deployed.join("custom/image.bin")).unwrap(),
        [0, 255, 13, 10]
    );
    assert_ne!(
        fs::metadata(deployed.join("custom/run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert!(project.join(".agentkib/skill-deployments.json").is_file());
    assert!(!project.join(".agentkib/manifest.yaml").exists());
    assert!(
        runtime
            .request(
                "skills.uninstall",
                json!({"name": library_id, "confirmed": true})
            )
            .get("error")
            .is_some()
    );
    drop(runtime);

    let mut runtime = Runtime::start(root);
    let retried = runtime.call("skills.applyDeployment", apply_params);
    assert_eq!(retried["operation_id"], report["operation_id"]);
    assert_eq!(retried["results"], report["results"]);
    let deployments = runtime.call("skills.listDeployments", json!({}));
    assert_eq!(deployments.as_array().unwrap().len(), 1);
    assert_eq!(deployments[0]["package_hash"], installed["content_sha256"]);
    let withdraw = runtime.call(
        "skills.prepareDeployment",
        json!({"operation": "undeploy", "deployment_id": deployments[0]["id"]}),
    );
    let removed = runtime.call(
        "skills.applyDeployment",
        json!({"token": withdraw["token"], "confirmed": true, "approve_home": false}),
    );
    assert_eq!(removed["results"][0]["success"], true, "{removed}");
    assert!(!deployed.exists());
    assert_eq!(fs::read_link(&external_link).unwrap(), external);
    assert_eq!(
        fs::read_to_string(manager_metadata).unwrap(),
        "{\"owner\":\"cc-switch\"}"
    );
    assert!(external.join("custom/image.bin").is_file());
    runtime.call(
        "skills.uninstall",
        json!({"name": library_id, "confirmed": true}),
    );

    // The package write must stay successful even if the derived index becomes unavailable.
    let retry_import = runtime.call(
        "skills.prepareImport",
        json!({"observation_id": observation_id}),
    );
    fs::rename(root.join("data/agentkib.db"), root.join("data/saved.db")).unwrap();
    fs::create_dir(root.join("data/agentkib.db")).unwrap();
    let saved = runtime.call(
        "skills.applyOperation",
        json!({"token": retry_import["token"], "confirmed": true}),
    );
    assert!(saved["warnings"].as_array().unwrap().len() >= 2, "{saved}");
    assert!(
        Path::new(saved["path"].as_str().unwrap())
            .join("SKILL.md")
            .is_file()
    );
}
