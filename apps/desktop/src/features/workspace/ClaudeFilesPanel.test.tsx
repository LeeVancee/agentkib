// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { ClaudeFilesPanel } from "./ClaudeFilesPanel";
vi.mock("@/core/api", () => ({ api: { claudeRequest: vi.fn(), openExternal: vi.fn() } }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale: "en-US" }) }));
const entry = {
  id: "opaque",
  name: "result.txt",
  kind: "file",
  previewKind: "text",
  revision: "v1",
};
beforeEach(() => {
  vi.mocked(api.claudeRequest).mockReset();
  vi.mocked(api.openExternal).mockReset();
});
afterEach(cleanup);
it("reads a revision-bound text file as inert text without a renderer path", async () => {
  vi.mocked(api.claudeRequest).mockImplementation(async (body) =>
    body.operation === "files"
      ? { directoryId: "root", entries: [entry] }
      : { ...entry, text: "<script>doNotExecute()</script>" },
  );
  render(<ClaudeFilesPanel sessionId="session" />);
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }));
  expect(await screen.findByText("<script>doNotExecute()</script>")).toBeVisible();
  expect(api.claudeRequest).toHaveBeenCalledWith({
    operation: "file-text",
    sessionId: "session",
    artifactId: "opaque",
    revision: "v1",
  });
  expect(document.querySelector("script")).toBeNull();
  expect(api.openExternal).not.toHaveBeenCalled();
});
it("opens HTML in the external isolated preview and ignores a late ticket after closing", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.claudeRequest).mockImplementation(async (body) =>
    body.operation === "files"
      ? { directoryId: "root", entries: [{ ...entry, name: "result.html", previewKind: "html" }] }
      : new Promise((done) => {
          resolve = done;
        }),
  );
  const view = render(<ClaudeFilesPanel sessionId="session" />);
  fireEvent.click(await screen.findByRole("button", { name: "result.html" }));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await act(async () =>
    resolve({ url: "http://127.0.0.1:12345/preview/ticket", revision: "bundle-sha256" }),
  );
  expect(api.openExternal).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:12345/preview/ticket");
  fireEvent.click(screen.getByRole("button", { name: "result.html" }));
  view.unmount();
  await act(async () => resolve({ url: "http://127.0.0.1:12345/preview/late", revision: "v1" }));
  expect(api.openExternal).toHaveBeenCalledTimes(1);
  expect(document.querySelector("iframe")).toBeNull();
});
