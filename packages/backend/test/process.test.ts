import { test, expect } from "vitest";
import { runManaged } from "../src/index.js";
test("runs explicit argv without shell interpolation", async () => {
  const result = await runManaged({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    timeoutMs: 2000,
  });
  expect(result.stdout).toBe("ok");
  expect(result.code).toBe(0);
});
test("supports timeout and AbortSignal", async () => {
  await expect(
    runManaged({
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>{},5000)"],
      timeoutMs: 20,
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  const controller = new AbortController();
  const pending = runManaged({
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{},5000)"],
    signal: controller.signal,
    timeoutMs: 2000,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});
