// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { sessionSourceDetails } from "./session-labels";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  filterSessions,
  groupSessions,
  sessionCatalogStats,
  projectManagedSessionAliases,
  sortSessions,
} from "./session-catalog";
import {
  filterSessions as sharedFilterSessions,
  groupSessions as sharedGroupSessions,
} from "@agentkib/session-catalog";

const workspaces = [
  { id: "one", name: "Shared project" },
  { id: "two", name: "Shared project" },
] as WorkspaceSummary[];
const sessions: ConversationSessionSummary[] = [
  {
    id: "readable",
    workspace_id: "one",
    agent: "codex",
    title: "Review sidebar",
    archived: false,
    sidechain: false,
    availability: "readable",
    updated_at: "2026-09-01T00:00:00Z",
  },
  {
    id: "archived",
    workspace_id: "two",
    agent: "claude-code",
    title: "Review sidebar",
    archived: true,
    sidechain: false,
    availability: "readable",
    updated_at: "2026-09-02T00:00:00Z",
  },
  {
    id: "metadata",
    workspace_id: "two",
    agent: "codex",
    title: "Investigate build",
    archived: false,
    sidechain: false,
    availability: "metadata-only",
  },
];

describe("session catalog", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("uses current, archived, metadata and all record semantics", () => {
    const select = (filter: "current" | "archived" | "metadata" | "all") =>
      filterSessions(sessions, workspaces, { query: "", agent: "all", filter }).map(({ id }) => id);
    expect(select("current")).toEqual(["readable"]);
    expect(select("archived")).toEqual(["archived"]);
    expect(select("metadata")).toEqual(["metadata"]);
    expect(select("all")).toEqual(["archived", "readable", "metadata"]);
  });

  it("always hides auxiliary and execution records while retaining unknown sources", () => {
    const records: ConversationSessionSummary[] = [
      sessions[0],
      { ...sessions[0], id: "auxiliary", origin: "auxiliary", archived: true },
      { ...sessions[0], id: "execution", origin: "execution", availability: "metadata-only" },
      { ...sessions[0], id: "unknown", origin: "unknown" },
      { ...sessions[0], id: "untitled", title: undefined },
      { ...sessions[0], id: "managed", origin: "interactive" },
      { ...sessions[0], id: "fork", origin: "interactive", forked_from_session_id: "main" },
    ];
    expect(
      filterSessions(records, workspaces, { query: "", agent: "all", filter: "all" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["readable", "unknown", "untitled", "managed", "fork"]);
    for (const filter of ["current", "archived", "metadata", "all"] as const) {
      expect(
        filterSessions(records, workspaces, { query: "execution", agent: "all", filter }),
      ).toEqual([]);
    }
    expect(groupSessions(records, workspaces)[0].sessions.map(({ id }) => id)).toEqual([
      "readable",
      "unknown",
      "untitled",
      "managed",
      "fork",
    ]);
  });

  it.each(["auxiliary", "execution"] as const)(
    "does not turn a hidden %s parent into a source navigation link",
    (origin) => {
      const hidden = { ...sessions[0], id: "hidden-parent", title: "Hidden parent name", origin };
      const fork = {
        ...sessions[0],
        id: "fork",
        origin: "interactive" as const,
        forked_from_session_id: hidden.id,
      };
      const [detail] = sessionSourceDetails(fork, [fork, hidden]);
      expect(detail.session).toBeUndefined();
      expect(detail.label).not.toContain(hidden.title);
    },
  );

  it("preserves native IDs for verified managed execution aliases and deduplicates ownership", () => {
    const execution = { ...sessions[0], id: "native", origin: "execution" as const };
    const duplicate = { ...execution, id: "native-alias" };
    const owner = {
      ...sessions[0],
      id: "managed",
      origin: "interactive" as const,
      indexedSessionIds: [execution.id, duplicate.id],
    };
    const records = [execution, duplicate, { ...execution, id: "unowned" }];
    expect(projectManagedSessionAliases(records, [owner])).toEqual([
      { ...execution, origin: "interactive" },
      { ...execution, id: "unowned" },
    ]);
    expect(projectManagedSessionAliases(records, [owner], duplicate.id)).toEqual([
      { ...duplicate, origin: "interactive" },
      { ...execution, id: "unowned" },
    ]);
    expect(execution.origin).toBe("execution");
    expect(
      filterSessions(projectManagedSessionAliases(records, [owner]), workspaces, {
        query: "",
        agent: "all",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["native"]);
    for (const invalidOwner of [
      { ...owner, agent: "claude-code" as const },
      { ...owner, workspace_id: "another" },
      { ...owner, origin: "unknown" as const },
      { ...owner, indexedSessionIds: undefined },
    ])
      expect(projectManagedSessionAliases([execution], [invalidOwner])).toEqual([execution]);
    expect(
      projectManagedSessionAliases([execution], [owner, { ...owner, id: "other-owner" }]),
    ).toEqual([execution]);
    const auxiliary = { ...execution, origin: "auxiliary" as const };
    expect(projectManagedSessionAliases([auxiliary], [owner])).toEqual([auxiliary]);
  });

  it("shows five conversations when the native index also contains thirty-six executions", () => {
    const ordinary = Array.from({ length: 5 }, (_, index) => ({
      ...sessions[0],
      id: `ordinary-${index}`,
      origin: "interactive" as const,
    }));
    const executions = Array.from({ length: 36 }, (_, index) => ({
      ...sessions[0],
      id: `exec-${index}`,
      origin: "execution" as const,
      title: undefined,
    }));
    const records = [...ordinary, ...executions];
    expect(filterSessions(records, workspaces, { query: "", agent: "all", filter: "all" })).toEqual(
      ordinary,
    );
    expect(sessionCatalogStats(records)).toEqual({
      total: 5,
      readable: 5,
      archived: 0,
      metadata: 0,
    });
  });

  it("combines title and workspace name search with Agent filters, without conflating names", () => {
    expect(
      filterSessions(sessions, workspaces, {
        query: "  SHARED PROJECT  ",
        agent: "codex",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["readable", "metadata"]);
    expect(
      filterSessions(sessions, workspaces, {
        query: "sidebar",
        agent: "claude-code",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["archived"]);
    expect(
      filterSessions(sessions, [workspaces[0]], { query: "", agent: "all", filter: "all" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["readable"]);
  });

  it("does not search hidden internal wrapper titles", () => {
    const internal = { ...sessions[0], title: "<path>secret-internal-file</path>" };
    expect(
      filterSessions([internal], workspaces, {
        query: "secret-internal-file",
        agent: "all",
        filter: "all",
      }),
    ).toEqual([]);
  });

  it("sorts recent first without mutating input and preserves ties and invalid timestamps", () => {
    const input = [
      { ...sessions[0], id: "invalid", updated_at: "not-a-date" },
      { ...sessions[0], id: "equal-a" },
      { ...sessions[0], id: "equal-b" },
      { ...sessions[0], id: "missing", updated_at: undefined },
    ];
    expect(sortSessions(input).map(({ id }) => id)).toEqual([
      "equal-a",
      "equal-b",
      "invalid",
      "missing",
    ]);
    expect(input[0].id).toBe("invalid");
  });

  it("calculates overview metrics from only the supplied filtered records", () => {
    expect(sessionCatalogStats(sessions)).toEqual({
      total: 3,
      readable: 2,
      archived: 1,
      metadata: 1,
    });
    expect(sessionCatalogStats([])).toEqual({ total: 0, readable: 0, archived: 0, metadata: 0 });
  });

  it("keeps desktop and Web structural records on identical shared rules", () => {
    const filters = { query: "", agent: "all" as const, filter: "all" as const };
    const desktop = filterSessions(sessions, workspaces, filters);
    const web = sharedFilterSessions(sessions, workspaces, filters, "Untitled session");
    expect(desktop).toEqual(web);
    expect(groupSessions(desktop, workspaces)).toEqual(sharedGroupSessions(web, workspaces));
  });

  it("groups by identity, disambiguates project names and uses creation time fallback", () => {
    const projects = [
      { id: "one", name: "app", path: "/work/personal/app" },
      { id: "two", name: "app", path: "/work/company/app" },
    ];
    const records = [
      { ...sessions[0], updated_at: undefined },
      { ...sessions[1], updated_at: "invalid", created_at: "2026-09-03T00:00:00Z" },
    ];
    const groups = groupSessions(records, projects);
    expect(groups.map(({ workspace, label }) => [workspace.id, label])).toEqual([
      ["two", "app · company/app"],
      ["one", "app · personal/app"],
    ]);
    expect(groups[0].sessions.map(({ id }) => id)).toEqual(["archived"]);
  });

  it("keeps remote host groups contiguous and equal timestamps stable", () => {
    const projects = [
      { id: "one", name: "One", path: "/one" },
      { id: "two", name: "Two", path: "/two" },
      { id: "remote", name: "Remote", path: "/remote", remote: { host_id: "z", online: true } },
    ];
    const records = [
      { ...sessions[0], updated_at: undefined },
      { ...sessions[0], id: "other", workspace_id: "two", updated_at: undefined },
      { ...sessions[0], id: "remote", workspace_id: "remote" },
    ];
    expect(groupSessions(records, projects).map(({ workspace }) => workspace.id)).toEqual([
      "one",
      "two",
      "remote",
    ]);
    expect(groupSessions(records, projects)[2].workspace.remote?.online).toBe(true);
  });
});
