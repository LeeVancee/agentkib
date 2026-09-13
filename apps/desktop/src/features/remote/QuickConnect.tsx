import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Monitor, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/useI18n";
import { useRemoteStore } from "./remote-store";

export function QuickConnect({ now, onDone }: { now: number; onDone: () => void }) {
  const { tr } = useI18n();
  const { snapshot, pairing, busy, run } = useRemoteStore();
  const pending = Boolean(
    pairing &&
    pairing.expires_at * 1000 > now &&
    (!snapshot?.connections.find((h) => h.id === pairing.id) ||
      snapshot.connections.find((h) => h.id === pairing.id)?.status === "pending"),
  );
  const [step, setStep] = useState<"list" | "pair" | "result">(pending ? "result" : "list");
  const [target, setTarget] = useState<{ name: string; address: string } | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const discoveredOnce = useRef(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const discover = useCallback(async () => {
    if (locked.current || useRemoteStore.getState().busy) return;
    locked.current = true;
    setSearching(true);
    try {
      await run({ operation: "discover" });
    } finally {
      locked.current = false;
      if (mounted.current) setSearching(false);
    }
  }, [run]);
  useEffect(() => {
    if (step === "list" && !busy && !discoveredOnce.current) {
      discoveredOnce.current = true;
      void discover();
    }
  }, [step, busy, discover]); // One discovery per mounted opening, including under StrictMode.
  useEffect(() => {
    if (step === "list") {
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>("button");
      const previous = Array.from(buttons ?? []).find(
        (button) => button.dataset.focusKey === returnFocus.current && !button.disabled,
      );
      (previous ?? Array.from(buttons ?? []).find((button) => !button.disabled))?.focus();
    } else root.current?.querySelector<HTMLElement>("input, [data-step-heading]")?.focus();
  }, [step]);
  const host = snapshot?.connections.find((h) => h.id === (connectedId ?? pairing?.id));
  const online = host?.status === "online";
  const expired = pairing && pairing.expires_at * 1000 <= now;
  const disabled = busy || submitting || searching;
  return (
    <div ref={root} className="min-h-0 space-y-4">
      {step !== "list" && (
        <Button
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() => {
            setCode("");
            setStep("list");
          }}
        >
          <ArrowLeft size={16} />
          {tr("remote.quick.back")}
        </Button>
      )}
      {step === "list" && (
        <>
          {!!snapshot?.connections.length && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{tr("remote.quick.saved")}</h3>
              {snapshot.connections.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <Monitor size={18} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{item.name}</p>
                    <p className="break-all text-xs text-muted-foreground">{item.address}</p>
                    <p className="text-xs text-muted-foreground">
                      {tr(`remote.state.${item.status}`)}
                    </p>
                  </div>
                  {![
                    "online",
                    "pending",
                    "revoked",
                    "identity-changed",
                    "expired",
                    "rejected",
                  ].includes(item.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-focus-key={`connect:${item.id}`}
                      disabled={disabled}
                      onClick={async (event) => {
                        if (locked.current) return;
                        returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                        locked.current = true;
                        setSubmitting(true);
                        try {
                          const result = await run({ operation: "connect", id: item.id });
                          if (
                            mounted.current &&
                            result &&
                            "local" in result &&
                            result.connections.some(
                              (h) => h.id === item.id && h.status === "online",
                            )
                          ) {
                            setConnectedId(item.id);
                            setStep("result");
                          }
                        } finally {
                          locked.current = false;
                          if (mounted.current) setSubmitting(false);
                        }
                      }}
                    >
                      {tr("remote.connect")}
                    </Button>
                  )}
                </div>
              ))}
            </section>
          )}
          {pending && (
            <Button
              variant="outline"
              data-focus-key="resume"
              onClick={(event) => {
                returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                setConnectedId(null);
                setStep("result");
              }}
            >
              {tr("remote.quick.resume")}
            </Button>
          )}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{tr("remote.nearby")}</h3>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void discover()}>
                <RefreshCw size={14} />
                {tr("remote.quick.searchAgain")}
              </Button>
            </div>
            {searching ? (
              <p role="status" className="py-3 text-sm text-muted-foreground">
                {tr("remote.quick.searching")}
              </p>
            ) : (
              <>
                {!snapshot?.discovered.filter(
                  (h) => !snapshot.connections.some((saved) => saved.id === h.id),
                ).length && (
                  <p className="py-3 text-sm text-muted-foreground">{tr("remote.quick.empty")}</p>
                )}
                {snapshot?.discovered
                  .filter((h) => !snapshot.connections.some((saved) => saved.id === h.id))
                  .map((item) => (
                    <Button
                      variant="outline"
                      size="content"
                      key={item.id}
                      data-focus-key={`discover:${item.id}`}
                      disabled={disabled || pending}
                      className="flex w-full items-center justify-start gap-3 whitespace-normal rounded-lg p-3 text-left"
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
                        setTarget(item);
                        setAddress(item.address);
                        setCode("");
                        setStep("pair");
                      }}
                    >
                      <Monitor size={18} className="shrink-0" />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">{item.name}</span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {item.address}
                        </span>
                      </span>
                    </Button>
                  ))}
              </>
            )}
          </section>
          <Button
            variant="outline"
            data-focus-key="manual"
            disabled={disabled || pending}
            onClick={(event) => {
              returnFocus.current = event.currentTarget.dataset.focusKey ?? "";
              setTarget(null);
              setAddress("");
              setCode("");
              setStep("pair");
            }}
          >
            {tr("remote.quick.manual")}
          </Button>
        </>
      )}
      {step === "pair" && (
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (locked.current || disabled || pending || !address.trim() || !/^\d{8}$/.test(code))
              return;
            locked.current = true;
            setSubmitting(true);
            try {
              const result = await run({ operation: "pair", address: address.trim(), code });
              if (mounted.current && result) {
                setCode("");
                setConnectedId(null);
                setStep("result");
              }
            } finally {
              locked.current = false;
              if (mounted.current) setSubmitting(false);
            }
          }}
        >
          {target ? (
            <div>
              <p className="break-words font-medium">{target.name}</p>
              <p className="break-all text-sm text-muted-foreground">{target.address}</p>
            </div>
          ) : (
            <label className="grid gap-2 text-sm">
              {tr("remote.address")}
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="192.168.1.20:43123"
                autoComplete="off"
                disabled={disabled}
              />
            </label>
          )}
          <label className="grid gap-2 text-sm">
            {tr("remote.code")}
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              maxLength={8}
              autoComplete="off"
              disabled={disabled}
              aria-describedby="quick-code-hint"
            />
          </label>
          <p id="quick-code-hint" className="text-sm text-muted-foreground">
            {tr("remote.quick.codeHint")}
          </p>
          <Button
            type="submit"
            disabled={disabled || pending || !address.trim() || !/^\d{8}$/.test(code)}
          >
            {tr(submitting ? "remote.quick.submitting" : "remote.pair")}
          </Button>
        </form>
      )}
      {step === "result" && (
        <div className="space-y-3" role="status">
          <p data-step-heading tabIndex={-1} className="font-medium">
            {online
              ? tr("remote.quick.connected")
              : host && host.status !== "pending"
                ? tr(`remote.state.${host.status}`)
                : expired
                  ? tr("remote.expired")
                  : tr("remote.waitApproval")}
          </p>
          {!online && (!host || host.status === "pending") && !expired && pairing && (
            <>
              <strong className="block font-mono text-2xl tracking-widest">
                {pairing.verification}
              </strong>
              <p className="text-sm text-muted-foreground">{tr("remote.compare")}</p>
            </>
          )}
          {online && <Button onClick={onDone}>{tr("remote.quick.done")}</Button>}
        </div>
      )}
    </div>
  );
}
