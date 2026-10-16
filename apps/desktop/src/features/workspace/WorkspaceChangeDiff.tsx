import { cn } from "cn";
import { diffLines } from "./diff";

export function WorkspaceChangeDiff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="overflow-auto rounded-lg border border-border bg-muted/30">
      {diffLines(before, after).map((line, index) => (
        <div
          className={cn(
            "grid grid-cols-[1.5rem_minmax(0,1fr)] px-3 py-0.5",
            line.type === "added" && "bg-emerald-50 text-emerald-800",
            line.type === "removed" && "bg-red-50 text-red-800",
          )}
          key={`${index}-${line.content}`}
        >
          <span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
          {line.content || " "}
        </div>
      ))}
    </pre>
  );
}
