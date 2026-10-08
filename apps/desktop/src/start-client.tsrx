import { createRoot } from "octane";
import { StartClient, hydrateStart } from "@octanejs/tanstack-start/client";
import { QuotaPopover } from "@/features/quota/QuotaPopover";
import { RendererProviders } from "@/renderer-providers.tsrx";
import { cachedEffectiveLocale, initializeI18n } from "@/core/i18n";
import { applyPlatformAttribute } from "@/core/platform";
import { desktopApi } from "@/core/desktop";
import "./styles.css";
import {
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  cachedEffectiveTheme,
} from "@/core/theme";

function initializeRenderer() {
  applyPlatformAttribute(desktopApi().platform);
  applyTheme(cachedEffectiveTheme());
  const accentTheme = accentThemePreference();
  applyAccentTheme(accentTheme);
  cacheAccentTheme(accentTheme);
  return initializeI18n(cachedEffectiveLocale(navigator.language));
}

async function hydrateRenderer() {
  await initializeRenderer();
  const surface = new URLSearchParams(window.location.search).get("surface");
  const container = document.getElementById("__app");
  if (!container) throw new Error("AgentKib renderer root is missing");

  if (surface === "quota-popover") {
    createRoot(container).render(
      <RendererProviders>
        <QuotaPopover />
      </RendererProviders>,
    );
    return;
  }

  const router = await hydrateStart();
  createRoot(container).render(<StartClient router={router} />);
}

void hydrateRenderer();
