import { useEffect, useRef, useState } from "react";
import { api } from "@/core/api";
import type { NativeImportOperation } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { withAsyncCleanup } from "@/lib/utils";
import { sessionHandoffTargets } from "./session-handoff-targets";

/** Persisted operations make an interrupted import recoverable after app restart. */
export function NativeImportRecoveryPanel({
  workspaceId,
  readableSourceIds = [],
  onReview,
}: {
  workspaceId: string;
  readableSourceIds?: string[];
  onReview?: (operation: NativeImportOperation) => void;
}) {
  const { tr, localizeMessage } = useI18n();
  const [result, setResult] = useState<{
    workspaceId: string;
    operations: NativeImportOperation[];
  }>();
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setResult(undefined);
    setError("");
    setBusyId(undefined);
    busy.current = false;
    void Promise.resolve()
      .then(() => api.nativeImportOperations(workspaceId))
      .then(
        (operations) => {
          if (current === generation.current) setResult({ workspaceId, operations });
        },
        (reason: unknown) => {
          if (current === generation.current) setError(localizeMessage(reason));
        },
      );
    return () => {
      generation.current += 1;
    };
  }, [workspaceId, revision, localizeMessage]);
  const recover = async (operation: NativeImportOperation) => {
    if (busy.current) return;
    busy.current = true;
    const current = generation.current;
    setBusyId(operation.launch_request.operation_id);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await api.launchSessionHandoff(operation.launch_request);
          if (current === generation.current) setRevision((value) => value + 1);
        } catch (reason) {
          if (current === generation.current) setError(localizeMessage(reason));
        }
      },
      () => {
        if (current === generation.current) {
          busy.current = false;
          setBusyId(undefined);
        }
      },
    );
  };
  const operations =
    result?.workspaceId === workspaceId
      ? result.operations.filter((item) => item.status !== "launched")
      : [];
  if (!operations.length && !error) return null;
  return (
    <section
      className="m-5 grid gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
      aria-label={tr("handoff.recovery.title")}
    >
      <strong>{tr("handoff.recovery.title")}</strong>
      <p className="text-xs text-muted-foreground">{tr("handoff.recovery.detail")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {operations.map((operation) => (
        <div
          key={operation.launch_request.operation_id}
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <div>
            <span>
              {sessionHandoffTargets.find(
                ([agent]) => agent === operation.launch_request.target_agent,
              )?.[1] ?? operation.launch_request.target_agent}
            </span>
            <span className="ml-2 text-xs text-muted-foreground">
              {tr(`handoff.recovery.${operation.status}`)}
            </span>
            {operation.target_session_id && (
              <code className="block text-xs">{operation.target_session_id}</code>
            )}
          </div>
          <Button
            variant="outline"
            disabled={
              busyId !== undefined ||
              (operation.status === "prepared" &&
                (!onReview || !readableSourceIds.includes(operation.source_session_id)))
            }
            title={
              operation.status === "prepared" &&
              !readableSourceIds.includes(operation.source_session_id)
                ? tr("handoff.recovery.sourceUnavailable")
                : undefined
            }
            onClick={() =>
              operation.status === "prepared" ? onReview?.(operation) : void recover(operation)
            }
          >
            {tr(
              busyId === operation.launch_request.operation_id
                ? "common.loading"
                : operation.status === "prepared"
                  ? "handoff.recovery.review"
                  : operation.status === "verified"
                    ? "handoff.recovery.open"
                    : "handoff.recovery.check",
            )}
          </Button>
        </div>
      ))}
      {!operations.length && error && (
        <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
          {tr("handoff.recovery.reload")}
        </Button>
      )}
    </section>
  );
}
