#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function readMetadata(path) {
  const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  const releaseDate = text.match(/^releaseDate:\s*(.+)$/m)?.[1]?.trim();
  const files = [...text.matchAll(/^\s+- url: (.+)\n\s+sha512: (.+)\n\s+size: (\d+)$/gm)].map(
    ([, url, sha512, size]) => ({ url, sha512, size }),
  );

  if (!version || !releaseDate || files.length === 0) {
    throw new Error(`Invalid Electron updater metadata: ${path}`);
  }
  return { version, releaseDate, files };
}

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  throw new Error("Usage: merge-electron-updater-metadata.mjs <output> <input...>");
}

const metadata = inputs.map(readMetadata);
const first = metadata[0];
if (metadata.some((entry) => entry.version !== first.version)) {
  throw new Error("Electron updater metadata versions do not match");
}

const files = metadata.flatMap((entry) => entry.files);
const uniqueFiles = new Map(files.map((file) => [file.url, file]));
const lines = [
  `version: ${first.version}`,
  "files:",
  ...[...uniqueFiles.values()].flatMap((file) => [
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
  ]),
  `releaseDate: ${first.releaseDate}`,
  "",
];
writeFileSync(output, lines.join("\n"));
