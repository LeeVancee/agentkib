import { useRef, useState } from "react";
import { Gauge } from "lucide-react";
import type { ContextUsage, Live } from "@agentkib/web-client";
import type { Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { codexCopy } from "./codex-copy";
import { contextUsageCopy, contextUsageReason } from "./context-usage-copy";

export function contextUsagePercent(usage?: ContextUsage) {
  if (
    !usage ||
    (!usage.available && usage.state !== "stale" && usage.state !== "pending") ||
    !Number.isFinite(usage.usedTokens) ||
    Number(usage.usedTokens) < 0 ||
    !Number.isFinite(usage.contextWindow) ||
    Number(usage.contextWindow) <= 0
  )
    return undefined;
  return Math.min(100, Math.max(0, (Number(usage.usedTokens) / Number(usage.contextWindow)) * 100));
}

type Observation = {
  scope: string;
  identity: unknown;
  blockedLive?: Live;
  lastLive?: Live;
  lastNative?: ContextUsage;
  lastFallback?: ContextUsage;
  blockedFallback?: ContextUsage;
  usage?: ContextUsage;
  nativeSeen: boolean;
  compacting?: boolean;
  afterCompaction?: { reportId?: number; updatedAt?: string; native?: ContextUsage };
};

function acceptsReport(native: ContextUsage, current?: ContextUsage) {
  if (current?.reportGeneration !== undefined) {
    if (native.reportGeneration === undefined || native.reportGeneration < current.reportGeneration)
      return false;
    if (native.reportGeneration > current.reportGeneration) return true;
  } else if (native.reportGeneration !== undefined) return true;
  return (
    native.reportId === undefined ||
    current?.reportId === undefined ||
    native.reportId >= current.reportId
  );
}

/** Settings are a compatibility fallback; a native report always has priority. */
export function useContextUsage(fallback?: ContextUsage) {
  const { selected, client, access, live, online, usageEpoch } = useSession();
  const authorized =
    access?.device?.accessMode === "full" && access.device.advancedControl === true;
  const scope = `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${authorized}\0${usageEpoch ?? ""}`;
  return useObservedContextUsage({
    selected,
    scope,
    identity: client,
    live,
    online,
    authorized,
    fallback,
  });
}

export function useObservedContextUsage({
  selected,
  scope,
  identity,
  live,
  online,
  authorized,
  fallback,
}: {
  selected: string;
  scope: string;
  identity?: unknown;
  live?: Live;
  online: boolean;
  authorized: boolean;
  fallback?: ContextUsage;
}) {
  const observation = useRef<Observation | undefined>(undefined);
  if (observation.current?.scope !== scope || observation.current?.identity !== identity) {
    const previous = observation.current;
    observation.current = {
      scope,
      identity,
      blockedLive:
        previous && previous.lastLive === live && previous.scope.split("\0")[0] === selected
          ? live
          : undefined,
      blockedFallback: previous && previous.lastFallback === fallback ? fallback : undefined,
      nativeSeen: false,
    };
  }
  const value = observation.current;
  value.lastLive = live;
  value.lastFallback = fallback;
  const native =
    authorized && live?.sessionId === selected && live !== value.blockedLive
      ? (live.usage ?? live.settings?.usage)
      : undefined;
  const acceptsNative = native !== undefined && acceptsReport(native, value.usage);
  if (native && native !== value.lastNative) {
    value.lastNative = native;
    if (acceptsNative) {
      // Native observers can rebuild while the shared transport epoch remains alive.
      if (
        native.reportGeneration !== undefined &&
        native.reportGeneration !== value.usage?.reportGeneration
      )
        value.afterCompaction = undefined;
      value.usage = native;
    }
    value.nativeSeen = true;
  }
  const usage: ContextUsage | undefined = !authorized
    ? { available: false, state: "unavailable", reason: "permission_denied" }
    : value.nativeSeen
      ? value.usage
      : fallback !== value.blockedFallback
        ? fallback
        : undefined;
  const percent = contextUsagePercent(usage);
  if (
    authorized &&
    live?.sessionId === selected &&
    live !== value.blockedLive &&
    (acceptsNative || (!native && value.usage?.reportGeneration === undefined))
  )
    value.compacting = live.activity === "compacting";
  // A late report must not activate or release the accepted observer's barrier.
  const compacting = authorized && value.compacting === true;
  const acceptedNative = acceptsNative ? native : undefined;
  if (compacting)
    value.afterCompaction ??= {
      reportId: usage?.reportId,
      updatedAt: usage?.updatedAt,
      native: acceptedNative,
    };
  else if (
    value.afterCompaction &&
    usage?.state !== "pending" &&
    usage?.state !== "stale" &&
    ((usage?.reportId !== undefined &&
      (value.afterCompaction.reportId === undefined ||
        usage.reportId > value.afterCompaction.reportId)) ||
      (usage?.reportId === undefined &&
        acceptedNative !== undefined &&
        acceptedNative !== value.afterCompaction.native &&
        acceptedNative.updatedAt !== value.afterCompaction.updatedAt))
  )
    value.afterCompaction = undefined;
  const state = compacting
    ? "pending"
    : (!online && authorized) || (percent !== undefined && value.afterCompaction !== undefined)
      ? "stale"
      : usage?.state === "ready" && percent === undefined
        ? "unavailable"
        : (usage?.state ?? (percent === undefined ? "unavailable" : "ready"));
  return { usage, percent, state, compacting };
}

export function ContextUsageDetails({
  usage,
  percent,
  state,
  compacting,
  locale,
  online,
}: ReturnType<typeof useContextUsage> & { locale: Locale; online: boolean }) {
  const copy = contextUsageCopy[locale];
  const message = compacting
    ? copy.compactingDetail
    : !online && usage?.reason !== "permission_denied" && usage?.reason !== "permission-denied"
      ? copy.offline
      : (contextUsageReason(locale, usage?.reason) ??
        (state === "pending"
          ? copy.pendingDetail
          : state === "stale"
            ? copy.staleDetail
            : codexCopy[locale].contextUnknown));
  return (
    <div className="space-y-2 text-sm">
      {state !== "ready" && <p role="status">{message}</p>}
      {percent !== undefined && (
        <div className="space-y-2">
          <p>
            {`${state === "ready" ? copy.recentNativeReport : copy.reported}: `}
            {usage!.usedTokens!.toLocaleString()} / {usage!.contextWindow!.toLocaleString()} (
            {Math.round(percent)}%)
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ContextUsageGauge({ fallback }: { fallback?: ContextUsage } = {}) {
  const { selected, locale, access, online, usageEpoch } = useSession();
  const scope = `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${usageEpoch ?? ""}`;
  const view = useContextUsage(fallback);
  return <ContextUsageIndicator scope={scope} locale={locale} online={online} view={view} />;
}

export function ContextUsageIndicator({
  scope,
  locale,
  online,
  view,
}: {
  scope: string;
  locale: Locale;
  online: boolean;
  view: ReturnType<typeof useObservedContextUsage>;
}) {
  const copy = contextUsageCopy[locale];
  const [opened, setOpened] = useState<string>();
  const title = codexCopy[locale].contextUsage;
  const label = view.compacting
    ? copy.compacting
    : view.state === "ready" && view.percent !== undefined
      ? `${Math.round(view.percent)}%`
      : copy[view.state === "ready" ? "unavailable" : view.state];
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-11 shrink-0 px-2 text-xs"
        aria-label={title}
        title={`${title}: ${view.state === "ready" && view.percent !== undefined ? `${copy.recentNativeReport}: ${view.usage!.usedTokens!.toLocaleString()} / ${view.usage!.contextWindow!.toLocaleString()}` : label}`}
        onClick={() => setOpened(scope)}
      >
        <Gauge size={15} />
        <span>{label}</span>
      </Button>
      {opened === scope && (
        <Dialog
          panel
          title={title}
          closeLabel={codexCopy[locale].close}
          onClose={() => setOpened(undefined)}
        >
          <ContextUsageDetails {...view} locale={locale} online={online} />
        </Dialog>
      )}
    </>
  );
}
