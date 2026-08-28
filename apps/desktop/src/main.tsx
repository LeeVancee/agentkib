import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { QuotaPopover } from "@/features/quota/QuotaPopover";
import { api } from "./core/api";
import { initializeI18n, normalizeLocale } from "./core/i18n";
import { applyPlatformAttribute } from "./core/platform";
import { accentThemePreference, applyAccentTheme, applyTheme, systemTheme } from "./core/theme";
import type { RuntimeInfo } from "./core/types";
import { createAppRouter } from "./router";
import { useAppStore } from "./stores/app-store";
import "./styles.css";

applyPlatformAttribute(import.meta.env.TAURI_ENV_PLATFORM ?? window.agentkibDesktop?.platform);

async function bootstrap() {
  let locale = normalizeLocale(navigator.language);
  let theme = systemTheme();
  let bootstrapRuntime: RuntimeInfo | undefined;
  try {
    bootstrapRuntime = await api.runtime();
    locale = bootstrapRuntime.effective_locale;
    theme = bootstrapRuntime.effective_theme;
  } catch {
    // The web preview has no Tauri runtime; the system browser locale remains useful.
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
      <AppDialogProvider>{app}</AppDialogProvider>
    </StrictMode>,
  );
}

void bootstrap();
