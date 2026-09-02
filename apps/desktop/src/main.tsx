/** @jsxImportSource octane */

import { useLayoutEffect } from "octane";
import { createRoot } from "octane";
import { QueryClient, QueryClientProvider } from "@octanejs/tanstack-query";
import { RouterProvider } from "@octanejs/tanstack-router";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { QuotaPopover } from "@/features/quota/QuotaPopover";
import { cachedEffectiveLocale, initializeI18n } from "./core/i18n";
import { applyPlatformAttribute } from "./core/platform";
import { desktopApi } from "./core/desktop";
import {
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cachedEffectiveTheme,
} from "./core/theme";
import { createAppRouter } from "./router";
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

function BenchmarkCommitMarker() {
  useLayoutEffect(() => {
    void desktopApi()
      .benchmark.mark("renderer-first-commit")
      .catch(() => undefined);
  }, []);
  return null;
}

async function bootstrap() {
  const locale = cachedEffectiveLocale(navigator.language);
  applyTheme(cachedEffectiveTheme());
  applyAccentTheme(accentThemePreference());
  await initializeI18n(locale);
  const surface = new URLSearchParams(window.location.search).get("surface");
  const app =
    surface === "quota-popover" ? <QuotaPopover /> : <RouterProvider router={createAppRouter()} />;
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      {surface !== "quota-popover" && <BenchmarkCommitMarker />}
      <AppDialogProvider>{app}</AppDialogProvider>
    </QueryClientProvider>,
  );
}

void bootstrap();
