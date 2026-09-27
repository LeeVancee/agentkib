import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  version: string;
  deviceId: string;
  sessionId: string;
  createdAt: number;
  sent: boolean;
}
const FILE_LIMIT = 25 * 1024 * 1024;
const MESSAGE_LIMIT = 100 * 1024 * 1024;
const STORE_LIMIT = 2 * 1024 * 1024 * 1024;
export class AttachmentStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<Attachment[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let items: Attachment[];
    try {
      items = JSON.parse(await readFile(join(this.directory, "index.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      items = [];
    }
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !/^[a-f0-9-]{36}$/.test(item.id) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0 ||
          !/^[a-f0-9]{64}$/.test(item.version),
      )
    )
      throw new AttachmentError(503, "attachment_index_invalid");
    // Only this serialized store writes UUID files. A file missing from the atomic
    // manifest is an interrupted upload, never a native message reference.
    const retained = new Set(items.map((item) => item.id));
    for (const file of await readdir(this.directory)) {
      if (/^[a-f0-9-]{36}$/.test(file) && !retained.has(file))
        await rm(join(this.directory, file), { force: true });
    }
    return items;
  }

  private async save(items: Attachment[]) {
    const temporary = join(this.directory, "index.tmp");
    await writeFile(temporary, JSON.stringify(items), { mode: 0o600 });
    await rename(temporary, join(this.directory, "index.json"));
  }
  private async prune(items: Attachment[]) {
    const stale = items.filter((item) => !item.sent && Date.now() - item.createdAt >= 86_400_000);
    const next = items.filter((item) => !stale.includes(item));
    if (stale.length) {
      await this.save(next);
      for (const item of stale) await rm(join(this.directory, item.id), { force: true });
    }
    return next;
  }
  static public(item: Attachment) {
    const { id, name, mime, size, version, sent, createdAt } = item;
    return { id, name, mime, size, version, sent, createdAt };
  }
  upload(
    source: AsyncIterable<Uint8Array>,
    owner: { deviceId: string; sessionId: string },
    name: string,
    mime: string,
    check: () => void,
  ) {
    return this.serialize(async () => {
      if (!name || name.length > 255 || /[\x00-\x1f\\/]/.test(name) || [".", ".."].includes(name))
        throw new AttachmentError(400, "invalid_attachment_name");
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime))
        throw new AttachmentError(400, "invalid_attachment_type");
      const items = await this.prune(await this.load());
      const used = items.reduce((sum, item) => sum + item.size, 0);
      const id = randomUUID();
      const path = join(this.directory, id);
      const handle = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of source) {
          check();
          size += chunk.byteLength;
          if (size > FILE_LIMIT) throw new AttachmentError(413, "attachment_too_large");
          if (used + size > STORE_LIMIT) throw new AttachmentError(507, "attachment_storage_full");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        check();
        if (!size) throw new AttachmentError(400, "attachment_empty");
        await handle.sync();
        await handle.close();
        const item: Attachment = {
          id,
          name,
          mime,
          size,
          version: hash.digest("hex"),
          ...owner,
          createdAt: Date.now(),
          sent: false,
        };
        await this.save([...items, item]);
        return AttachmentStore.public(item);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true });
        throw error;
      }
    });
  }
  list(deviceId: string, sessionId: string) {
    return this.serialize(async () =>
      (await this.prune(await this.load()))
        .filter((item) => item.deviceId === deviceId && item.sessionId === sessionId)
        .map(AttachmentStore.public),
    );
  }
  remove(deviceId: string, sessionId: string, id: string, version: string) {
    return this.serialize(async () => {
      const items = await this.load();
      const item = items.find(
        (item) =>
          item.id === id &&
          item.deviceId === deviceId &&
          item.sessionId === sessionId &&
          item.version === version,
      );
      if (!item) throw new AttachmentError(404, "attachment_not_found");
      await this.save(items.filter((candidate) => candidate !== item));
      await rm(join(this.directory, item.id), { force: true });
    });
  }
  /** Mark before dispatch: unknown execution outcomes retain referenced files. */
  input(deviceId: string, sessionId: string, ids: unknown, text: string) {
    return this.serialize(async () => {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 10 ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw new AttachmentError(400, "invalid_attachments");
      const items = await this.prune(await this.load());
      const selected = ids.map((id) =>
        items.find(
          (item) => item.id === id && item.deviceId === deviceId && item.sessionId === sessionId,
        ),
      );
      if (selected.some((item) => !item)) throw new AttachmentError(404, "attachment_not_found");
      const files = selected as Attachment[];
      if (files.reduce((sum, item) => sum + item.size, 0) > MESSAGE_LIMIT)
        throw new AttachmentError(413, "attachments_too_large");
      const input: Record<string, unknown>[] = text.trim()
        ? [{ type: "text", text, text_elements: [] }]
        : [];
      for (const item of files) {
        const path = join(this.directory, item.id);
        const info = await lstat(path);
        if (!info.isFile() || info.size !== item.size)
          throw new AttachmentError(409, "attachment_changed");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        if (hash.digest("hex") !== item.version)
          throw new AttachmentError(409, "attachment_changed");
        const canonicalPath = await realpath(path);
        if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime))
          input.push({ type: "localImage", path: canonicalPath });
        else
          input.push({
            type: "text",
            text: `User attached file ${JSON.stringify(item.name)}: ${canonicalPath}`,
            text_elements: [],
          });
      }
      await this.save(items.map((item) => (files.includes(item) ? { ...item, sent: true } : item)));
      return input;
    });
  }
}
