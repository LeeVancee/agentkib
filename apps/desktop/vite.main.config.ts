import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    // Resolve ws through its Node entry and bundle it because the installer
    // intentionally excludes node_modules.
    alias: [{ find: /^ws$/, replacement: require.resolve("ws") }],
  },
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
      // `ws` exposes a browser conditional export; Electron's main process needs
      // the Node implementation that provides WebSocketServer.
      external: [
        "electron",
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
});
