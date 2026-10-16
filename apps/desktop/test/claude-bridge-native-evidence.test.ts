// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeBridgeNativeEvidence } from "./fixtures/claude-bridge-native-evidence";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse())
    rmSync(directory, { recursive: true, force: true });
});

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function snapshot(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error
      ? Object.fromEntries(
          Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)]),
        )
      : item,
  );
}

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-native-evidence-")));
  temporaryDirectories.push(base);
  const root = path.join(base, "isolated-run");
  const repository = path.join(base, "work tree");
  const home = path.join(base, "synthetic home");
  const evidenceDirectory = path.join(base, "saved evidence");
  const plugin = path.join(root, "plugin");
  const executable = path.join(base, "custom-bin", "claude");
  // Windows file symlinks require privileges that ordinary test runners lack.
  const realExecutable =
    process.platform === "win32" ? executable : path.join(base, "native bins", "claude-real");
  for (const directory of [
    root,
    repository,
    home,
    path.dirname(executable),
    path.dirname(realExecutable),
  ])
    mkdirSync(directory, { recursive: true });
  const executableBytes = Buffer.from([0, 1, 255, 13, 10, 65, 75, 0, 127]);
  writeFileSync(realExecutable, executableBytes);
  if (process.platform !== "win32") symlinkSync(realExecutable, executable);

  const challenge = Buffer.from(`synthetic-pairing-ticket-${randomUUID()}`).toString("base64url");
  const logSecret = sha256(`synthetic-log-secret-${randomUUID()}`);
  const metadataSha256 = sha256(`synthetic-metadata-${randomUUID()}`);
  const nativeId = randomUUID();
  const marker = `synthetic-visible-content-${randomUUID()}`;
  const types = [
    {
      path: "claude-code/index.d.ts",
      content: Buffer.from(
        `\ufeff// Native source: ${root}/source.ts\r\nexport type Synthetic = "原始字节";\r\n`,
      ),
    },
    {
      path: "nested/helper.d.ts",
      content: Buffer.from(`// Home: ${home}\nexport declare const helper: unique symbol;\n`),
    },
  ];
  for (const entry of types) {
    const destination = path.join(plugin, ".claude-plugin/types", entry.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content);
  }
  const executableSha256 = sha256(executableBytes);
  const typesSha256 = sha256(types[0].content);
  const helperSha256 = sha256(types[1].content);
  const terminalText = [
    `requested=${executable}`,
    `resolved=${realExecutable}`,
    `requested-directory=${path.dirname(executable)}`,
    `resolved-directory=${path.dirname(realExecutable)}`,
    `workspace=${repository}`,
    `evidence=${evidenceDirectory}`,
    `root=${root}`,
    `home=${home}`,
    `binary-uri=${pathToFileURL(realExecutable).href}`,
    `ticket=${challenge}`,
    `known-hashes=${executableSha256} ${typesSha256} ${helperSha256} ${executableSha256.toUpperCase()}`,
    `unknown-secrets=${logSecret} ${logSecret.toUpperCase()}`,
  ].join("\n");
  const cliLog = `${terminalText}\nread ${path.join(root, "cli.log")}\n`;
  writeFileSync(path.join(root, "cli.log"), cliLog);

  const causePath = path.join(home, "synthetic-settings.json");
  const cause = Object.assign(new Error(`Cannot read ${causePath}; ${challenge}; ${logSecret}`), {
    code: "ENOENT",
    path: causePath,
    errno: -2,
    syscall: "open",
  });
  cause.stack = `Error: ${cause.message}\n    at ${path.join(repository, "entry.ts")}:2:3`;
  const error = Object.assign(
    new Error(`Cannot run ${executable}; ${challenge}; ${metadataSha256}`, { cause }),
    { code: "EACCES", path: executable, errno: -13, syscall: "spawn" },
  );
  error.stack = `Error: ${error.message}\n    at ${realExecutable}:4:5`;
  const paths = {
    requested: executable,
    resolved: realExecutable,
    installDirectories: [path.dirname(executable), path.dirname(realExecutable)],
    binaryUri: pathToFileURL(realExecutable).href,
    repository,
    root,
    home,
    evidenceDirectory,
  };
  const summary = {
    executableSha256: "untrusted-input-executable-hash",
    typesSha256: "untrusted-input-types-hash",
    metadataSha256,
    nativeId,
    marker,
    challenge,
    nested: { paths, error, entries: [{ path: root, sha256: metadataSha256 }] },
    [path.join(repository, "synthetic-key")]: marker,
  };
  const runningReload = {
    nativeId,
    marker,
    metadataSha256,
    challenge,
    events: [{ paths, error }],
  };
  const context = { evidenceDirectory, executable, root, plugin, repository, home, challenge };
  return {
    ...context,
    realExecutable,
    executableBytes,
    executableSha256,
    typesSha256,
    helperSha256,
    types,
    terminalText,
    cliLog,
    logSecret,
    metadataSha256,
    nativeId,
    marker,
    error,
    summary,
    runningReload,
    evidence: createClaudeBridgeNativeEvidence(context),
  };
}

