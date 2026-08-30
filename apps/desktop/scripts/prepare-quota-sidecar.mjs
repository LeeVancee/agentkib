import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { get } from "node:https";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const releases = {
  "aarch64-apple-darwin": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-macos-arm64.tar.gz",
    sha256: "bdc7469cb37db9354a51b0404e30ba00f12dd548dcdca10e50b283e7af1d370c",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-macos-arm64.tar.gz",
    format: "tar",
  },
  "x86_64-apple-darwin": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-macos-x86_64.tar.gz",
    sha256: "d5006a70e131010cc6ec997633e8e897f106a645dbef363201f15675262ebca4",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-macos-x86_64.tar.gz",
    format: "tar",
  },
  "aarch64-unknown-linux-gnu": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-linux-musl-aarch64.tar.gz",
    sha256: "6486f199d3f176c5d6f981840bf2a97b6d2744e259ec49e37f8f3d1b6b5eac14",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-linux-musl-aarch64.tar.gz",
    format: "linux-tar",
  },
  "x86_64-unknown-linux-gnu": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-linux-musl-x86_64.tar.gz",
    sha256: "87153677de7193dd4d0e1907d9a8412cfc70472ec4d331c83564202237ec7af8",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-linux-musl-x86_64.tar.gz",
    format: "linux-tar",
  },
  "x86_64-pc-windows-msvc": {
    version: "0.48.0",
    asset: "Win-CodexBar-v0.48.0.tar.gz",
    sha256: "67c60ddbc6072df0970e146771232bbe6991f8ae330016b42d37cdeb7129ccee",
    url: "https://codeload.github.com/nesszer/Win-CodexBar/tar.gz/refs/tags/v0.48.0",
    format: "cargo",
  },
};

const windowsArmNsis = {
  asset: "nsis-3.11.zip",
  sha1: "ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d",
  url: "https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download",
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const quotaResourcesDirectory = join(desktopDirectory, "resources/quota/resources");
const quotaBinariesDirectory = join(desktopDirectory, "resources/quota/binaries");
const target =
  process.env.AGENTKIB_QUOTA_TARGET ?? process.env.CARGO_BUILD_TARGET ?? rustHostTriple();
const release = releases[target];

if (process.platform === "win32" && process.arch === "arm64") {
  await prepareWindowsArmNsis();
}

if (!release) {
  if (target.endsWith("-windows-msvc")) {
    await rm(join(quotaResourcesDirectory, "windows/agentkib-quota-sidecar.exe"), {
      force: true,
    });
  }
  process.stdout.write(`AgentKib quota sidecar: ${target} is reserved but not bundled yet.\n`);
  process.exit(0);
}

const cacheRoot = process.env.XDG_CACHE_HOME
  ? resolve(process.env.XDG_CACHE_HOME, "agentkib/codexbar", release.version)
  : process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "AgentKibBuild/cache/quota", release.version)
    : join(homedir(), ".cache/agentkib/codexbar", release.version);
const archive = join(cacheRoot, release.asset);
await mkdir(cacheRoot, { recursive: true });

if (!(await hasExpectedHash(archive, release.sha256))) {
  await rm(archive, { force: true });
  const temporary = `${archive}.download`;
  await rm(temporary, { force: true });
  await download(release.url, temporary);
  if (!(await hasExpectedHash(temporary, release.sha256))) {
    await rm(temporary, { force: true });
    throw new Error(`Quota collector ${release.version} checksum mismatch`);
  }
  await rename(temporary, archive);
}

