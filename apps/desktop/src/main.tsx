import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { QuotaPopover } from "@/features/quota/QuotaPopover";
import { api } from "./core/api";
import { initializeI18n, normalizeLocale } from "./core/i18n";
import { applyPlatformAttribute } from "./core/platform";
import { desktopApi } from "./core/desktop";
import { accentThemePreference, applyAccentTheme, applyTheme, systemTheme } from "./core/theme";
import type { RuntimeInfo } from "./core/types";
import { createAppRouter } from "./router";
import { useAppStore } from "./stores/app-store";
import "./styles.css";

applyPlatformAttribute(desktopApi().platform);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

async function bootstrap() {
  let locale = normalizeLocale(navigator.language);
  let theme = systemTheme();
  let bootstrapRuntime: RuntimeInfo | undefined;
  try {
    bootstrapRuntime = await api.runtime();
    locale = bootstrapRuntime.effective_locale;
    theme = bootstrapRuntime.effective_theme;
  } catch {
    // Keep a usable locale and appearance while the desktop runtime reports its startup error.
  }
  applyTheme(theme);
  applyAccentTheme(accentThemePreference());
  await initializeI18n(locale);
  if (bootstrapRuntime) useAppStore.getState().setRuntime(bootstrapRuntime);
  const surface = new URLSearchParams(window.location.search).get("surface");
  const app =
    surface === "quota-popover" ? <QuotaPopover /> : <RouterProvider router={createAppRouter()} />;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>{app}</AppDialogProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
