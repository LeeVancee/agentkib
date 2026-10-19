import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeResumeCommand } from "../../../packages/backend/src/claude-resume-command";

const nativeId = "00000000-0000-4000-8000-000000000001";

describe("Claude host resume commands", () => {
  it.skipIf(process.platform === "win32")("quotes paths literally in a POSIX shell", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-command-")));
    try {
      const cwd = path.join(root, "project ' $(printf injected)");
      const config = path.join(root, "config ' `printf injected`");
      const bin = path.join(root, "bin");
      for (const dir of [cwd, config, bin]) mkdirSync(dir);
      writeFileSync(
        path.join(bin, "claude"),
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR,args:process.argv.slice(2)}));`,
        { mode: 0o700 },
      );
      const result = claudeResumeCommand(cwd, config, nativeId, "linux");
      const actual = JSON.parse(
        execFileSync("/bin/sh", ["-c", result.command], {
          env: { PATH: bin },
          encoding: "utf8",
        }),
      );
      expect(actual).toEqual({ cwd, config, args: ["--resume", nativeId] });
      expect(result).toMatchObject({ available: true, shell: "posix", runOn: "host" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses literal PowerShell paths and preserves the configured Claude directory", () => {
    expect(
      claudeResumeCommand("C:\\Project's files", "C:\\Claude's config", nativeId, "win32"),
    ).toEqual({
      available: true,
      shell: "powershell",
      runOn: "host",
      command: `try { Set-Location -LiteralPath 'C:\\Project''s files' -ErrorAction Stop; $env:CLAUDE_CONFIG_DIR = 'C:\\Claude''s config'; & claude --resume '${nativeId}' } catch { Write-Error $_ }`,
    });
  });

  it.each(["--resume other", "'quoted'", "$(touch file)", ""])(
    "rejects an unverified native ID (%j)",
    (id) => {
      expect(() => claudeResumeCommand("/project", "/config", id)).toThrow(
        "unverified-session-identity",
      );
    },
  );
});
