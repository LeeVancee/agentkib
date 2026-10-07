import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// Read an online backup through the production Store, never start scanners or an MCP listener.
assert.equal(process.platform, "darwin", "This probe uses the macOS filesystem sandbox");
assert.equal(
  process.argv.length,
  4,
  "Usage: node verify-existing-store-copy.mjs SOURCE_DB NEW_PRIVATE_DIRECTORY",
);
const source = await realpath(process.argv[2]);
const directory = path.resolve(process.argv[3]);
await mkdir(directory, { mode: 0o700 }); // Refuse to reuse evidence from an earlier run.
const root = await realpath(directory);
const original = path.join(root, "original.sqlite");
const work = path.join(root, "working");
await mkdir(work, { mode: 0o700 });
const working = path.join(work, "agentkib.db");
const sourceDatabase = new DatabaseSync(source, { readOnly: true });
try {
  sourceDatabase.exec("PRAGMA query_only = ON");
  await backup(sourceDatabase, original);
} finally {
  sourceDatabase.close();
}
// Freeze a self-contained online snapshot; readonly WAL databases otherwise need writable -shm.
const snapshot = new DatabaseSync(original);
snapshot.exec("PRAGMA journal_mode=DELETE");
snapshot.close();
await chmod(original, 0o400);
await copyFile(original, working);
await chmod(working, 0o600);
const originalSha256 = createHash("sha256")
  .update(await readFile(original))
  .digest("hex");

