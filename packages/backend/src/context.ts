import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalProject, within, withinLexical } from "./files";
import { canonicalize } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { agentSchema, parameters } from "./rpc";
import { Catalog } from "./catalog";
import { Commands } from "./commands";
import { sources } from "./context-sources";
import { antigravitySources } from "./context-antigravity";
import { claudeSections, stripBlockComments } from "./context-claude";
import { readClaudeVersion } from "./claude-version";
import {
  CONTEXT_NOTE_PREFIX,
  budgetWarning,
  isProjectScope,
  loadImports,
  TOTAL_CHARS,
} from "./context-files";
import type { ClaudeIo } from "./context-claude-sources";
import {
  deepseekRoot,
  deepseekSections,
  deepseekSkills,
  grokSections,
  type Section,
} from "./context-special";
import { userHome, visibleMcpNames } from "./mcp-config-read";
export interface ContextOptions {
  /**
   * Whether the contents of Claude Code sources outside the workspace are returned: imports
   * outside the project, and the user-level, managed, parent-directory and auto memory files.
   * In-process only, never part of an RPC payload: the MCP tool turns it off, so a connected
   * Agent gets sizes and counts but no text and no paths, and cannot read through the preview
   * what Claude Code itself would ask the user about or what is private to the user.
   */
  externalBodies?: boolean;
  /**
   * Whether Claude Code sources outside the workspace are looked at at all. In-process only.
   * The Doctor turns it off, so that files it does not manage can never become a finding.
   */
  includeOutsideSources?: boolean;
}
/** Test seams for the Claude Code sources; the application never sets them. */
export interface ClaudeContextInternals {
  /** Where organization policy files live; `null` for none. */
  managedDir?: string | null;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  ancestorRules?: boolean;
}
export class Context {
  #version?: { at: number; value: string | null };
  #probe?: Promise<string | null>;
  constructor(
    readonly catalog: Catalog,
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
    readonly claude: ClaudeContextInternals = {},
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
    // Other Agents read Claude Code's personal folder too (OpenCode reads ~/.claude/CLAUDE.md, Grok
    // Build its CLAUDE.md and rules). Over MCP those files are personal content of another tool,
    // so the connected Agent gets their number and size, and neither text nor path.
    const personal = new PersonalClaudeFiles(
      agent !== "claude-code" && options.externalBodies === false,
      this.environment,
    );
    if (agent === "deepseek-harness")
      sections = deepseekSections(contextRoot, dirs, warnings, this.environment);
    else if (agent === "grok-build")
      sections = personal.filter(
        await grokSections(root, dirs, warnings, this.environment, this.commands),
        warnings,
      );
    else if (agent === "claude-code")
      sections = await claudeSections({
        root,
        cwd,
        dirs,
        environment: this.environment,
        budget: { remaining: TOTAL_CHARS },
        warnings,
        externalBodies: options.externalBodies !== false,
        // Both off means the stricter one: the Doctor never touches the outside.
        outside:
          options.includeOutsideSources === false
            ? "none"
            : options.externalBodies === false
              ? "metadata"
              : "full",
        version: () => this.#claudeVersion(),
        ...this.claude,
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
        if (personal.skips(source)) continue;
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
    personal.report(warnings);
    const hasProject = sections.some((section) => isProjectScope(agent, section.scope));
    if (!hasProject) warnings.push("No project instruction file was found for this Agent");
    const override =
      manifest?.instructions.platform_overrides[agent as z.infer<typeof agentSchema>];
    // Claude Code drops block-level HTML comments from CLAUDE.md files, so the preview text may
    // lack a comment the override has; both sides are compared without them.
    const plain = agent === "claude-code" ? stripBlockComments : (text: string) => text;
    // For Claude Code only the project's own sources can carry the override; what is outside the
    // workspace is not there in every mode, and must not change the answer.
    const counts = (section: Section) =>
      agent !== "claude-code" || isProjectScope(agent, section.scope);
    if (
      override?.trim() &&
      !sections.some(
        (section) => counts(section) && plain(section.content).includes(plain(override.trim())),
      )
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

const FOLDER = ".claude";
/** Files in `~/.claude` that an Agent other than Claude Code reads, held back from the MCP tool. */
class PersonalClaudeFiles {
  readonly #folders: string[];
  readonly #files = new Map<string, number>();
  constructor(
    readonly active: boolean,
    environment: NodeJS.ProcessEnv,
  ) {
    const home = userHome(environment);
    let real = home;
    try {
      real = canonicalize(home);
    } catch {
      // The written spelling is all there is.
    }
    // The literal folder: these Agents read `~/.claude` themselves and know nothing of
    // CLAUDE_CONFIG_DIR, so this is deliberately not taken from claude-config.
    this.#folders = [...new Set([path.join(home, FOLDER), path.join(real, FOLDER)])];
  }
  #personal(file: string) {
    return this.active && this.#folders.some((folder) => withinLexical(file, folder));
  }
  /** True for a source that is held back (and counted); nothing of it is read. */
  skips(file: string): boolean {
    if (!this.#personal(file)) return false;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // Counted without a size.
    }
    this.#files.set(file, size);
    return true;
  }
  filter(sections: Section[], warnings: string[]): Section[] {
    if (!this.active) return sections;
    const kept = sections.filter((section) => !this.skips(section.source));
    // Warnings about a held-back file would name its path.
    if (kept.length !== sections.length) {
      const names = [...this.#files.keys()];
      for (let index = warnings.length - 1; index >= 0; index--)
        if (names.some((name) => warnings[index]!.includes(name))) warnings.splice(index, 1);
    }
    return kept;
  }
  report(warnings: string[]): void {
    if (!this.#files.size) return;
    const bytes = [...this.#files.values()].reduce((sum, size) => sum + size, 0);
    warnings.push(
      `${CONTEXT_NOTE_PREFIX}Claude Code user files that this Agent reads exist (${this.#files.size} ${this.#files.size === 1 ? "file" : "files"}, ${bytes} ${bytes === 1 ? "byte" : "bytes"}); their content is not included in this result.`,
    );
  }
}
