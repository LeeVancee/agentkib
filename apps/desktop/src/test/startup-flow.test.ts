import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

describe("desktop startup flow", () => {
  it("renders from cached appearance without awaiting runtimeInfo", () => {
    const source = readFileSync(path.join(desktopRoot, "src/main.tsx"), "utf8");

    expect(source).toContain("cachedEffectiveLocale");
    expect(source).toContain("cachedEffectiveTheme");
    expect(source).not.toContain("await api.runtime()");
  });

  it("registers IPC and starts the Runtime without blocking window creation", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");
    const start = source.indexOf("async function startApplication");
    const end = source.indexOf("function registerApplicationIpc", start);
    const startup = source.slice(start, end);

    expect(startup.indexOf("registerApplicationIpc()")).toBeLessThan(
      startup.indexOf("runtimeHost.start()"),
    );
    expect(startup).toContain("void runtimeHost.start()");
    expect(startup).toContain("await createMainWindow()");
    expect(startup).not.toContain("await runtimeHost.start()");
  });

  it("shows the main window after the Renderer first commits", () => {
    const source = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");
    const rendererCommit = source.indexOf('name === "renderer-first-commit"');
    const showWindow = source.indexOf("mainWindow.show()", rendererCommit);

    expect(rendererCommit).toBeGreaterThan(-1);
    expect(showWindow).toBeGreaterThan(rendererCommit);
  });

  it("only reports the first commit from the main Renderer surface", () => {
    const rendererSource = readFileSync(path.join(desktopRoot, "src/main.tsx"), "utf8");
    const mainSource = readFileSync(path.join(desktopRoot, "electron/main/index.ts"), "utf8");

    expect(rendererSource).toContain('surface !== "quota-popover" && <BenchmarkCommitMarker />');
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
  });

  it("flushes the handshake response before initializing the MCP Hub", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "crates/agentkib-runtime/src/main.rs"),
      "utf8",
    );
    const response = source.indexOf("write_response(&mut stdout, response)?;");
    const hub = source.indexOf("if handshake_succeeded", response);

    expect(response).toBeGreaterThan(-1);
    expect(hub).toBeGreaterThan(response);
  });
});
