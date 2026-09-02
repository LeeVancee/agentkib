import { defineConfig } from "vite";
import { octane } from "@octanejs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const config = {
  plugins: [octane({ requireDirective: true }), tailwindcss()],
  resolve: {
    conditions: ["module", "browser", "default"],
    extensions: [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", ".tsrx"],
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      extend: path.resolve(import.meta.dirname, "./src/vendor/extend.ts"),
      "style-to-js": path.resolve(import.meta.dirname, "./src/vendor/style-to-js.ts"),
      "void-elements": path.resolve(import.meta.dirname, "./src/vendor/void-elements.ts"),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    setupFiles: ["./src/test/test-setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx,tsrx}"],
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.indexOf("/@octanejs/lucide/") >= 0) return "icons";
          if (id.indexOf("/octane/") >= 0 || id.indexOf("/i18next/") >= 0) return "framework";
          return undefined;
        },
      },
    },
  },
};

export default defineConfig(config);
