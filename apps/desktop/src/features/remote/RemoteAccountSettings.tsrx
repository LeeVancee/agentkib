import { useEffect, useRef, useState } from "octane";
import { Button } from "@/components/ui/button";
import { desktopApi } from "@/core/desktop";
import { useI18n } from "@/core/useI18n";
import type {
  DesktopAccountStatus,
  DesktopAccountRequest,
} from "../../../electron/main/account/state";
import { remoteAccountCopy } from "./remote-account-copy";
import { requestWebAdmin } from "./web-status";
import { withAsyncCleanup } from "@/lib/utils";

export function RemoteAccountSettings() {
  const { locale } = useI18n();
  const c = remoteAccountCopy[locale];
  const [status, setStatus] = useState<DesktopAccountStatus>();
  const [failed, setFailed] = useState(() => !desktopApi().account);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const locked = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const account = desktopApi().account;
    if (!account) {
      return () => {
        alive.current = false;
      };
    }
    const release = account.onStatus((value) => {
      revision.current += 1;
      if (alive.current) {
        setStatus(value);
        setFailed(false);
      }
    });
    const initial = revision.current;
    void account
      .request({ operation: "status" })
      .then((value) => {
        if (alive.current && initial === revision.current) setStatus(value);
      })
      .catch(() => {
        if (alive.current && initial === revision.current) setFailed(true);
      });
    return () => {
      alive.current = false;
      revision.current += 1;
      release();
    };
  }, []);
  async function run(operation: DesktopAccountRequest["operation"]) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailed(false);
    const requestRevision = ++revision.current;
    await withAsyncCleanup(
      async () => {
        try {
          const next = await desktopApi().account.request({ operation });
          if (alive.current && requestRevision === revision.current) setStatus(next);
          if (operation === "logout" || operation === "claim") {
            await requestWebAdmin({ operation: "status" });
          }
        } catch {
          if (alive.current) setFailed(true);
        }
      },
      () => {
        locked.current = false;
        if (alive.current) setBusy(false);
      },
    );
  }
  const signingIn = status?.phase === "signing-in";
  const signedIn = status?.phase === "signed-in" && Boolean(status.account);
  const errorText = status?.error
    ? ((
        {
          account_secure_storage_unavailable: c.storage,
          account_login_expired: c.expired,
          account_login_required: c.expired,
          account_login_timeout: c.timeout,
          account_device_conflict: c.conflict,
          device_limit: c.limit,
          account_device_limit: c.limit,
          account_remote_logout_unconfirmed: c.revokeFailed,
          account_connection_failed: c.unavailable,
          account_forbidden: c.suspended,
          account_claim_pending: c.claimPending,
          account_profile_refresh_failed: c.profileFailed,
          account_suspended: c.suspended,
        } as Record<string, string>
      )[status.error] ?? c.failed)
    : undefined;
  return (
    <section
      className="space-y-3 border-b px-5 py-4 text-sm"
      aria-labelledby="remote-account-title"
    >
      <h3 id="remote-account-title" className="font-medium">
        {c.title}
      </h3>
      <p className="text-muted-foreground leading-6">{c.intro}</p>
      <p role="status">
        {signingIn
          ? c.signingIn
          : signedIn
            ? status!.account!.username
            : status
              ? c.signedOut
              : failed
                ? c.unavailable
                : c.loading}
      </p>
      {signedIn && (
        <>
          <p>
            {c.quota}: {status!.account!.deviceCount} / {status!.account!.deviceLimit}
          </p>
          <p>
            {c.totp}: {status!.account!.totpEnabled ? c.on : c.off}
          </p>
          {status?.device && (
            <p className="text-muted-foreground leading-6">
              {status.device.ownership === "owned"
                ? c.owned
                : status.device.ownership === "other"
                  ? c.other
                  : c.unclaimed}
            </p>
          )}
        </>
      )}
      {status && !status.secureStorage && <p className="text-destructive">{c.storage}</p>}
      {errorText && (
        <p role="alert" className="text-destructive">
          {errorText}
        </p>
      )}
      {failed && status && (
        <p role="alert" className="text-destructive">
          {c.unavailable}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {signingIn ? (
          <Button variant="outline" disabled={busy} onClick={() => void run("cancel-login")}>
            {c.cancel}
          </Button>
        ) : (
          !signedIn && (
            <Button disabled={busy || !status?.secureStorage} onClick={() => void run("login")}>
              {c.login}
            </Button>
          )
        )}
        {signedIn && (
          <>
            {status?.device?.ownership === "unclaimed" && (
              <Button disabled={busy} onClick={() => void run("claim")}>
                {c.claim}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void run("manage")}>
              {c.manage}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void run("logout")}>
              {c.logout}
            </Button>
          </>
        )}
        {(failed || errorText) && (
          <Button variant="outline" disabled={busy} onClick={() => void run("status")}>
            {c.retry}
          </Button>
        )}
      </div>
      {signedIn && <p className="text-muted-foreground leading-6">{c.logoutHint}</p>}
    </section>
  );
}
