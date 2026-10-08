import { useEffect, useRef, useState } from "react";
import type { HistorySearchStatus } from "@agentkib/web-client";
import { historyCopy } from "@agentkib/conversation-ui/features/history/history-copy";
import { HistoryCoverageStatus } from "@agentkib/conversation-ui/features/history/history-search";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsNotice } from "./components/SettingsLayout";
export function HistorySearchSettings() {
  const { locale } = useI18n();
  const c = historyCopy[locale];
  const [client] = useState(createDesktopConversationClient);
  const [status, setStatus] = useState<HistorySearchStatus>();
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const reads = useRef(new Set<AbortController>());
  useEffect(() => {
    if (!hasDesktopConversation()) return;
    mounted.current = true;
    const generation = epoch.current;
    const abort = new AbortController();
    const pending = reads.current;
    pending.add(abort);
    void client
      .access(abort.signal)
      .then(async (access) => {
        if (!access.historySearch || abort.signal.aborted || generation !== epoch.current) return;
        setSupported(true);
        const value = await client.historyStatus(abort.signal);
        if (!abort.signal.aborted && generation === epoch.current) setStatus(value);
      })
      .catch(() => {
        if (!abort.signal.aborted && generation === epoch.current) setError(true);
      })
      .finally(() => pending.delete(abort));
    return () => {
      mounted.current = false;
      epoch.current++;
      for (const read of pending) read.abort();
      pending.clear();
    };
  }, [client]);
  useEffect(() => {
    if (!supported || !status?.enabled || busy) return;
    const generation = epoch.current;
    const abort = new AbortController();
    const pending = reads.current;
    pending.add(abort);
    let checking = false;
    const timer = setInterval(() => {
      if (checking || mutating.current || abort.signal.aborted) return;
      checking = true;
      void client
        .historyStatus(abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && generation === epoch.current) setStatus(value);
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 5000);
    return () => {
      abort.abort();
      pending.delete(abort);
      clearInterval(timer);
    };
  }, [client, supported, status?.enabled, busy]);
  async function run(operation: "toggle" | "clear" | "rebuild") {
    if (mutating.current) return;
    mutating.current = true;
    const generation = ++epoch.current;
    for (const read of reads.current) read.abort();
    reads.current.clear();
    setBusy(true);
    setError(false);
    try {
      const value =
        operation === "toggle"
          ? await client.historyConfigure(!status?.enabled)
          : operation === "clear"
            ? await client.historyClear()
            : await client.historyRebuild();
      if (mounted.current && generation === epoch.current) setStatus(value);
    } catch {
      if (mounted.current && generation === epoch.current) setError(true);
    } finally {
      mutating.current = false;
      if (mounted.current && generation === epoch.current) setBusy(false);
    }
  }
  if (!supported) return null;
  return (
    <SettingsSection title={c.settings}>
      <p className="text-sm text-muted-foreground">{c.settingsInfo}</p>
      {status && (
        <>
          <HistoryCoverageStatus status={status} locale={locale} />
          <p className="text-xs text-muted-foreground">
            {Math.ceil(status.bytes / 1024)} / {Math.ceil(status.limitBytes / 1024)} KiB
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !status} onClick={() => void run("toggle")}>
          {status?.enabled ? c.disable : c.enable}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run("clear")}>
          {c.clear}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !status?.enabled}
          onClick={() => void run("rebuild")}
        >
          {c.rebuild}
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-xs">
          {c.loading}
        </p>
      )}
      {error && (
        <SettingsNotice tone="error" role="alert">
          {c.error}
        </SettingsNotice>
      )}
    </SettingsSection>
  );
}
