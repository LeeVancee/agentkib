import { ShieldAlert } from "lucide-react";
import type { LivePermission } from "@agentkib/web-client";
import type { Locale } from "../../i18n";
import { cn } from "../../lib/utils";
import { permissionModeCopy } from "./permission-mode-copy";

/**
 * Tells the user when a Claude session runs where actions are no longer approved one by one
 * (auto, dontAsk, bypassPermissions), or when the mode is unknown on a CLI that may start in
 * auto. It carries text and an icon, never color alone, and only informs: it never blocks sending.
 * `default`, `plan`, `acceptEdits` and an unknown mode without a hint render nothing.
 */
export function PermissionModeNotice({
  permission,
  locale,
}: {
  permission?: LivePermission | null;
  locale: Locale;
}) {
  if (!permission) return null;
  const copy = permissionModeCopy[locale];
  const { mode } = permission;
  const message =
    mode === "auto" || mode === "dontAsk" || mode === "bypassPermissions"
      ? copy[mode]
      : mode === null && permission.possiblyAuto === true
        ? copy.possiblyAuto
        : undefined;
  if (!message) return null;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5",
        mode === "bypassPermissions"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300",
      )}
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        {message}
        {mode !== null && permission.previous === true && (
          <span className="mt-1 block opacity-80">{copy.previous}</span>
        )}
      </span>
    </p>
  );
}
