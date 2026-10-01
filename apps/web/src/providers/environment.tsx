import { useNavigate } from "@tanstack/react-router";
import { legacyConnectionLink } from "@/features/connection/legacy-link";
import { resolveWebConnection, type WebConnection } from "@agentkib/web-client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Locale } from "@/i18n";

export interface EnvironmentOptions {
  hosted?: boolean;
  origin?: string;
  connection?: WebConnection;
  initialLocale?: Locale;
  initialTheme?: string;
  disconnect?: () => void;
  address?: string;
}
function useEnvironmentState(initial: EnvironmentOptions) {
  const [connection, setConnection] = useState<WebConnection | undefined>(() =>
    initial.connection
      ? resolveWebConnection(initial.connection)
      : initial.origin
        ? resolveWebConnection(initial.origin)
        : initial.hosted
          ? undefined
          : { type: "same-origin" },
  );
  const navigate = useNavigate();
  const [address, setAddress] = useState(initial.address ?? "");
  const [locale, setLocale] = useState<Locale>(initial.initialLocale ?? "zh-CN");
  const [theme, setTheme] = useState(initial.initialTheme ?? "system");
  const [attempt, setAttempt] = useState(0);
  const hosted = initial.hosted;
  const onDisconnect = initial.disconnect;
  useEffect(() => {
    if (!hosted) return;
    const consumeLegacy = () => {
      const legacy = legacyConnectionLink(location.hash);
      if (!legacy) return;
      // QR links can be opened while the SPA is already running. Drop the old
      // connection before prefilling a new address; consent and pairing still apply.
      setConnection(undefined);
      setAddress(legacy.address);
      setAttempt((n) => n + 1);
      onDisconnect?.();
      history.replaceState(
        null,
        "",
        location.pathname + location.search + (legacy.address ? "#/connect" : "#/"),
      );
      void navigate({ to: legacy.address ? "/connect" : "/", replace: true });
    };
    window.addEventListener("hashchange", consumeLegacy);
    return () => window.removeEventListener("hashchange", consumeLegacy);
  }, [hosted, onDisconnect, navigate]);
  return {
    hosted: initial.hosted ?? false,
    connection,
    origin: connection?.type === "lan-http" ? connection.origin : undefined,
    locale,
    theme,
    attempt,
    address,
    preferences(nextLocale: Locale, nextTheme: string) {
      setLocale(nextLocale);
      setTheme(nextTheme);
    },
    connect(address: string, nextLocale: Locale, nextTheme: string) {
      setLocale(nextLocale);
      setTheme(nextTheme);
      setConnection(resolveWebConnection({ type: "lan-http", origin: address }));
      setAttempt((n) => n + 1);
    },
    disconnect() {
      setConnection(undefined);
      setAttempt((n) => n + 1);
      initial.disconnect?.();
    },
  };
}
const EnvironmentContext = createContext<ReturnType<typeof useEnvironmentState> | null>(null);
export function EnvironmentProvider({
  initial,
  children,
}: {
  initial: EnvironmentOptions;
  children: ReactNode;
}) {
  const value = useEnvironmentState(initial);
  return <EnvironmentContext value={value}>{children}</EnvironmentContext>;
}
export function useEnvironment() {
  const value = useContext(EnvironmentContext);
  if (!value) throw new Error("EnvironmentProvider is missing");
  return value;
}
