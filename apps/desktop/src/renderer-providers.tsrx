import { QueryClient, QueryClientProvider } from "@octanejs/tanstack-query";
import { useLayoutEffect } from "octane";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { desktopApi } from "@/core/desktop";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export function BenchmarkCommitMarker() {
  useLayoutEffect(() => {
    void desktopApi()
      .benchmark.mark("renderer-first-commit")
      .catch(() => undefined);
  }, []);
  return null;
}

export function RendererProviders({ children }: { children: unknown }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppDialogProvider>{children}</AppDialogProvider>
    </QueryClientProvider>
  );
}
