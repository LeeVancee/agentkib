import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { archiveFor, verifyArchive } from "./stage-frpc.mjs";
test("packaging rejects unsupported targets and corrupted archives", () => {
  assert.equal(archiveFor("win32", "x64").filename, "frp_0.68.0_windows_amd64.zip");
  assert.equal(archiveFor("darwin", "arm64").hash.length, 64);
  assert.throws(() => archiveFor("darwin", "ia32"), /Unsupported/);
  const data = Buffer.from("verified archive");
  const hash = createHash("sha256").update(data).digest("hex");
  verifyArchive(data, hash);
  assert.throws(() => verifyArchive(Buffer.from("tampered archive"), hash), /checksum mismatch/);
});