function expectPathsRedacted(text: string, f: ReturnType<typeof fixture>) {
  for (const original of [
    f.executable,
    f.realExecutable,
    path.dirname(f.executable),
    path.dirname(f.realExecutable),
    f.repository,
    f.root,
    f.home,
    f.evidenceDirectory,
    pathToFileURL(f.realExecutable).href,
  ]) {
    expect(text).not.toContain(original);
    expect(text).not.toContain(JSON.stringify(original).slice(1, -1));
  }
  expect(text).not.toContain(f.challenge);
}

describe("isolated native bridge evidence persistence", () => {
  it("saves exact private type bytes while redacting diagnostic paths, tickets and log secrets", () => {
    const f = fixture();
    const inputsBefore = snapshot({ summary: f.summary, runningReload: f.runningReload });
    f.evidence.save(f);

    const read = (relative: string) =>
      readFileSync(path.join(f.evidenceDirectory, relative), "utf8");
    const terminal = read("terminal.txt");
    const cliLog = read("cli.log");
    for (const diagnostic of [terminal, cliLog]) {
      expectPathsRedacted(diagnostic, f);
      for (const placeholder of [
        "$CLAUDE_BINARY",
        "$CLAUDE_INSTALL_DIR",
        "$WORKTREE",
        "$EVIDENCE_DIR",
        "$ISOLATED_ROOT",
        "$HOME",
        "[PAIRING-TICKET]",
        "[REDACTED]",
      ])
        expect(diagnostic).toContain(placeholder);
      expect(diagnostic).not.toContain(f.logSecret);
      expect(diagnostic).not.toContain(f.logSecret.toUpperCase());
      for (const hash of [
        f.executableSha256,
        f.typesSha256,
        f.helperSha256,
        f.executableSha256.toUpperCase(),
      ])
        expect(diagnostic).toContain(hash);
    }

    const summaryText = read("summary.json");
    const reloadText = read("running-reload.json");
    for (const diagnostic of [summaryText, reloadText]) {
      expectPathsRedacted(diagnostic, f);
      expect(diagnostic).toContain(f.metadataSha256);
      expect(diagnostic).toContain(f.nativeId);
      expect(diagnostic).toContain(f.marker);
      // Structured metadata preserves hashes even when they are not file hashes.
      expect(diagnostic).toContain(f.logSecret);
    }
    const safeError = {
      code: "EACCES",
      path: "$CLAUDE_BINARY",
      errno: -13,
      syscall: "spawn",
      cause: {
        code: "ENOENT",
        path: path.join("$HOME", "synthetic-settings.json"),
        errno: -2,
        syscall: "open",
      },
    };
    const summary = JSON.parse(summaryText);
    const runningReload = JSON.parse(reloadText);
    expect(summary).toMatchObject({
      executableSha256: f.executableSha256,
      typesSha256: f.typesSha256,
      metadataSha256: f.metadataSha256,
      nativeId: f.nativeId,
      marker: f.marker,
      typeManifest: "types-manifest.json",
      diagnosticPathsRedacted: true,
      privateSourceEvidence: ["raw-types/**"],
      nested: {
        paths: { installDirectories: ["$CLAUDE_INSTALL_DIR", "$CLAUDE_INSTALL_DIR"] },
        error: safeError,
        entries: [{ path: "$ISOLATED_ROOT", sha256: f.metadataSha256 }],
      },
      [path.join("$WORKTREE", "synthetic-key")]: f.marker,
    });
    expect(runningReload).toMatchObject({
      nativeId: f.nativeId,
      marker: f.marker,
      metadataSha256: f.metadataSha256,
      events: [
        {
          paths: { installDirectories: ["$CLAUDE_INSTALL_DIR", "$CLAUDE_INSTALL_DIR"] },
          error: safeError,
        },
      ],
    });

    const manifest = JSON.parse(read("types-manifest.json"));
    expect(manifest).toHaveLength(f.types.length);
    for (const entry of f.types) {
      const relative = `raw-types/${entry.path}`;
      const saved = readFileSync(path.join(f.evidenceDirectory, relative));
      expect(saved.equals(entry.content)).toBe(true);
      expect(manifest).toContainEqual({
        path: relative,
        sha256: sha256(entry.content),
        bytes: entry.content.length,
      });
    }
    expect(readFileSync(f.executable).equals(f.executableBytes)).toBe(true);
    expect(readFileSync(path.join(f.root, "cli.log"), "utf8")).toBe(f.cliLog);
    expect(snapshot({ summary: f.summary, runningReload: f.runningReload })).toBe(inputsBefore);
    if (process.platform !== "win32") {
      expect(statSync(f.evidenceDirectory).mode & 0o777).toBe(0o700);
      for (const relative of ["terminal.txt", "summary.json", "raw-types/claude-code/index.d.ts"])
        expect(statSync(path.join(f.evidenceDirectory, relative)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["terminal.txt", "raw-types/claude-code/index.d.ts", "summary.json"])(
    "preserves existing %s and reports EEXIST without exposing source paths",
    (relative) => {
      const f = fixture();
      const existing = path.join(f.evidenceDirectory, relative);
      mkdirSync(path.dirname(existing), { recursive: true });
      writeFileSync(existing, "existing synthetic evidence", { flag: "wx" });
      let failure: unknown;
      try {
        f.evidence.save(f);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        code: "EEXIST",
        path: path.join("$EVIDENCE_DIR", relative),
        syscall: "open",
      });
      expectPathsRedacted(snapshot(failure), f);
      expect(readFileSync(existing, "utf8")).toBe("existing synthetic evidence");
    },
  );

  it("retains error codes and causes while redacting messages, stacks and path properties", () => {
    const f = fixture();
    const original = Object.assign(
      new AggregateError([f.error], `Failed ${f.executable}; ${f.challenge}; ${f.logSecret}`, {
        cause: f.error,
      }),
      { code: "EPROBE", path: f.evidenceDirectory },
    );
    original.stack = `AggregateError: ${original.message}\n    at ${f.realExecutable}:6:7`;
    const originalBefore = snapshot(original);
    const safe = f.evidence.error(original);

    expect(safe).toBeInstanceOf(AggregateError);
    expect(safe).not.toBe(original);
    expect(safe).toMatchObject({
      code: "EPROBE",
      path: "$EVIDENCE_DIR",
      cause: {
        code: "EACCES",
        path: "$CLAUDE_BINARY",
        cause: { code: "ENOENT", path: path.join("$HOME", "synthetic-settings.json") },
      },
      errors: [{ code: "EACCES", path: "$CLAUDE_BINARY" }],
    });
    const safeText = snapshot(safe);
    expectPathsRedacted(safeText, f);
    expect(safeText).toContain("[PAIRING-TICKET]");
    expect(safeText).toContain("[REDACTED]");
    expect(safeText).not.toContain(f.logSecret);
    expect(snapshot(original)).toBe(originalBefore);
    expect(existsSync(f.evidenceDirectory)).toBe(false);
  });
});
