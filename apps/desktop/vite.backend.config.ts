import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  define: { "import.meta.url": "require('node:url').pathToFileURL(__filename).href" },
  build: {
    target: "node22",
    sourcemap: true,
    minify: false,
    outDir: "dist-electron",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, "electron/backend-entry.ts"),
      formats: ["cjs"],
      fileName: () => "backend.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
