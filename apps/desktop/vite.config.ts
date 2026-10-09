import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const mcpLatencyTests = [
  "test/mcp-native-scan-snapshot.test.ts",
  "test/mcp-native-import-snapshot.test.ts",
];

const config = {
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    setupFiles: ["./src/test/test-setup.ts"],
    projects: [
      {
        extends: true as const,
        test: {
          name: "desktop",
          exclude: [...configDefaults.exclude, ...mcpLatencyTests],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "mcp-latency",
          include: mcpLatencyTests,
          // Keep wall-clock budgets meaningful without competing test workers.
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.indexOf("/lucide-react/") >= 0) return "icons";
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
