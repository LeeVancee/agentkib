import { test, expect } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendWorkerClient, BackendWorkerHost, createBackendRuntime } from "../src/index.js";
test("composes runtime registry behind worker public interface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-runtime-"));
  await mkdir(path.join(root, ".agentkib"));
  await writeFile(
    path.join(root, ".agentkib/manifest.yaml"),
    "schema_version: 2\nworkspace:\n  id: p\n  name: Demo\nmcp:\n  config: mcp.json\n",
  );
  const runtime = createBackendRuntime({
    database_path: path.join(root, "db.sqlite"),
    scan_roots: [],
  });
  const channel = new MessageChannel();
  new BackendWorkerHost(channel.port1, runtime.registry).start();
  const client = new BackendWorkerClient(channel.port2);
  await expect(client.request("workspaces.list")).resolves.toEqual([]);
  await expect(
    client.request("memories.propose", {
      project: root,
      proposal: { memory_type: "decision", content: "use sqlite" },
    }),
  ).resolves.toMatchObject({ status: "pending" });
  await expect(
    client.request("memories.propose", {
      project: root,
      proposal: { memory_type: "decision", content: "" },
    }),
  ).rejects.toMatchObject({ code: "VALIDATION" });
  await client.shutdown();
  runtime.close();
});
