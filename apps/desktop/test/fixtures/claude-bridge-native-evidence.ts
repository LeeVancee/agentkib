import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createNativeProbeDiagnostics } from "../../scripts/native-probe-diagnostics.mjs";

type EvidenceContext = {
  evidenceDirectory?: string;
  executable: string;
  root: string;
  plugin: string;
  repository: string;
  home: string;
  challenge: string;
};

/** Save diagnostics separately from the exact, private native type-source evidence. */
export function createClaudeBridgeNativeEvidence(context: EvidenceContext) {
  const binaryPaths = [context.executable];
  try {
    binaryPaths.push(realpathSync(context.executable));
  } catch {
    // A missing executable is reported by save(), with the requested path redacted.
  }
  const knownHashes = new Set<string>();
  const redact = (text: string, log: boolean) => {
    const ticketSafe = context.challenge
      ? text.replaceAll(context.challenge, "[PAIRING-TICKET]")
      : text;
    return log
      ? ticketSafe.replace(/[a-f0-9]{64}/gi, (hash) =>
          knownHashes.has(hash.toLowerCase()) ? hash : "[REDACTED]",
        )
      : ticketSafe;
  };
  const paths = {
    binaryPaths,
    binaryPlaceholder: "$CLAUDE_BINARY",
    repository: context.repository,
    evidenceDir: context.evidenceDirectory,
    root: context.root,
    home: context.home,
  };
  const diagnostics = createNativeProbeDiagnostics({
    ...paths,
    redactText: (text: string) => redact(text, false),
  });
  const logs = createNativeProbeDiagnostics({
    ...paths,
    redactText: (text: string) => redact(text, true),
  });
  return {
    error: (error: unknown) => logs.error(error),
    save({
      terminalText,
      summary,
      runningReload,
    }: {
      terminalText: string;
      summary: Record<string, unknown>;
      runningReload: Record<string, unknown>;
    }) {
      const { evidenceDirectory } = context;
      if (!evidenceDirectory) return;
      try {
        mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
        chmodSync(evidenceDirectory, 0o700);
        const save = (relative: string, content: string | Buffer) => {
          const destination = path.join(evidenceDirectory, relative);
          mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
        };
        const rawTypesDirectory = path.join(context.plugin, ".claude-plugin/types");
        const rawTypes: Array<{ path: string; content: Buffer; sha256: string }> = [];
        if (existsSync(rawTypesDirectory))
          for (const relative of readdirSync(rawTypesDirectory, { recursive: true })) {
            const source = path.join(rawTypesDirectory, String(relative));
            if (!lstatSync(source).isFile()) continue;
            const content = readFileSync(source);
            const hash = createHash("sha256").update(content).digest("hex");
            knownHashes.add(hash);
            rawTypes.push({
              path: `raw-types/${String(relative).split(path.sep).join("/")}`,
              content,
              sha256: hash,
            });
          }
        const executableSha256 = createHash("sha256")
          .update(readFileSync(context.executable))
          .digest("hex");
        knownHashes.add(executableSha256);
        const typesSha256 =
          rawTypes.find((entry) => entry.path === "raw-types/claude-code/index.d.ts")?.sha256 ??
          null;
        save("terminal.txt", logs.text(terminalText));
        const cliLog = path.join(context.root, "cli.log");
        if (existsSync(cliLog)) save("cli.log", logs.text(readFileSync(cliLog, "utf8")));
        // Raw declarations must keep their original bytes and hashes. They are
        // private source evidence, not logs to attach publicly without review.
        for (const entry of rawTypes) save(entry.path, entry.content);
        const typeManifest = rawTypes.map(({ path, content, sha256 }) => ({
          path,
          sha256,
          bytes: content.length,
        }));
        save("types-manifest.json", JSON.stringify(typeManifest, null, 2));
        save("running-reload.json", JSON.stringify(diagnostics.sanitize(runningReload), null, 2));
        save(
          "summary.json",
          JSON.stringify(
            diagnostics.sanitize({
              ...summary,
              executableSha256,
              typesSha256,
              typeManifest: "types-manifest.json",
              diagnosticPathsRedacted: true,
              privateSourceEvidence: ["raw-types/**"],
            }),
            null,
            2,
          ),
        );
      } catch (error) {
        throw logs.error(error);
      }
    },
  };
}
