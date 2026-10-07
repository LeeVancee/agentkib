import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CodexContextOptions, type CodexContextResource } from "@agentkib/web-client";
import { CodexComposerControls } from "@agentkib/conversation-ui/features/sessions/codex-session-controls";
import { useSession } from "@agentkib/conversation-ui/features/sessions/session-context";
vi.mock("@agentkib/conversation-ui/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));
let state: ReturnType<typeof useSession>;
const folder: CodexContextResource = {
  id: "folder-ref",
  kind: "directory",
  name: "src",
  navigationId: "opaque-src",
  available: true,
};
const rootFile: CodexContextResource = {
  id: "root-file",
  kind: "file",
  name: "README.md",
  available: true,
};
const nestedFile: CodexContextResource = {
  id: "nested-file",
  kind: "file",
  name: "nested.ts",
  available: true,
};
const root: CodexContextOptions = {
  sessionId: "s",
  revision: 1,
  directoryId: "opaque-root",
  resources: [folder, rootFile],
};
const nested: CodexContextOptions = {
  sessionId: "s",
  revision: 1,
  directoryId: "opaque-src",
  parentId: "opaque-root",
  resources: [nestedFile],
};
function Harness() {
  const [resources, setResources] = useState<CodexContextResource[]>([]);
  return (
    <>
      <CodexComposerControls
        resources={resources}
        setResources={setResources}
        disabled={false}
        openPhoneFiles={vi.fn()}
      />
      <output aria-label="selected ids">{resources.map((item) => item.id).join(",")}</output>
    </>
  );
}
beforeEach(() => {
  state = {
    selected: "s",
    locale: "en-US",
    online: true,
    busy: false,
    access: { device: { accessMode: "full" } },
    live: { sessionId: "s", status: "idle", revision: 1 },
    capabilities: { features: { context: { available: true } } },
    client: {
      codexSessionSettings: vi.fn().mockRejectedValue(new Error("unsupported")),
      codexGoals: vi.fn().mockRejectedValue(new Error("unsupported")),
      codexContextOptions: vi.fn(async (_session: string, id?: string) =>
        id === "opaque-src" ? nested : root,
      ),
    },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  await screen.findByRole("button", { name: "Open folder: src" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open folder: src" })).toBeEnabled(),
  );
}
it("navigates with opaque cursors and preserves selected resources across directories", async () => {
  render(<Harness />);
  await open();
  fireEvent.click(screen.getByRole("checkbox", { name: /README.md/ }));
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  await screen.findByRole("checkbox", { name: /nested.ts/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-src",
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /nested.ts/ }));
  expect(screen.getByLabelText("selected ids")).toHaveTextContent("root-file,nested-file");
  fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
  await screen.findByRole("checkbox", { name: /README.md/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-root",
    expect.any(AbortSignal),
  );
  expect(screen.getByRole("checkbox", { name: /README.md/ })).toBeChecked();
  expect(screen.getByLabelText("selected ids")).toHaveTextContent("root-file,nested-file");
  expect(screen.getByRole("button", { name: "Parent folder" })).toBeDisabled();
});
it("shows navigation loading and errors, then retries the same authorized cursor", async () => {
  render(<Harness />);
  await open();
  let reject!: (error: unknown) => void;
  vi.mocked(state.client.codexContextOptions).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  expect(screen.getByText("Loading resources…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open folder: src" })).toBeDisabled();
  reject(new Error("temporary"));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByRole("checkbox", { name: /nested.ts/ });
  expect(state.client.codexContextOptions).toHaveBeenLastCalledWith(
    "s",
    "opaque-src",
    expect.any(AbortSignal),
  );
});
it("aborts old directory requests and ignores their response after a session switch", async () => {
  const view = render(<Harness />);
  await open();
  let resolve!: (value: CodexContextOptions) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(state.client.codexContextOptions).mockImplementationOnce(
    (_id, _directory, requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Open folder: src" }));
  state = { ...state, selected: "other", live: { ...state.live!, sessionId: "other" } };
  view.rerender(<Harness />);
  expect(signal?.aborted).toBe(true);
  resolve(nested);
  await open();
  expect(screen.queryByRole("checkbox", { name: /nested.ts/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Parent folder" })).toBeDisabled();
  expect(screen.getByLabelText("selected ids")).toBeEmptyDOMElement();
});
it("keeps directory browsing disabled when context capability is unavailable", async () => {
  state = {
    ...state,
    capabilities: { ...state.capabilities!, features: { context: { available: false } } },
  };
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  expect(await screen.findByRole("button", { name: "Open folder: src" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /src/ })).toBeDisabled();
});
