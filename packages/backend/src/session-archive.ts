import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import { archiveChunk, archiveManifest, sessionDocument } from "./session-model";
import type { SessionDocument } from "./session-model";

const maxArchiveBytes = 256 * 1024 * 1024;
const maxChunkBytes = 64 * 1024;
const fragmentBytes = 8 * 1024;

export interface SessionArchiveBundle {
  manifest: {
    schema_version: number;
    archive_id: string;
    workspace_id: string;
    source_fingerprint: string;
    document_sha256: string;
    chunks_sha256: string;
    chunk_count: number;
    created_at: string;
  };
  manifest_content: string;
  document_content: string;
  chunks_content: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readSafeFile(file: string, maximum: number): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
    throw new Error("Session archive contains an invalid file");
  if (metadata.size > maximum) throw new Error("Session archive file exceeds its read limit");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maximum)
      throw new Error("Session archive file exceeds its read limit");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function validateSessionArchive(
  dataDir: string,
  workspaceId: string,
  archiveId: string,
): SessionArchiveBundle["manifest"] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(archiveId))
    throw new Error("Archive ID must be a UUID");
  const directory = path.join(
    dataDir,
    "continuations",
    sha256(workspaceId).slice(0, 32),
    archiveId,
  );
  const ancestors: string[] = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    ancestors.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const ancestor of ancestors) {
    const metadata = lstatSync(ancestor);
    if (!metadata.isDirectory() || isReparseOrSymlink(ancestor, metadata))
      throw new Error("Session archive contains an invalid directory");
  }
  const manifestBytes = readSafeFile(path.join(directory, "manifest.json"), maxChunkBytes);
  const documentBytes = readSafeFile(path.join(directory, "document.json"), maxArchiveBytes);
  const chunksBytes = readSafeFile(path.join(directory, "chunks.jsonl"), maxArchiveBytes);
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const manifest = archiveManifest.parse(JSON.parse(decode(manifestBytes)));
  const documentContent = decode(documentBytes);
  const chunksContent = decode(chunksBytes);
  if (manifest.archive_id !== archiveId || manifest.workspace_id !== workspaceId)
    throw new Error("Session archive scope does not match the request");
  if (sha256(documentContent) !== manifest.document_sha256)
    throw new Error("Session archive document hash does not match");
  if (sha256(chunksContent) !== manifest.chunks_sha256)
    throw new Error("Session archive chunks hash does not match");
  if (sessionDocument.parse(JSON.parse(documentContent)).source.workspace_id !== workspaceId)
    throw new Error("Session archive document belongs to another workspace");
  const chunks = chunksContent.split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of chunks.entries()) {
    if (Buffer.byteLength(line) > maxChunkBytes)
      throw new Error(`Session archive chunk ${index + 1} exceeds the 64 KiB limit`);
    archiveChunk.parse(JSON.parse(line));
  }
  if (chunks.length !== manifest.chunk_count)
    throw new Error("Session archive chunk count does not match its manifest");
  return manifest;
}

function splitUtf8(value: string): string[] {
  if (!value) return [""];
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > fragmentBytes && current) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) parts.push(current);
  return parts;
}

function blockPayload(block: SessionDocument["turns"][number]["blocks"][number]): [string, string] {
  switch (block.type) {
    case "text":
      return ["text", block.text];
    case "tool-call":
      return [
        "tool-call",
        JSON.stringify({ call_id: block.call_id, name: block.name, input: block.input }),
      ];
    case "tool-result":
      return [
        "tool-result",
        JSON.stringify({ call_id: block.call_id, output: block.output, is_error: block.is_error }),
      ];
    case "attachment":
      return [
        "attachment",
        JSON.stringify({
          kind: block.kind,
          media_type: block.media_type,
          filename: block.filename ?? null,
          inline_base64: block.inline_base64 ?? null,
        }),
      ];
  }
}

export function buildSessionArchive(
  document: SessionDocument,
  workspaceId: string,
  archiveId: string,
  sourceFingerprint: string,
  createdAt = new Date().toISOString(),
): SessionArchiveBundle {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(archiveId))
    throw new Error("Archive ID must be a UUID");
  if (document.source.workspace_id !== workspaceId)
    throw new Error("Archive workspace does not match the session document");
  const documentContent = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(documentContent) > maxArchiveBytes)
    throw new Error("Session archive document content exceeds the 256 MiB limit");
  const chunks: Record<string, unknown>[] = [];
  let blockNumber = 0;
  for (const turn of document.turns) {
    for (const block of turn.blocks) {
      blockNumber++;
      const [blockType, content] = blockPayload(block);
      const fragments = splitUtf8(content);
      fragments.forEach((fragment, index) => {
        chunks.push({
          chunk_id: `chunk-${String(chunks.length + 1).padStart(6, "0")}`,
          block_id: `block-${String(blockNumber).padStart(6, "0")}`,
          turn_id: turn.id,
          role: turn.role,
          timestamp: turn.timestamp,
          block_type: blockType,
          part: index + 1,
          parts: fragments.length,
          content: fragment,
        });
      });
    }
  }
  const chunksContent = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join("");
  if (Buffer.byteLength(chunksContent) > maxArchiveBytes)
    throw new Error("Session archive chunks content exceeds the 256 MiB limit");
  for (const chunk of chunks)
    if (Buffer.byteLength(JSON.stringify(chunk)) > maxChunkBytes)
      throw new Error("Session archive chunk exceeds the 64 KiB limit");
  const manifest = {
    schema_version: document.schema_version,
    archive_id: archiveId,
    workspace_id: workspaceId,
    source_fingerprint: sourceFingerprint,
    document_sha256: sha256(documentContent),
    chunks_sha256: sha256(chunksContent),
    chunk_count: chunks.length,
    created_at: createdAt,
  };
  return {
    manifest,
    manifest_content: `${JSON.stringify(manifest, null, 2)}\n`,
    document_content: documentContent,
    chunks_content: chunksContent,
  };
}
