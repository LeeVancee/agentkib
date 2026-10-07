import path from "node:path";
import { z } from "zod";
import { CodexSessions } from "./codex-sessions";
import { readManagedCatalogSnapshot } from "./managed-ledger";
import { canonicalize, pathIdentity } from "./paths";
import type { SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";

export const managedRecordSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace: z.string(),
  home: z.string(),
  native_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  policy_id: z.string().optional(),
  default_model: z.string().nullable().optional(),
  default_effort: z.string().nullable().optional(),
  default_service_tier: z.string().nullable().optional(),
  native_settings: z.unknown().optional(),
  mode: z.string().nullable().optional(),
  source_session_id: z.string().nullable().optional(),
  title: z.string(),
  created_at: z.string(),
  released: z.boolean(),
  adopted: z.boolean(),
  archived: z.boolean().default(false),
  token_usage: z.unknown().optional(),
  goal: z.unknown().optional(),
  snapshot: z
    .object({ revision: z.number().int().nonnegative().optional() })
    .passthrough()
    .optional(),
});

export type ManagedCatalogRecord = z.infer<typeof managedRecordSchema>;
export interface ManagedCatalog {
  records: ManagedCatalogRecord[];
  complete: boolean;
}
type IndexedSession = ReturnType<BackendStore["sessions"]["list"]>[number];

export function readManagedCatalog(dataDir: string): ManagedCatalog {
  const snapshot = readManagedCatalogSnapshot(dataDir);
  return {
    records: snapshot.records
      .map((record) => {
        const parsed = managedRecordSchema.safeParse(record);
        if (!parsed.success) throw new Error("Invalid managed Codex session record");
        return parsed.data;
      })
      .filter((record) => !record.released || !record.adopted),
    complete: snapshot.complete,
  };
}

export function hasManagedCatalogWorkspace(store: BackendStore, record: ManagedCatalogRecord) {
  try {
    return (
      path.isAbsolute(record.workspace) &&
      pathIdentity(canonicalize(store.workspacePath(record.workspace_id))) ===
        pathIdentity(canonicalize(record.workspace))
    );
  } catch {
    return false;
  }
}

/** Return only native aliases whose global ownership and bounded header agree. */
export async function managedCatalogAliases(
  store: BackendStore,
  readers: SessionReaders,
  catalog: ManagedCatalog,
): Promise<Map<string, Set<string>>> {
  const aliases = new Map<string, Set<string>>();
  if (!catalog.complete || catalog.records.length === 0) return aliases;
  const owners = new Map<string, ManagedCatalogRecord | null>();
  // Check the complete active ledger before ignoring inaccessible workspaces.
  // Otherwise an unregistered conflicting owner could grant an exception.
  for (const record of catalog.records) {
    const native = uuid(record.native_id);
    if (!native) continue;
    owners.set(native, owners.has(native) ? null : record);
  }
  let home: string;
  try {
    home = canonicalize(readers.codexHome());
  } catch {
    return aliases;
  }
  const workspaces = new Map<string, Map<string, ManagedCatalogRecord>>();
  for (const [native, record] of owners) {
    if (!record || !hasManagedCatalogWorkspace(store, record)) continue;
    try {
      if (
        !path.isAbsolute(record.home) ||
        pathIdentity(canonicalize(record.home)) !== pathIdentity(home)
      )
        continue;
    } catch {
      continue;
    }
    let workspaceOwners = workspaces.get(record.workspace_id);
    if (!workspaceOwners) workspaces.set(record.workspace_id, (workspaceOwners = new Map()));
    workspaceOwners.set(native, record);
  }
  const candidates: Array<{ native: string; ref: string; record: ManagedCatalogRecord }> = [];
  for (const [workspaceId, workspaceOwners] of workspaces) {
    try {
      const listing = await readers.list("codex", store.workspacePath(workspaceId));
      for (const candidate of listing.sessions) {
        if (candidate.origin === "auxiliary") continue;
        const native = uuid(candidate.native_ref);
        const record = native ? workspaceOwners.get(native) : undefined;
        if (native && record) candidates.push({ native, ref: candidate.native_ref, record });
      }
    } catch {
      // An unavailable native source cannot prove a directory ownership alias.
    }
  }
  if (candidates.length === 0) return aliases;
  const identities = new CodexSessions({ CODEX_HOME: home }).verifiedIndexedIdentities(
    candidates.map((candidate) => candidate.ref),
  );
  // The alias ID helper can create a salt. A directory only projects existing
  // index identities, which always have their salt already recorded.
  if (
    typeof store.sessions.sql.one("SELECT value FROM schema_meta WHERE key='conversation_salt'")
      ?.value !== "string"
  )
    return aliases;
  for (const { native, ref, record } of candidates) {
    const verified = identities.get(native);
    if (!verified || pathIdentity(verified.cwd) !== pathIdentity(record.workspace)) continue;
    let owned = aliases.get(record.id);
    if (!owned) aliases.set(record.id, (owned = new Set()));
    owned.add(store.sessions.id("codex", ref));
  }
  return aliases;
}

/** Project display ownership without returning ledger identity or control grants. */
export async function projectPairedManagedSessions(
  store: BackendStore,
  readers: SessionReaders,
  dataDir: string,
  sessions: IndexedSession[],
): Promise<IndexedSession[]> {
  if (!sessions.some((session) => session.agent === "codex" && session.origin !== "auxiliary"))
    return sessions;
  const catalog = readManagedCatalog(dataDir);
  const aliases = await managedCatalogAliases(store, readers, catalog);
  const owners = new Map<string, string>();
  for (const record of catalog.records)
    for (const alias of aliases.get(record.id) ?? [])
      owners.set(JSON.stringify([record.workspace_id, alias]), record.id);
  // Finish all fallible ownership reads before producing the changed catalog.
  const seen = new Set<string>();
  return sessions.flatMap((session) => {
    if (session.agent !== "codex" || session.origin === "auxiliary") return [session];
    const owner = owners.get(JSON.stringify([session.workspace_id, session.id]));
    if (!owner) return [session];
    if (seen.has(owner)) return [];
    seen.add(owner);
    return [session.origin === "execution" ? { ...session, origin: "interactive" } : session];
  });
}

function uuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
