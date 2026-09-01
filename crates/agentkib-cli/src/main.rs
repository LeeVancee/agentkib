use std::env;
use std::path::PathBuf;

use agentkib_adapters::{HomeTargets, default_manifest, plan_workspace_changes};
use agentkib_core::{
    AgentKind, load_manifest, resolve_context, scan_workspace, validate_workspace,
};
use anyhow::{Context, Result, bail};

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "scan" => {
            let project = required_path(&args, 1)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&scan_workspace(&project)?)?
            );
        }
        "context" => {
            let project = required_path(&args, 1)?;
            let agent = parse_agent(args.get(2).context("Missing agent argument")?)?;
            let cwd = args
                .get(3)
                .map(PathBuf::from)
                .unwrap_or_else(|| project.clone());
            let manifest = load_manifest(&project).ok();
            println!(
                "{}",
                serde_json::to_string_pretty(&resolve_context(
                    &project,
                    &cwd,
                    agent,
                    manifest.as_ref(),
                    Vec::new()
                )?)?
            );
        }
        "plan" => {
            let project = required_path(&args, 1)?;
            let manifest = if agentkib_core::manifest_path(&project).is_file() {
                load_manifest(&project)?
            } else {
                default_manifest(&project)?
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&plan_workspace_changes(
                    &project,
                    &manifest,
                    &HomeTargets::default()
                )?)?
            );
        }
        "validate" => {
            let project = required_path(&args, 1)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&validate_workspace(&project)?)?
            );
        }
        "manifest" => {
            let project = required_path(&args, 1)?;
            println!("{}", serde_yaml::to_string(&default_manifest(&project)?)?);
        }
        _ => print_help(),
    }
    Ok(())
}

fn required_path(args: &[String], index: usize) -> Result<PathBuf> {
    Ok(PathBuf::from(
        args.get(index).context("Missing project path")?,
    ))
}
fn parse_agent(value: &str) -> Result<AgentKind> {
    match value {
        "codex" => Ok(AgentKind::Codex),
        "claude" | "claude-code" => Ok(AgentKind::ClaudeCode),
        "cursor" => Ok(AgentKind::Cursor),
        "opencode" => Ok(AgentKind::OpenCode),
        "openclaw" => Ok(AgentKind::OpenClaw),
        "hermes" => Ok(AgentKind::Hermes),
        "deepseek-harness" | "dsh" => Ok(AgentKind::DeepSeekHarness),
        _ => bail!("Unknown Agent: {value}"),
    }
}
fn print_help() {
    println!(
        "agentkib scan <project>\nagentkib context <project> <codex|claude-code|cursor|opencode|openclaw|hermes|deepseek-harness> [cwd]\nagentkib plan <project>\nagentkib validate <project>\nagentkib manifest <project>"
    );
}
