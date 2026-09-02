/** @jsxImportSource octane */

import rehypeSanitize from "rehype-sanitize";
import ReactMarkdown from "@octanejs/markdown";
import remarkGfm from "remark-gfm";
import type { PropsOf } from "@/lib/octane-types";
import { api } from "@/core/api";
import { cn } from "@/lib/utils";

export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("markdown-content", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ a: MarkdownLink }}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownLink({ href, children, ...props }: PropsOf<"a">) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void api.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
