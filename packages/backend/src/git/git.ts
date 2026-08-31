import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalize } from "../platform/path.js";
import { backendError } from "../contracts.js";
const run = promisify(execFile);
export interface GitWorkspaceSummary {
  repository_root: string;
  worktree_root: string;
  head?: string;
  head_oid?: string;
  detached: boolean;
  changes: Array<{ path: string; kind: string; conflicted: boolean }>;
}
export interface GitHistoryQuery {
  limit?: number;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
}
export interface GitCommitSummary {
  oid: string;
  parents: string[];
  subject: string;
  author_name: string;
  authored_at: string;
}
export interface GitCommitPage {
  commits: GitCommitSummary[];
  next_cursor?: string;
  repository_fingerprint: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { code?: string };
    if (e.code === "ENOENT") throw backendError("NOT_FOUND", "Git is not installed");
    throw backendError("IO", "Git command failed");
  }
}
export async function workspaceSummary(
  workspace: string,
): Promise<GitWorkspaceSummary | undefined> {
  const root = await git(workspace, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!root) return undefined;
  const worktree_root = await canonicalize(root.trim());
  const head =
    (await git(worktree_root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() ||
    undefined;
  const oid = (await git(worktree_root, ["rev-parse", "HEAD"]).catch(() => "")).trim() || undefined;
  const status = await git(worktree_root, ["status", "--porcelain=v1"]);
  const changes = status
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      path: line.slice(3).trim(),
      kind: line.slice(0, 2).trim() || "unknown",
      conflicted: line[0] === "U" || line[1] === "U",
    }));
  return {
    repository_root: worktree_root,
    worktree_root,
    head,
    head_oid: oid,
    detached: !head,
    changes,
  };
}
export async function history(
  workspace: string,
  query: GitHistoryQuery = {},
): Promise<GitCommitPage | undefined> {
  const summary = await workspaceSummary(workspace);
  if (!summary) return undefined;
  const limit = Math.max(1, Math.min(query.limit ?? 300, 500));
  const args = [
    "log",
    `--max-count=${limit + 1}`,
    "--date=iso-strict",
    "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s",
  ];
  if (query.author) args.push(`--author=${query.author}`);
  if (query.since) args.push(`--since=${query.since}`);
  if (query.until) args.push(`--until=${query.until}`);
  if (query.path) {
    if (query.path.includes("..") || query.path.startsWith("/"))
      throw backendError("VALIDATION", "Git path must be relative");
    args.push("--", query.path);
  }
  const lines = (await git(summary.worktree_root, args)).trim().split("\n").filter(Boolean);
  const commits = lines.slice(0, limit).map((line) => {
    const [oid, parents, author_name, authored_at, subject] = line.split("\x1f");
    return { oid, parents: parents ? parents.split(" ") : [], author_name, authored_at, subject };
  });
  return { commits, repository_fingerprint: summary.head_oid ?? "" };
}
