// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentStore } from "./attachments";

describe("private attachment input storage", () => {
  let dir: string;
  let store: AttachmentStore;
  const owner = { deviceId: "phone", sessionId: "task" };
  const bytes = async function* (value = "hello") {
    yield Buffer.from(value);
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-attachments-"));
    store = new AttachmentStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("streams upload, binds ownership, retains sent references across restart, and explicitly deletes", async () => {
    const uploaded = await store.upload(bytes(), owner, "notes.txt", "text/plain", () => {});
    expect(uploaded).not.toHaveProperty("path");
    await expect(store.input("other", "task", [uploaded.id], "")).rejects.toThrow(
      "attachment_not_found",
    );
    await expect(store.input("phone", "other-task", [uploaded.id], "")).rejects.toThrow(
      "attachment_not_found",
    );
    const input = await store.input("phone", "task", [uploaded.id], "Read this");
    expect(input).toEqual([
      { type: "text", text: "Read this", text_elements: [] },
      { type: "text", text: expect.stringContaining(uploaded.id), text_elements: [] },
    ]);
    store = new AttachmentStore(dir);
    expect((await store.list("phone", "task"))[0].sent).toBe(true);
    await expect(store.remove("phone", "task", uploaded.id, "wrong-version")).rejects.toThrow(
      "attachment_not_found",
    );
    await store.remove("phone", "task", uploaded.id, uploaded.version);
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("fails on revocation during transfer and removes partial data", async () => {
    await expect(
      store.upload(bytes(), owner, "n.txt", "text/plain", () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("rejects filenames with path traversal and more than ten inputs", async () => {
    await expect(store.upload(bytes(), owner, "../secret", "text/plain", () => {})).rejects.toThrow(
      "invalid_attachment_name",
    );
    await expect(
      store.input(
        "phone",
        "task",
        Array.from({ length: 11 }, (_, i) => String(i)),
        "",
      ),
    ).rejects.toThrow("invalid_attachments");
  });
  it("rejects changed content and symlink substitutions", async () => {
    const item = await store.upload(bytes(), owner, "n.txt", "text/plain", () => {});
    await writeFile(join(dir, item.id), "other");
    await expect(store.input("phone", "task", [item.id], "")).rejects.toThrow("attachment_changed");
    await unlink(join(dir, item.id));
    await writeFile(join(dir, "outside"), "hello");
    await symlink(join(dir, "outside"), join(dir, item.id));
    await expect(store.input("phone", "task", [item.id], "")).rejects.toThrow("attachment_changed");
  });
  it("removes stale drafts while retaining sent uploads", async () => {
    const a = await store.upload(bytes(), owner, "a.txt", "text/plain", () => {});
    const b = await store.upload(bytes(), owner, "b.txt", "text/plain", () => {});
    await store.input("phone", "task", [b.id], "");
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(index.map((i: object) => ({ ...i, createdAt: 0 }))),
    );
    expect((await store.list("phone", "task")).map((i) => i.id)).toEqual([b.id]);
    await expect(readFile(join(dir, a.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects oversized streaming upload without buffering it", async () => {
    async function* large() {
      for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024);
    }
    await expect(
      store.upload(large(), owner, "large.bin", "application/octet-stream", () => {}),
    ).rejects.toThrow("attachment_too_large");
    expect(await store.list("phone", "task")).toEqual([]);
  });
  it("accounts for the host quota and removes interrupted unreferenced files", async () => {
    const item = await store.upload(bytes(), owner, "a.txt", "text/plain", () => {});
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(
        index.map((i: object) => ({ ...i, size: 2 * 1024 * 1024 * 1024, sent: true })),
      ),
    );
    const orphan = "12345678-1234-1234-1234-123456789012";
    await writeFile(join(dir, orphan), "partial");
    await expect(store.upload(bytes(), owner, "b.txt", "text/plain", () => {})).rejects.toThrow(
      "attachment_storage_full",
    );
    await expect(readFile(join(dir, orphan))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list("phone", "task"))[0].id).toBe(item.id);
  });
});