const extracted = await mkdtemp(join(tmpdir(), "agentkib-codexbar-"));
try {
  if (release.format === "tar" || release.format === "linux-tar") {
    const result = spawnSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Failed to extract CodexBarCLI archive");

    const binaryDirectory = quotaBinariesDirectory;
    const binary = join(binaryDirectory, `agentkib-quota-sidecar-${target}`);
    await mkdir(binaryDirectory, { recursive: true });
    if (release.format === "linux-tar") {
      const resourcesDirectory = join(quotaResourcesDirectory, "linux");
      const resourceBundle = join(resourcesDirectory, "CodexBar_CodexBarCore.bundle");
      const collector = join(resourcesDirectory, "CodexBarCLI");
      await mkdir(resourcesDirectory, { recursive: true });
      await copyFile(join(extracted, "CodexBarCLI"), collector);
      const strip = spawnSync("strip", ["--strip-unneeded", collector], { stdio: "inherit" });
      if (strip.status !== 0) throw new Error("Failed to strip CodexBarCLI debug symbols");
      await chmod(collector, 0o755);
      await rm(resourceBundle, { recursive: true, force: true });
      await cp(join(extracted, "CodexBar_CodexBarCore.bundle"), resourceBundle, {
        recursive: true,
      });
      // The tiny launcher is source-controlled so plain cargo builds do not
      // depend on downloading the large collector archive first.
      await access(binary);
      await chmod(binary, 0o755);
    } else {
      await copyFile(join(extracted, "CodexBarCLI"), binary);
      await chmod(binary, 0o755);

      const resourcesDirectory = quotaResourcesDirectory;
      const resourceBundle = join(resourcesDirectory, "CodexBar_CodexBarCore.bundle");
      await mkdir(resourcesDirectory, { recursive: true });
      await rm(resourceBundle, { recursive: true, force: true });
      await cp(join(extracted, "CodexBar_CodexBarCore.bundle"), resourceBundle, {
        recursive: true,
      });
    }
  } else {
    const sourceDirectory = join(cacheRoot, "source");
    const manifest = join(sourceDirectory, "rust/Cargo.toml");
    try {
      await access(manifest);
    } catch {
      await rm(sourceDirectory, { recursive: true, force: true });
      await mkdir(sourceDirectory, { recursive: true });
      const localArchive = join(sourceDirectory, release.asset);
      await copyFile(archive, localArchive);
      try {
        const unpack = spawnSync("tar", ["-xzf", release.asset, "--strip-components", "1"], {
          cwd: sourceDirectory,
          stdio: "inherit",
        });
        if (unpack.status !== 0)
          throw new Error("Failed to extract the Win-CodexBar source archive");
      } finally {
        await rm(localArchive, { force: true });
      }
    }

    const cargoTargetDirectory = join(cacheRoot, "cargo-target");
    const build = spawnSync(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifest,
        "--bin",
        "codexbar",
        "--target",
        target,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CARGO_TARGET_DIR: cargoTargetDirectory,
        },
      },
    );
    if (build.status !== 0) throw new Error("Failed to build the Win-CodexBar CLI");

    const source = join(cargoTargetDirectory, target, "release/codexbar.exe");
    await access(source);
    const resourceDirectory = join(quotaResourcesDirectory, "windows");
    await mkdir(resourceDirectory, { recursive: true });
    await copyFile(source, join(resourceDirectory, "agentkib-quota-sidecar.exe"));
  }
  process.stdout.write(
    `AgentKib quota sidecar: prepared collector ${release.version} for ${target}.\n`,
  );
} finally {
  await rm(extracted, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function rustHostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to determine Rust host triple");
  const host = result.stdout.match(/^host:\s+(.+)$/m)?.[1]?.trim();
  if (!host) throw new Error("rustc did not report a host triple");
  return host;
}

async function hasExpectedHash(path, expected, algorithm = "sha256") {
  try {
    const digest = createHash(algorithm)
      .update(await readFile(path))
      .digest("hex");
    return digest === expected;
  } catch {
    return false;
  }
}

async function prepareWindowsArmNsis() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;

  const nsisCacheDirectory = resolve(localAppData, "AgentKibBuild/cache/nsis");
  const nsisDirectory = join(nsisCacheDirectory, "NSIS");
  const nativeCompiler = join(nsisDirectory, "Bin/makensis.exe");
  const compilerLauncher = join(nsisDirectory, "makensis.exe");

  try {
    await access(nativeCompiler);
  } catch {
    await mkdir(nsisCacheDirectory, { recursive: true });
    const archivePath = join(nsisCacheDirectory, windowsArmNsis.asset);
    if (!(await hasExpectedHash(archivePath, windowsArmNsis.sha1, "sha1"))) {
      await rm(archivePath, { force: true });
      const temporary = `${archivePath}.download`;
      await rm(temporary, { force: true });
      await download(windowsArmNsis.url, temporary);
      if (!(await hasExpectedHash(temporary, windowsArmNsis.sha1, "sha1"))) {
        await rm(temporary, { force: true });
        throw new Error("NSIS 3.11 checksum mismatch");
      }
      await rename(temporary, archivePath);
    }

    const extracted = await mkdtemp(join(tmpdir(), "agentkib-nsis-"));
    try {
      const unpack = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:AGENTKIB_NSIS_ARCHIVE -DestinationPath $env:AGENTKIB_NSIS_DESTINATION -Force",
        ],
        {
          env: {
            ...process.env,
            AGENTKIB_NSIS_ARCHIVE: archivePath,
            AGENTKIB_NSIS_DESTINATION: extracted,
          },
          stdio: "inherit",
        },
      );
      if (unpack.status !== 0) throw new Error("Failed to extract NSIS 3.11");
      await rm(nsisDirectory, { recursive: true, force: true });
      await cp(join(extracted, "nsis-3.11"), nsisDirectory, { recursive: true });
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  }

  // NSIS ships an x86 dispatcher at the root that cannot launch its child on
  // Windows ARM64. Keep the real compiler in Bin (where it can resolve Stubs and
  // Plugins), and replace only the dispatcher with a tiny host-native launcher.
  const launcherSource = join(scriptDirectory, "windows-nsis-launcher.rs");
  const buildLauncher = spawnSync("rustc", [launcherSource, "-O", "-o", compilerLauncher], {
    stdio: "inherit",
  });
  if (buildLauncher.status !== 0) {
    throw new Error("Failed to build the Windows ARM64 NSIS launcher");
  }
}

async function download(url, destination, redirects = 0) {
  if (redirects > 8) throw new Error("Too many redirects while downloading CodexBarCLI");
  await new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { "User-Agent": "AgentKib-build" } }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        download(
          new URL(response.headers.location, url).toString(),
          destination,
          redirects + 1,
        ).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on("finish", () => output.close(resolveDownload));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
  await access(destination);
}
