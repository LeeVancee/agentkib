import { test, expect } from "vitest";
import { McpRuntimeHub } from "../src/index.js";
test("keeps runtime status bounded and validates server config", async () => {
  const hub = new McpRuntimeHub(10);
  expect(hub.status()).toEqual([]);
  await expect(
    hub.start({
      id: "bad",
      name: "Bad",
      enabled: true,
      allow_tools: [],
      lan_allow_tools: [],
      targets: [],
      transport: { transport: "streamable-http", url: "not-a-url", headers: {} },
    }),
  ).rejects.toThrow();
  await hub.shutdown();
});