const repository = fileURLToPath(new URL("../..", import.meta.url));
const desktopRequire = createRequire(path.join(repository, "apps/desktop/package.json"));
const { build } = await import(desktopRequire.resolve("vite"));
const entry = path.join(root, "store-entry.mjs");
await writeFile(
  entry,
  `export { BackendStore } from ${JSON.stringify(path.join(repository, "packages/backend/src/store.ts"))};\n`,
  { mode: 0o600 },
);
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    target: "node22",
    minify: false,
    outDir: path.join(root, "code"),
    lib: { entry, formats: ["cjs"], fileName: () => "store.cjs" },
    rollupOptions: { external: (id) => id.startsWith("node:") || builtinModules.includes(id) },
  },
});
const runner = path.join(root, "verify.cjs");
await writeFile(
  runner,
  `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { BackendStore } = require('./code/store.cjs');
const original=${JSON.stringify(original)},working=${JSON.stringify(working)};
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const normalized = value => typeof value === 'bigint' ? ['integer',String(value)] : value instanceof Uint8Array ? ['blob',Buffer.from(value).toString('base64')] : [typeof value,value];
function inspect(file) {
 const db = new DatabaseSync(file,{readOnly:true});
 try {
  db.exec('PRAGMA query_only=ON');
  const tables={},projected={},classification={};
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM schema_meta').all().map(({key,value})=>[key,digest(value)]));
  const requiresReclassification=meta.codex_session_classification_revision!==digest('3');
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
   const statement=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"');statement.setReadBigInts(true);
   const rows=statement.all();
   const rowHashes=rows.map(row=>createHash('sha256').update(JSON.stringify(Object.entries(row).map(([key,value])=>[key,normalized(value)]))).digest('hex')).sort();
   tables[name]={rows:rows.length,contentSha256:createHash('sha256').update(JSON.stringify(rowHashes)).digest('hex')};
   if(requiresReclassification && ['conversation_index_status','conversation_collection_status'].includes(name)){
    const hashes=rows.map(row=>{if(row.agent==='codex')row.last_success_at=null;return createHash('sha256').update(JSON.stringify(Object.entries(row).map(([key,value])=>[key,normalized(value)]))).digest('hex')}).sort();
    projected[name]={rows:rows.length,contentSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
   }
   if(['conversation_sessions','conversation_collection_sessions'].includes(name))
    classification[name]=rows.filter(row=>row.agent==='codex').map(row=>({id:row.id,workspace:row.workspace_id}));
  }
  const expectedMeta={...meta};
  if(requiresReclassification){
   for(const name of ['conversation_sessions','conversation_collection_sessions'])
    for(const row of classification[name]??[]){
     expectedMeta['codex_session_classification_pending:'+row.workspace]=digest('3');
     expectedMeta['codex_session_classification_stale:'+row.id]=digest(row.workspace);
    }
   expectedMeta.codex_session_classification_revision=digest('3');
  }
  return {tables,meta,expectedMeta,projected};
 } finally { db.close(); }
}
const before=inspect(original),reads=[];
for(let i=0;i<2;i++){
 const store=new BackendStore(working);
 try { const rows=store.listWorkspaces();reads.push({workspaces:rows.length,resultSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}); }
 finally {store.close();}
}
const after=inspect(working);
const changes=[];
for(const key of new Set([...Object.keys(before.meta),...Object.keys(after.meta)]))
 if(before.meta[key]!==after.meta[key]) changes.push(key);
assert.deepEqual(after.meta,before.expectedMeta,'Metadata differs from exact source-derived classification projection');
for(const [name,value] of Object.entries(before.tables)){
 assert.ok(after.tables[name],'An original table disappeared');
 if(name!=='schema_meta') assert.deepEqual(after.tables[name],before.projected[name]??value,'Original table changed: '+name);
}
const added=Object.keys(after.tables).filter(name=>!before.tables[name]);
for(const name of added) {
 assert.ok(['conversation_collection_sessions','conversation_collection_status'].includes(name),'Unexpected new table');
 assert.equal(after.tables[name].rows,0,'A newly created cache table contains unexpected rows');
}
assert.deepEqual(reads[0],reads[1],'Reopening changed the stored workspace projection');
process.stdout.write(JSON.stringify({tablesBefore:before.tables,tablesAfter:after.tables,metadataChangedKeys:changes,knownCacheProjection:{tables:Object.keys(before.projected),rule:'Only codex rows last_success_at becomes null; every other column remains identical'},addedTables:added,reads})+'\\n');
`,
  { mode: 0o600 },
);
const policy = path.join(root, "read-copy.sb");
await writeFile(
  policy,
  `(version 1)\n(allow default)\n(deny network*)\n(deny file-write* (require-not (subpath ${JSON.stringify(work)})))\n`,
  { mode: 0o600 },
);
const environment = {
  HOME: work,
  USERPROFILE: work,
  TMPDIR: work,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
};
// Test the containment rule before giving the child the real snapshot path.
execFileSync(
  "/usr/bin/sandbox-exec",
  [
    "-f",
    policy,
    process.execPath,
    "-e",
    `try {require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "forbidden-write"))},'bad');process.exit(2)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}`,
  ],
  { env: environment, stdio: "pipe" },
);
const result = JSON.parse(
  execFileSync("/usr/bin/sandbox-exec", ["-f", policy, process.execPath, runner], {
    env: environment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  }),
);
assert.equal(
  createHash("sha256")
    .update(await readFile(original))
    .digest("hex"),
  originalSha256,
);
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  scope: "installed-database-online-backup-current-store-read",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  sourceDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim(),
  ),
  storeBundleSha256: createHash("sha256")
    .update(await readFile(path.join(root, "code/store.cjs")))
    .digest("hex"),
  storeSourceSha256: createHash("sha256")
    .update(await readFile(path.join(repository, "packages/backend/src/store.ts")))
    .digest("hex"),
  originalSha256,
  originalBackupUnchanged: true,
  originalBackupMode: "0400",
  sourceOpenedReadOnly: true,
  sourceApplicationModified: false,
  externalWritesDeniedAndProbed: true,
  networkDenied: true,
  homeIsolated: true,
  guiAcceptance: false,
  ...result,
};
await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  `PASS installed database copy: ${Object.keys(result.tablesBefore).length} original tables checked, ${result.reads[0].workspaces} workspaces read twice; private contents not printed`,
);
