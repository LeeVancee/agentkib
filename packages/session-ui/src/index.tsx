import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

export {
  sessionContinuationCopy,
  SessionContinuationChoice,
  SessionContinuationReadOnly,
  SessionContinuationStatus,
  type SessionContinuationAction,
  type SessionContinuationAgent,
  type SessionContinuationChoiceProps,
  type SessionContinuationCopy,
  type SessionContinuationReadOnlyProps,
  type SessionContinuationStatusProps,
} from "./session-continuation";

export function toolStatusLabel(status: string | undefined, locale: string): string {
  const names =
    locale === "zh-TW"
      ? ["已完成", "失敗", "執行中", "等待中", "已取消"]
      : locale.startsWith("zh")
        ? ["已完成", "失败", "执行中", "等待中", "已取消"]
        : locale.startsWith("ja")
          ? ["完了", "失敗", "実行中", "待機中", "キャンセル済み"]
          : ["Completed", "Failed", "Running", "Pending", "Cancelled"];
  const value = status?.toLowerCase();
  if (["completed", "complete", "success", "succeeded"].includes(value ?? "")) return names[0];
  if (["failed", "failure", "error", "errored"].includes(value ?? "")) return names[1];
  if (["running", "in-progress", "inprogress"].includes(value ?? "")) return names[2];
  if (["pending", "queued"].includes(value ?? "")) return names[3];
  if (["cancelled", "canceled"].includes(value ?? "")) return names[4];
  return status ?? "";
}

const markdownComponents: Components = {
  img: () => null,
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={markdownComponents}
    >
      {text}
    </Markdown>
  );
}
