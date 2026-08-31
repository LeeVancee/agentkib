import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { canonicalize } from "../platform/path.js";
import { backendError } from "../contracts.js";
import type { GitCommitRecord, GitIdentityCandidate, GitRepositorySnapshot } from "./types.js";
const run = promisify(execFile);
export function normalizeIdentity(email: string): string {
  return email.trim().toLowerCase();
}
export function identityAliases(emails: string[]): Set<string> {
  return new Set(emails.map(normalizeIdentity).filter(Boolean));
}
async function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  try {
    return (await run("git", args, { cwd, maxBuffer })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw backendError("NOT_FOUND", "Git is not installed");
    throw backendError("IO", "Git command failed");
  }
}
export async function collectGit(
  workspace: string,
  options: { since?: string; until?: string; identity_emails?: string[] } = {},
): Promise<GitRepositorySnapshot | undefined> {
  const root = await git(workspace, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  if (!root) return undefined;
  const path = await canonicalize(root.trim());
  const fingerprint = createHash("sha256").update(path).digest("hex");
  const args = ["log", "--max-count=500", "--date=iso-strict", "--format=%H%x1f%aI%x1f%ae"];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.until) args.push(`--until=${options.until}`);
  const commits: GitCommitRecord[] = (await git(path, args))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, authored_at, author_email] = line.split("\x1f");
      return { hash, authored_at, author_email: normalizeIdentity(author_email) };
    });
  const identities: GitIdentityCandidate[] = [];
  const configured = (await git(path, ["config", "--get-regexp", "^user\\.email$"]).catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^user\.email\s+/, ""))
    .map((email) => ({
      email: normalizeIdentity(email),
      label: "settings.gitIdentityRepository",
      source: "repository",
    }));
  identities.push(...configured);
  const global = (
    await git(path, ["config", "--global", "--get", "user.email"]).catch(() => "")
  ).trim();
  if (global)
    identities.push({
      email: normalizeIdentity(global),
      label: "settings.gitIdentityGlobal",
      source: "global",
    });
  const aliases = identityAliases(options.identity_emails ?? identities.map((item) => item.email));
  return {
    repository_group_id: fingerprint,
    path,
    fingerprint,
    changed: true,
    commits,
    identities: [...new Map(identities.map((item) => [item.email, item])).values()].filter((item) =>
      aliases.has(item.email),
    ),
  };
}
