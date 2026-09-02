import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Generator, getConfig } from "@tanstack/router-generator";
import { maskOctaneRouteSource } from "@octanejs/tanstack-router/generator-plugin";
import type { Plugin, ResolvedConfig } from "vite";

const routeExtensions = [".tsrx", ".tsx", ".ts", ".jsx", ".js", ".vue"];

function asGeneratorRouteFile(fileName: string) {
  return fileName.endsWith(".tsrx") ? `${fileName.slice(0, -5)}.tsx` : fileName;
}

async function copyRouteTree(sourceDirectory: string, targetDirectory: string) {
  await mkdir(targetDirectory, { recursive: true });
  const entries = await readdir(sourceDirectory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, asGeneratorRouteFile(entry.name));

      if (entry.isDirectory()) {
        await copyRouteTree(sourcePath, targetPath);
        return;
      }

      if (!routeExtensions.some((extension) => entry.name.endsWith(extension))) return;

      const source = await readFile(sourcePath, "utf8");
      const output = entry.name.endsWith(".tsrx")
        ? maskOctaneRouteSource(source, entry.name)
        : source;
      await writeFile(targetPath, output);
    }),
  );
}

async function generateRouteTree(root: string) {
  const sourceRoutes = path.resolve(root, "src/routes");
  const routeTree = path.resolve(root, "src/routeTree.gen.ts");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentkib-octane-routes-"));

  try {
    const tempRoutes = path.join(tempRoot, "routes");
    const tempRouteTree = path.join(tempRoot, "routeTree.gen.ts");
    await copyRouteTree(sourceRoutes, tempRoutes);

    const generator = new Generator({
      root: tempRoot,
      config: getConfig(
        {
          target: "react",
          routesDirectory: tempRoutes,
          generatedRouteTree: tempRouteTree,
          routeFileIgnorePrefix: "-",
          routeToken: "route",
          indexToken: "index",
          quoteStyle: "single",
          semicolons: false,
          disableLogging: true,
          addExtensions: false,
          enableRouteTreeFormatting: true,
        },
        tempRoot,
      ),
    });
    await generator.run();

    const generated = await readFile(tempRouteTree, "utf8");
    await writeFile(
      routeTree,
      generated.replaceAll("@tanstack/react-router", "@octanejs/tanstack-router"),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function octaneRouteGenerator(): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  let generation = Promise.resolve();

  const queueGeneration = () => {
    generation = generation.then(() => generateRouteTree(resolvedConfig!.root));
    return generation;
  };

  return {
    name: "agentkib:octane-route-generator",
    enforce: "pre",
    async configResolved(config) {
      resolvedConfig = config;
      await queueGeneration();
    },
    watchChange(id) {
      if (!resolvedConfig) return;
      const routesDirectory = path.resolve(resolvedConfig.root, "src/routes");
      if (id.startsWith(routesDirectory + path.sep)) void queueGeneration();
    },
  };
}
