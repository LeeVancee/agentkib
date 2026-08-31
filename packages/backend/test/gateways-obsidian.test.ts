import { test, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspaceLink,
  listGateways,
  planObsidianOpen,
  saveGatewayConfig,
} from "../src/index.js";
test("persists gateway config with masked listing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-gateway-"));
  const file = path.join(root, "gateways.json");
  await saveGatewayConfig(file, {
    schema_version: 1,
    gateways: [
      { id: "g", name: "Gateway", base_url: "https://example.com", enabled: true, token: "secret" },
    ],
  });
  expect((await listGateways(file))[0]?.token).toBe("[REDACTED]");
});
test("validates Obsidian vault links and action plans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-obsidian-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const link = await createWorkspaceLink(
    root,
    { path: vault, name: "Vault", source: "manual" },
    "w",
    "notes/project.md",
  );
  expect(link.relative_path).toBe("notes/project.md");
  expect(
    planObsidianOpen({ path: vault, name: "Vault", source: "manual" }, "notes/a.md").action,
  ).toBe("open-file");
  expect(() =>
    planObsidianOpen({ path: vault, name: "Vault", source: "manual" }, "../escape"),
  ).toThrow();
});
