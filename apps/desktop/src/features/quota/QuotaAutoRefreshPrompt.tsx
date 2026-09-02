/** @jsxImportSource octane */

import { Button } from "@/components/ui/button";
import { localizeMessage, tr } from "@/core/i18n";
import { cn } from "@/lib/utils";
import { Gauge } from "@octanejs/lucide";
import { useState } from "octane";

export function QuotaAutoRefreshPrompt({
  compact = false,
  onEnableAutoRefresh,
  onNotNow,
}: {
  compact?: boolean;
  onEnableAutoRefresh: () => Promise<void>;
  onNotNow: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={cn(
        "rounded-2xl border border-primary/25 bg-primary/5 p-4",
        compact && "rounded-xl p-3",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-content-center rounded-xl bg-primary/10 text-primary">
          <Gauge size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-semibold text-foreground">
            {tr("quota.autoRefreshPromptTitle")}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy} onClick={() => void run(onEnableAutoRefresh)}>
              {tr("quota.enableAutoRefresh")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(onNotNow)}
            >
              {tr("quota.notNow")}
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  );
}
