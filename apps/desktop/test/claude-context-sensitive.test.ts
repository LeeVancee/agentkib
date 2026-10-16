import { describe, expect, it } from "vitest";
import { isSensitiveExternalPath } from "../../../packages/backend/src/context-claude";

// The check runs on both the path as written in the import and its resolved real path, and
// compares in lower case, because macOS and Windows file systems ignore case by default.
describe("isSensitiveExternalPath", () => {
  it.each([
    "/home/a/.ssh/id_ed25519",
    "/home/a/.aws/config",
    "/home/a/.gnupg/trustdb.gpg",
    "/home/a/.kube/config",
    "/home/a/.docker/config.json",
    "/home/a/.azure/azureProfile.json",
    "/home/a/.config/gh/hosts.yml",
    "/home/a/.config/gcloud/application_default_credentials.json",
    "/home/a/.claude.json",
    "/home/a/.npmrc",
    "/home/a/.netrc",
    "/home/a/.pypirc",
    "/home/a/app/.env",
    "/home/a/notes/credentials",
    "/home/a/notes/api-token.txt",
    "/home/a/notes/Secrets.md",
    "/home/a/certs/server.pem",
    "/home/a/certs/server.key",
  ])("flags %s", (value) => {
    expect(isSensitiveExternalPath(value, value)).toBe(true);
  });

  it.each([
    "/home/a/.SSH/id_ed25519",
    "/home/a/.AWS/config",
    "/home/a/.NPMRC",
    "/home/a/.Claude.json",
    "/home/a/.Config/GH/hosts.yml",
    "C:\\Users\\A\\.Aws\\credentials",
    "C:\\Users\\A\\.ssh\\config",
    "C:\\Users\\A\\AppData\\Roaming\\.config\\gcloud\\x.json",
  ])("flags %s regardless of case or separator", (value) => {
    expect(isSensitiveExternalPath(value, value)).toBe(true);
  });

  it.each([
    "/home/a/notes/readme.md",
    "/home/a/.claude/CLAUDE.md",
    "/home/a/.config/other/settings.json",
    "/home/a/.config/x/gh/hosts.yml",
    "/home/a/.config/ghx/hosts.yml",
    "/home/a/.sshd/config",
    "/home/a/ssh/config",
    "/home/a/.claude.json.example",
    "/home/a/project/docs/guide.md",
    "C:\\Users\\A\\Documents\\notes.md",
  ])("does not flag %s", (value) => {
    expect(isSensitiveExternalPath(value, value)).toBe(false);
  });

  it("flags the import when only the real path is sensitive", () => {
    expect(isSensitiveExternalPath("/work/docs/guide.md", "/home/a/.aws/credentials")).toBe(true);
    expect(isSensitiveExternalPath("/work/docs/guide.md", "/home/a/.ssh/config")).toBe(true);
  });

  it("flags the import when only the written path is sensitive", () => {
    expect(isSensitiveExternalPath("/home/a/.npmrc", "/srv/shared/config.txt")).toBe(true);
  });

  it("does not flag an import whose both paths are harmless", () => {
    expect(isSensitiveExternalPath("/work/docs/guide.md", "/srv/shared/guide.md")).toBe(false);
  });
});
