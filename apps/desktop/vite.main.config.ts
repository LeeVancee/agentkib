import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    sourcemap: true,
    minify: false,
    outDir: "dist-electron",
    emptyOutDir: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "electron/main/index.ts"),
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external: [
        "electron",
        "electron-updater",
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
});
