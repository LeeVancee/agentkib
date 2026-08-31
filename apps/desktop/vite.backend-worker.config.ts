import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    sourcemap: true,
    minify: false,
    outDir: "dist-electron",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, "electron/backend-worker-entry.ts"),
      formats: ["cjs"],
      fileName: () => "backend-worker.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
