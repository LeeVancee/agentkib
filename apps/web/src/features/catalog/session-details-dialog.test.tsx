import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogCopy } from "./catalog-copy";
import { dictionaries } from "@/i18n";

const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/features/sessions/session-context", () => ({ useSession: () => session.value }));

import { SessionDetailsDialog } from "./session-details-dialog";

afterEach(cleanup);

describe("Codex native session details", () => {
  it("queries only the selected thread and labels its creation-time branch", async () => {
    const request = vi.fn().mockResolvedValue({
      available: true,
      cwd: "/repo/worktree",
      projectId: "native-project",
      branchAtCreation: "feature/start",
    });
    session.value = {
      t: dictionaries["zh-CN"],
      c: catalogCopy["zh-CN"],
      setModal: vi.fn(),
      current: { id: "thread-one", agent: "codex", workspace_id: "repo" },
      currentWorkspace: { name: "Repo", path: "/repo" },
      formatCatalogTime: () => "现在",
      sourceTitle: () => "",
      online: true,
      liveText: "空闲",
      client: { request },
      access: { status: "approved", protocolVersion: 2, device: { id: "browser" } },
    };
    render(<SessionDetailsDialog />);
    expect(await screen.findByText("/repo/worktree")).toBeInTheDocument();
    expect(screen.getByText("创建时分支")).toBeInTheDocument();
    expect(screen.getByText("feature/start")).toBeInTheDocument();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "managed/context?sessionId=thread-one",
        undefined,
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not substitute the indexed branch when Codex metadata is unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    session.value = {
      t: dictionaries["zh-CN"],
      c: catalogCopy["zh-CN"],
      setModal: vi.fn(),
      current: { id: "thread-two", agent: "codex", git_branch: "stale-branch" },
      currentWorkspace: { name: "Repo", path: "/repo" },
      formatCatalogTime: () => "现在",
      sourceTitle: () => "",
      online: false,
      liveText: "",
      client: { request },
      access: { status: "approved", protocolVersion: 2, device: { id: "browser" } },
    };
    render(<SessionDetailsDialog />);
    expect(await screen.findAllByText("Codex 信息不可用")).toHaveLength(3);
    expect(screen.queryByText("stale-branch")).not.toBeInTheDocument();
  });
});
