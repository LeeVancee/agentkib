// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { ClaudeFilesPanel } from "./ClaudeFilesPanel";
import type { SupportedLocale } from "@/core/types";
vi.mock("@/core/api", () => ({ api: { claudeRequest: vi.fn(), openExternal: vi.fn() } }));
let locale: SupportedLocale = "en-US";
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale }) }));
const entry = {
  id: "opaque",
  name: "result.txt",
  kind: "file",
  previewKind: "text",
  revision: "v1",
};
beforeEach(() => {
  locale = "en-US";
  vi.mocked(api.claudeRequest).mockReset();
  vi.mocked(api.openExternal).mockReset();
});
afterEach(cleanup);

it.each([
  {
    locale: "zh-CN",
    region: "文件与产物",
    parent: "上级目录",
    refresh: "刷新文件",
    loading: "正在读取",
    empty: "此目录为空",
    preview: "HTML 和媒体通过隔离的浏览器预览打开。",
  },
  {
    locale: "zh-TW",
    region: "檔案與產物",
    parent: "上層目錄",
    refresh: "重新整理檔案",
    loading: "正在讀取",
    empty: "此目錄為空",
    preview: "HTML 與媒體會透過隔離的瀏覽器預覽開啟。",
  },
  {
    locale: "en-US",
    region: "Files and artifacts",
    parent: "Parent directory",
    refresh: "Refresh files",
    loading: "Loading",
    empty: "This directory is empty",
    preview: "HTML and media open in an isolated browser preview.",
  },
  {
    locale: "ja-JP",
    region: "ファイルと成果物",
    parent: "親ディレクトリ",
    refresh: "ファイルを更新",
    loading: "読み込み中",
    empty: "このディレクトリは空です",
    preview: "HTML とメディアは隔離されたブラウザーのプレビューで開きます。",
  },
] as const)("renders loading and empty directory controls in $locale", async (expected) => {
  locale = expected.locale;
  let resolve!: (value: unknown) => void;
  vi.mocked(api.claudeRequest).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<ClaudeFilesPanel sessionId="session" />);
  expect(screen.getByRole("region", { name: expected.region })).toBeVisible();
  expect(screen.getByRole("button", { name: expected.parent })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(expected.loading);
  expect(screen.getByRole("button", { name: expected.refresh })).toBeDisabled();
  await act(async () => resolve({ directoryId: "root", entries: [] }));
  expect(await screen.findByText(expected.empty)).toBeVisible();
  expect(screen.getByText(expected.preview)).toBeVisible();
  expect(screen.getByRole("button", { name: expected.refresh })).toBeEnabled();
  expect(api.claudeRequest).toHaveBeenCalledExactlyOnceWith({
    operation: "files",
    sessionId: "session",
  });
  expect(api.openExternal).not.toHaveBeenCalled();
});

it("updates mounted file labels without dropping the selected preview or reloading it", async () => {
  vi.mocked(api.claudeRequest).mockImplementation(async (body) =>
    body.operation === "files"
      ? { directoryId: "root", entries: [entry] }
      : { ...entry, text: "Preserved preview" },
  );
  const view = render(<ClaudeFilesPanel sessionId="session" />);
  fireEvent.click(await screen.findByRole("button", { name: "result.txt" }));
  const preview = await screen.findByText("Preserved preview");
  const reads = vi.mocked(api.claudeRequest).mock.calls.length;
  locale = "ja-JP";
  view.rerender(<ClaudeFilesPanel sessionId="session" />);
  expect(screen.getByRole("region", { name: "ファイルと成果物" })).toBeVisible();
  expect(screen.getByRole("button", { name: "ファイルを更新" })).toBeEnabled();
  expect(screen.getByText("Preserved preview")).toBe(preview);
  expect(api.claudeRequest).toHaveBeenCalledTimes(reads);
});
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
