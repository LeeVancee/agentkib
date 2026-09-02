/** @jsxImportSource octane */

import { useState } from "octane";
import { Check, ChevronRight, Circle, ShieldCheck, X } from "@octanejs/lucide";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/core/api";
import { localizeMessage, tr } from "@/core/i18n";
import type { ContextDoctorSummary, OnboardingState, WorkspaceSummary } from "@/core/types";

export function GettingStartedCard({
  onboarding,
  workspaces,
  doctorSummaries,
  onRuntimeChanged,
  onAddRoot,
  onOpenDoctor,
}: {
  onboarding?: OnboardingState;
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  onRuntimeChanged: (runtime: Awaited<ReturnType<typeof api.updateOnboarding>>) => void;
  onAddRoot: () => Promise<void>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!onboarding || onboarding.acknowledged_version >= onboarding.version) return null;

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === onboarding.workspace_id) ??
    workspaces.find((workspace) => {
      const summary = doctorSummaries[workspace.id];
      return summary && summary.error_count + summary.warning_count > 0;
    }) ??
    workspaces[0];
  const workspaceDone = workspaces.length > 0;
  const doctorDone = onboarding.doctor_completed;
  const repairDone = doctorDone && onboarding.repairable_count === 0;
  const actionLabel = !workspaceDone
    ? tr("onboarding.addWorkspace")
    : doctorDone && onboarding.repairable_count > 0
      ? tr("onboarding.reviewRepair")
      : tr("onboarding.runDoctor");

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () =>
    run(async () => onRuntimeChanged(await api.updateOnboarding({ event: "dismissed" })));
  const continueOnboarding = () =>
    run(async () => {
      if (!workspaceDone) await onAddRoot();
      else if (selectedWorkspace) await onOpenDoctor(selectedWorkspace);
    });

  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/8 text-primary">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-[-.02em]">{tr("onboarding.title")}</h2>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tr("onboarding.dismiss")}
          disabled={busy}
          onClick={() => void dismiss()}
        >
          <X size={15} />
        </Button>
      </div>
      <div className="grid items-center gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <ol className="grid gap-2.5 text-sm">
          <OnboardingStep done={workspaceDone} label={tr("onboarding.workspaceStep")} />
          <OnboardingStep done={doctorDone} label={tr("onboarding.doctorStep")} />
          <OnboardingStep done={repairDone} label={tr("onboarding.repairStep")} />
        </ol>
        <Button disabled={busy} onClick={() => void continueOnboarding()}>
          {actionLabel}
          <ChevronRight size={15} />
        </Button>
      </div>
      {error && (
        <div className="border-t border-destructive/20 bg-destructive/5 px-5 py-2.5 text-xs text-destructive">
          {error}
        </div>
      )}
    </Card>
  );
}

function OnboardingStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      {done ? (
        <span className="grid size-5 place-items-center rounded-full bg-emerald-500/12 text-emerald-700">
          <Check size={13} />
        </span>
      ) : (
        <Circle size={18} className="text-muted-foreground/60" />
      )}
      <span className={done ? "text-muted-foreground line-through" : "text-foreground"}>
        {label}
      </span>
    </li>
  );
}
