import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const runtime = globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};
const env = runtime.process?.env ?? {};
const platformAdapter = env.TAURI_ENV_PLATFORM || env.VITEST ? "tauri" : "electron";

const config = {
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@platform-api": path.resolve(
        import.meta.dirname,
        `./src/core/platform-api/${platformAdapter}.ts`,
      ),
      "@platform-events": path.resolve(
        import.meta.dirname,
        `./src/core/platform-events/${platformAdapter}.ts`,
      ),
      "@platform-window": path.resolve(
        import.meta.dirname,
        `./src/core/platform-window/${platformAdapter}.ts`,
      ),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  test: { setupFiles: ["./src/test/test-setup.ts"] },
  build: {
    target: env.TAURI_ENV_PLATFORM === "windows" ? "chrome111" : "safari16.4",
    sourcemap: Boolean(env.TAURI_ENV_DEBUG),
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.indexOf("/lucide-react/") >= 0) return "icons";
          if (id.indexOf("/@tauri-apps/") >= 0) return "tauri";
          if (
            ["/react/", "/react-dom/", "/scheduler/", "/i18next/", "/react-i18next/"].some(
              (dependency) => id.indexOf(dependency) >= 0,
            )
          )
            return "framework";
          return undefined;
        },
      },
    },
  },
};

export default defineConfig(config);
