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
  upstream?: string;
  ahead: number;
  behind: number;
  stash_count: number;
  detached: boolean;
  refs: Array<{ name: string; full_name: string; kind: string; current: boolean }>;
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
  refs: Array<{ name: string; full_name: string; kind: string; current: boolean }>;
}
export interface GitCommitPage {
  commits: GitCommitSummary[];
  next_cursor?: string;
  repository_fingerprint: string;
}
export interface GitFileChange {
  status: string;
  path: string;
  old_path?: string;
}
export interface GitDiffRequest {
  kind: "commit" | "worktree" | "staged";
  path?: string;
  oid?: string;
}
export interface GitDiff {
  patch: string;
  binary: boolean;
  submodule: boolean;
  encoding_lossy: boolean;
  truncated: boolean;
}

async function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  try {
    return (await run("git", args, { cwd, maxBuffer })).stdout;
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
  const upstream =
    (
      await git(worktree_root, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]).catch(() => "")
    ).trim() || undefined;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (
      await git(worktree_root, [
        "rev-list",
        "" + upstream + "...HEAD",
        "--left-right",
        "--count",
      ]).catch(() => "")
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    behind = Number.isFinite(counts[0]) ? counts[0] : 0;
    ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  }
  const stash_count = (await git(worktree_root, ["stash", "list"]).catch(() => ""))
    .split("\n")
    .filter(Boolean).length;
  const refs = (
    await git(worktree_root, ["for-each-ref", "--format=%(refname)\t%(HEAD)"]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [full_name, marker] = line.split("\t");
      const kind = full_name.startsWith("refs/tags/")
        ? "tag"
        : full_name.startsWith("refs/remotes/")
          ? "remote-branch"
          : "local-branch";
      return {
        full_name,
        name: full_name.replace(/^refs\/(heads|remotes|tags)\//, ""),
        kind,
        current: marker === "*",
      };
    });
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
    upstream,
    ahead,
    behind,
    stash_count,
    detached: !head,
    refs,
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
    "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s",
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
    const [oid, parents, author_name, authored_at, decoration, subject] = line.split("\x1f");
    const refs = decoration
      ? decoration
          .split(", ")
          .filter(Boolean)
          .map((value) => {
            const current = value.startsWith("HEAD -> ");
            const clean = value.replace(/^HEAD -> /, "");
            const full_name = clean.startsWith("tag: ")
              ? `refs/tags/${clean.slice(5)}`
              : clean.startsWith("origin/")
                ? `refs/remotes/${clean}`
                : `refs/heads/${clean}`;
            const kind = clean.startsWith("tag: ")
              ? "tag"
              : clean.includes("/")
                ? "remote-branch"
                : "local-branch";
            return { name: clean.replace(/^tag: /, ""), full_name, kind, current };
          })
      : [];
    return {
      oid,
      parents: parents ? parents.split(" ") : [],
      author_name,
      authored_at,
      refs,
      subject,
    };
  });
  return { commits, repository_fingerprint: summary.head_oid ?? "" };
}
export async function commitFiles(workspace: string, oid: string): Promise<GitFileChange[]> {
  if (!/^[0-9a-f]{7,64}$/i.test(oid)) throw backendError("VALIDATION", "Invalid commit id");
  const output = await git(workspace, [
    "show",
    "--format=",
    "--name-status",
    "--find-renames",
    oid,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split("\t");
      return { status, path: second ?? first, old_path: second ? first : undefined };
    });
}
export async function diff(workspace: string, request: GitDiffRequest): Promise<GitDiff> {
  const args =
    request.kind === "commit"
      ? ["show", "--format=", "--patch", "--binary", request.oid ?? ""]
      : request.kind === "staged"
        ? ["diff", "--cached", "--patch", "--binary"]
        : ["diff", "--patch", "--binary"];
  if (request.kind === "commit" && !request.oid)
    throw backendError("VALIDATION", "Commit id is required");
  if (request.path) {
    if (request.path.includes("..") || request.path.startsWith("/"))
      throw backendError("VALIDATION", "Git path must be relative");
    args.push("--", request.path);
  }
  const output = await git(workspace, args, 4 * 1024 * 1024);
  const truncated = output.length >= 4 * 1024 * 1024;
  return {
    patch: output.slice(0, 4 * 1024 * 1024),
    binary: output.includes("Binary files"),
    submodule: output.includes("Subproject commit"),
    encoding_lossy: output.includes("\ufffd"),
    truncated,
  };
}
