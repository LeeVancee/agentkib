import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type RendererViteConfig, type UserConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);

export const rendererConfig: RendererViteConfig = {
  root: import.meta.dirname,
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    target: "es2022",
    minify: true,
    rolldownOptions: {
      input: path.resolve(import.meta.dirname, "index.html"),
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

export default defineConfig((): UserConfig => {
  // Release jobs also build the renderer and Electron processes separately.
  const target = process.env.AGENTKIB_BUILD_TARGET;
  if (target && target !== "electron" && target !== "renderer")
    throw new Error(`Unknown desktop build target: ${target}`);

  return {
    main:
      target === "renderer"
        ? undefined
        : {
            resolve: {
              // The installer excludes node_modules; bundle the Node entry of ws.
              alias: [{ find: /^ws$/, replacement: require.resolve("ws") }],
            },
            build: {
              target: "node22",
              sourcemap: true,
              minify: false,
              outDir: "dist-electron",
              // Backend workers and staged native modules share this directory.
              emptyOutDir: false,
              externalizeDeps: false,
              lib: {
                entry: path.resolve(import.meta.dirname, "electron/main/index.ts"),
                formats: ["cjs"],
              },
              rolldownOptions: {
                output: { entryFileNames: "main.cjs" },
                external: [
                  "electron",
                  ...builtinModules,
                  ...builtinModules.map((name) => `node:${name}`),
                ],
              },
            },
          },
    preload:
      target === "renderer"
        ? undefined
        : {
            build: {
              target: "node22",
              sourcemap: true,
              minify: false,
              outDir: "dist-electron",
              emptyOutDir: false,
              externalizeDeps: false,
              lib: {
                entry: path.resolve(import.meta.dirname, "electron/preload/index.ts"),
                formats: ["cjs"],
              },
              rolldownOptions: {
                output: { entryFileNames: "preload.cjs" },
                external: [
                  "electron",
                  ...builtinModules,
                  ...builtinModules.map((name) => `node:${name}`),
                ],
              },
            },
          },
    renderer: target === "electron" ? undefined : rendererConfig,
  };
});
