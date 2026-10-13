import path from "node:path";
import { z } from "zod";
import { canonicalProject, within } from "./files";
import { canonicalize } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { agentSchema, parameters } from "./rpc";
import { Catalog } from "./catalog";
import { Commands } from "./commands";
import { sources } from "./context-sources";
import { antigravitySources } from "./context-antigravity";
import { claudeSections } from "./context-claude";
import { readClaudeVersion } from "./claude-version";
import { budgetWarning, loadImports, TOTAL_CHARS } from "./context-files";
import {
  deepseekRoot,
  deepseekSections,
  deepseekSkills,
  grokSections,
  type Section,
} from "./context-special";
import { visibleMcpNames } from "./mcp-config-read";
export interface ContextOptions {
  /**
   * Whether the contents of Claude Code imports outside the project are returned. In-process
   * only, never part of an RPC payload: the MCP tool turns it off so that a connected Agent
   * cannot read through the preview what Claude Code itself would ask the user about.
   */
  externalBodies?: boolean;
}
export class Context {
  #version?: { at: number; value: string | null };
  #probe?: Promise<string | null>;
  constructor(
    readonly catalog: Catalog,
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
  ) {}
  /** `claude --version`, cached for 30 seconds; concurrent callers share one probe. */
  #claudeVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000)
      return Promise.resolve(this.#version.value);
    this.#probe ??= readClaudeVersion(this.commands, this.environment)
      .then((value) => {
        this.#version = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#probe = undefined;
      });
    return this.#probe;
  }
  async request(value: unknown, options: ContextOptions = {}) {
    const { project, cwd, agent } = parameters(
      z.object({ project: z.string(), cwd: z.string(), agent: agentSchema }),
      value,
    );
    let manifest: Manifest | null = null;
    try {
      manifest = loadManifest(project);
    } catch {}
    let memories: string[] = [];
    if (manifest)
      try {
        memories = this.catalog
          .memories(manifest.workspace.id, "approved")
          .map((value) => value.content);
      } catch {}
    const preview = await this.resolve(project, cwd, agent, manifest, memories, options);
    preview.visible_connections = visibleMcpNames(project, agent, this.environment);
    return preview;
  }
  async resolve(
    project: string,
    workingDirectory: string,
    agent: string,
    manifest: Manifest | null,
    approvedMemories: string[],
    options: ContextOptions = {},
  ) {
    const root = canonicalProject(project),
      requested = path.isAbsolute(workingDirectory)
        ? workingDirectory
        : path.join(root, workingDirectory);
    let cwd: string;
    try {
      cwd = canonicalize(requested);
    } catch {
      throw new Error(`Working directory does not exist: ${requested}`);
    }
    if (!within(cwd, root)) throw new Error("Working directory must be inside the project");
    const contextRoot = agent === "deepseek-harness" ? deepseekRoot(root, cwd) : root,
      dirs: string[] = [];
    for (let current = cwd; ; current = path.dirname(current)) {
      dirs.unshift(current);
      if (current === contextRoot) break;
      if (path.dirname(current) === current)
        throw new Error("Working directory must be inside the project");
    }
    const warnings: string[] = [];
    let sections: Section[] = [];
    if (agent === "deepseek-harness")
      sections = deepseekSections(contextRoot, dirs, warnings, this.environment);
    else if (agent === "grok-build")
      sections = await grokSections(root, dirs, warnings, this.environment, this.commands);
    else if (agent === "claude-code")
      sections = await claudeSections({
        root,
        cwd,
        dirs,
        environment: this.environment,
        budget: { remaining: TOTAL_CHARS },
        warnings,
        externalBodies: options.externalBodies !== false,
        version: () => this.#claudeVersion(),
      });
    else {
      const files =
          agent === "antigravity"
            ? antigravitySources(dirs, warnings, this.environment)
            : sources(agent, dirs, warnings, this.environment),
        budget = { remaining: TOTAL_CHARS };
      for (const source of files) {
        if (!budget.remaining) {
          budgetWarning(warnings);
          break;
        }
        const external = ["opencode", "antigravity"].includes(agent) && !within(source, root);
        let externalRoot: string | null = null;
        try {
          if (external) externalRoot = canonicalize(path.dirname(source));
        } catch {}
        const start = warnings.length;
        try {
          const content = loadImports(source, externalRoot ?? root, budget, warnings);
          sections.push({
            source,
            scope: external ? "agent-home" : path.relative(root, path.dirname(source)),
            content,
            precedence: sections.length,
          });
        } catch (error) {
          warnings.push((error as Error).message);
        }
        if (external)
          for (let i = start; i < warnings.length; i++) warnings[i] = `Agent home: ${warnings[i]}`;
      }
    }
    const hasProject = sections.some((section) => section.scope !== "agent-home");
    if (!hasProject) warnings.push("No project instruction file was found for this Agent");
    const override =
      manifest?.instructions.platform_overrides[agent as z.infer<typeof agentSchema>];
    if (
      override?.trim() &&
      !sections.some((section) => section.content.includes(override.trim()))
    ) {
      if (hasProject)
        warnings.push(
          "The platform override is applied after native project instructions; check for semantic conflicts",
        );
      sections.push({
        source: manifestPath(root),
        scope: "platform-override",
        content: override,
        precedence: sections.length,
      });
    }
    return {
      agent,
      project: contextRoot,
      cwd,
      sections,
      visible_skills:
        agent === "deepseek-harness"
          ? deepseekSkills(contextRoot, this.environment)
          : (manifest?.skills
              .filter(
                (skill) =>
                  !skill.targets.length ||
                  skill.targets.includes(agent as z.infer<typeof agentSchema>),
              )
              .map((skill) => skill.name) ?? []),
      visible_connections:
        agent === "deepseek-harness"
          ? []
          : (manifest?.connections
              .filter(
                (connection) =>
                  !connection.targets.length ||
                  connection.targets.includes(agent as z.infer<typeof agentSchema>),
              )
              .map((connection) => connection.name) ?? []),
      approved_memories: agent === "deepseek-harness" ? [] : approvedMemories,
      warnings,
    };
  }
}
