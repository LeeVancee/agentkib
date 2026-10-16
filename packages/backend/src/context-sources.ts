import path from "node:path";
import { lstatSync, statSync, opendirSync } from "node:fs";
import JSON5 from "json5";
import { isFile, walk, within } from "./files";
import { canonicalize, pathIdentity } from "./paths";
import {
  firstExisting,
  sortedFiles,
  cursorAlways,
  readContextText,
  FILE_CHARS,
} from "./context-files";
import { openCodeInstructionPatterns } from "./default-manifest";
import { globMatches } from "./context-glob";
import { userHome } from "./mcp-config-read";
export function sensitive(value: string): boolean {
  const name = path.basename(value).toLowerCase();
  return name === ".env" || /credential|token|secret/.test(name) || /\.(pem|key)$/.test(name);
}
function configuredSources(
  root: string,
  base: string,
  patterns: string[],
  warnings: string[],
): string[] {
  const output: string[] = [],
    seen = new Set<string>();
  const add = (file: string) => {
    try {
      const metadata = lstatSync(file);
      if (!metadata.isFile() || metadata.size > FILE_CHARS * 4 || sensitive(file)) return;
      const canonical = canonicalize(file);
      if (!within(canonical, canonicalize(root)) || seen.has(canonical)) return;
      seen.add(canonical);
      output.push(file);
    } catch {}
  };
  for (const raw of patterns) {
    if (raw.startsWith("http://") || raw.startsWith("https://")) continue;
    const pattern = raw.replace(/^(?:\.\/)+/, "");
    if (!pattern || path.isAbsolute(pattern) || pattern.startsWith("~/")) {
      warnings.push(`OpenCode instruction source is outside the project and was not read: ${raw}`);
      continue;
    }
    if (/[*?[{@+!(]/.test(pattern)) {
      let count = 1,
        stopped = false;
      let device: bigint;
      try {
        if (lstatSync(base).isSymbolicLink()) continue;
        device = statSync(base, { bigint: true }).dev;
      } catch {
        continue;
      }
      const visit = (directory: string, depth: number) => {
        if (depth > 16 || stopped) return;
        let files: string[] = [];
        try {
          const reader = opendirSync(directory);
          try {
            for (let entry = reader.readSync(); entry; entry = reader.readSync())
              files.push(path.join(directory, entry.name));
          } finally {
            reader.closeSync();
          }
        } catch {
          return;
        }
        for (const file of files) {
          let metadata;
          try {
            metadata = lstatSync(file, { bigint: true });
          } catch {
            continue;
          }
          if (metadata.isSymbolicLink() || metadata.dev !== device) continue;
          count++;
          if (count > 8192) {
            stopped = true;
            warnings.push(`OpenCode instruction glob scan limit was reached: ${raw}`);
            return;
          }
          if (metadata.isDirectory()) visit(file, depth + 1);
          else if (
            metadata.isFile() &&
            globMatches(pattern, path.relative(base, file).replaceAll("\\", "/"))
          )
            add(file);
          if (stopped) return;
        }
      };
      visit(base, 1);
    } else add(path.join(base, pattern));
  }
  return output;
}
function globalPatterns(home: string, skipSource: (file: string) => boolean): string[] {
  let effective: string[] = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    if (skipSource(path.join(home, name))) continue;
    try {
      const content = readContextText(path.join(home, name), 1024 * 1024, skipSource, true),
        value = name.endsWith(".jsonc") ? JSON5.parse(content) : JSON.parse(content);
      if (Array.isArray(value.instructions))
        effective = value.instructions.filter((value: unknown) => typeof value === "string");
    } catch {}
  }
  return effective;
}
export function sources(
  agent: string,
  dirs: string[],
  warnings: string[],
  environment: NodeJS.ProcessEnv,
  skipSource: (file: string) => boolean = () => false,
): string[] {
  const root = dirs[0]!;
  switch (agent) {
    case "codex":
      return dirs.flatMap((dir) => {
        const file = firstExisting(dir, ["AGENTS.override.md", "AGENTS.md"]);
        return file ? [file] : [];
      });
    case "cursor":
      return dirs.flatMap((dir) => [
        ...[path.join(dir, "AGENTS.md")].filter(isFile),
        ...sortedFiles(path.join(dir, ".cursor/rules"), ".mdc").filter(
          (file) => !skipSource(file) && cursorAlways(file, skipSource),
        ),
      ]);
    case "open-claw":
      return [
        ...["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md"]
          .map((name) => path.join(root, name))
          .filter(isFile),
        ...dirs
          .slice(1)
          .map((dir) => path.join(dir, "AGENTS.md"))
          .filter(isFile),
      ];
    case "hermes":
      return dirs.flatMap((dir) => {
        const file = firstExisting(dir, [
          ".hermes.md",
          "HERMES.md",
          "AGENTS.md",
          "CLAUDE.md",
          ".cursorrules",
        ]);
        return file ? [file] : [];
      });
    case "opencode": {
      const user = userHome(environment),
        xdg =
          environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
            ? environment.XDG_CONFIG_HOME
            : path.join(user, ".config"),
        config = path.join(xdg, "opencode"),
        global =
          firstExisting(config, ["AGENTS.md"]) ??
          firstExisting(path.join(user, ".claude"), ["CLAUDE.md"]),
        result = [
          ...(global ? [global] : []),
          ...configuredSources(config, config, globalPatterns(config, skipSource), warnings),
          ...dirs.flatMap((dir) => {
            const file = firstExisting(dir, ["AGENTS.md", "CLAUDE.md"]);
            return file ? [file] : [];
          }),
          ...dirs.flatMap((dir) =>
            configuredSources(
              root,
              dir,
              openCodeInstructionPatterns(dir, skipSource, (file) =>
                readContextText(file, 1024 * 1024, skipSource, true),
              ),
              warnings,
            ),
          ),
        ];
      const seen = new Set<string>();
      return result.filter((file) => {
        try {
          const key = pathIdentity(canonicalize(file));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        } catch {
          return false;
        }
      });
    }
    default:
      return [];
  }
}
export function ruleFiles(root: string): string[] {
  return walk(root, 16)
    .filter((file) => path.extname(file).toLowerCase() === ".md")
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
