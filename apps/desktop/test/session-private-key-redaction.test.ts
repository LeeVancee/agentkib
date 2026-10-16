import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeSessionText } from "../../../packages/backend/src/session-handoff";
import { contextFixture } from "./fixtures/claude-context";

describe("private key redaction", () => {
  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("removes %s blocks and preserves following text", (label) => {
    for (const newline of ["\n", "\r\n"]) {
      const redactions = { value: 0 };
      const result = sanitizeSessionText(
        [
          "before",
          `-----BEGIN ${label}-----`,
          "SYNTHETIC-PRIVATE-BODY",
          `-----END ${label}-----`,
          "after",
        ].join(newline),
        redactions,
      );
      expect(result.replaceAll("\r", "")).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
      expect(redactions.value).toBe(1);
    }
  });

  it("hides a truncated PKCS8 block through the end of the input", () => {
    const result = sanitizeSessionText(
      "before\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-PRIVATE-BODY\ntruncated tail",
      { value: 0 },
    );
    expect(result).toBe("before\n[REDACTED PRIVATE KEY]");
  });

  it("preserves public keys and ordinary text surrounding two private keys", () => {
    const publicKey = "-----BEGIN PUBLIC KEY-----\nSYNTHETIC-PUBLIC-BODY\n-----END PUBLIC KEY-----";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-PRIVATE-BODY\n-----END PRIVATE KEY-----";
    const redactions = { value: 0 };
    expect(
      sanitizeSessionText(`${publicKey}\n${privateKey}\nbetween\n${privateKey}\nafter`, redactions),
    ).toBe(`${publicKey}\n[REDACTED PRIVATE KEY]\nbetween\n[REDACTED PRIVATE KEY]\nafter`);
    expect(redactions.value).toBe(2);
  });
});

describe("private keys in external Claude context", () => {
  it.each(["import", "user instructions", "memory"] as const)(
    "redacts generated PKCS8 material from %s before returning owner context",
    async (source) => {
      const f = contextFixture();
      try {
        const { privateKey } = generateKeyPairSync("ed25519", {
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
        const content = `EXTERNAL-NOTES\n${privateKey}\nafter the key\n`;
        f.write("CLAUDE.md", "Workspace instructions\n");
        if (source === "import") {
          f.write(f.outside("shared", "ops.md"), content);
          f.write("CLAUDE.md", "@../shared/ops.md\n");
        } else if (source === "user instructions") f.user("CLAUDE.md", content);
        else f.memory(content);

        const owner = await f.request();
        const output = JSON.stringify(owner);
        // Never include the disposable key in assertion failure output.
        expect(output.includes(privateKey.split("\n")[1]!)).toBe(false);
        expect(output).toContain("[REDACTED PRIVATE KEY]");
        expect(output).toContain("after the key");

        for (const result of [
          await f.mcp(),
          await f.resolve(f.project, { includeOutsideSources: false }),
        ]) {
          const serialized = JSON.stringify(result);
          expect(serialized.includes(privateKey.split("\n")[1]!)).toBe(false);
          expect(serialized).not.toContain("EXTERNAL-NOTES");
        }
      } finally {
        f.dispose();
      }
    },
  );
});
