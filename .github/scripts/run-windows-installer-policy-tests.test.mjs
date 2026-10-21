import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isVerifiedLegacyReleaseRetry } from "./run-windows-installer-policy-tests.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const runner = fileURLToPath(new URL("./run-windows-installer-policy-tests.mjs", import.meta.url));
const sourceSha = "a".repeat(40);
const verifiedRetry = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  SHOULD_PUBLISH: "true",
  APP_VERSION: "0.20.1",
  AGENTKIB_REQUESTED_RELEASE_TAG: "v0.20.1",
  AGENTKIB_VALIDATED_RELEASE_TAG: "v0.20.1",
  AGENTKIB_VALIDATED_RELEASE_SHA: sourceSha,
};

test("only verified stable release retries through v0.20.1 qualify for the missing-hook exception", () => {
  for (const version of ["0.0.0", "0.19.999", "0.20.0", "0.20.1"]) {
    const environment = {
      ...verifiedRetry,
      APP_VERSION: version,
      AGENTKIB_REQUESTED_RELEASE_TAG: `v${version}`,
      AGENTKIB_VALIDATED_RELEASE_TAG: `v${version}`,
    };
    assert.equal(isVerifiedLegacyReleaseRetry(environment, version, sourceSha), true, version);
  }
  for (const version of ["0.20.2", "0.21.0", "1.0.0", "0.20.1-beta.1", "0.20.1+build.1"]) {
    const environment = {
      ...verifiedRetry,
      APP_VERSION: version,
      AGENTKIB_REQUESTED_RELEASE_TAG: `v${version}`,
      AGENTKIB_VALIDATED_RELEASE_TAG: `v${version}`,
    };
    assert.equal(isVerifiedLegacyReleaseRetry(environment, version, sourceSha), false, version);
  }
});

test("missing or inconsistent preflight context cannot bypass a missing product hook", () => {
  for (const name of Object.keys(verifiedRetry)) {
    const environment = { ...verifiedRetry };
    delete environment[name];
    assert.equal(isVerifiedLegacyReleaseRetry(environment, "0.20.1", sourceSha), false, name);
  }
  for (const override of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "push" },
    { SHOULD_PUBLISH: "false" },
    { SHOULD_PUBLISH: "TRUE" },
    { AGENTKIB_REQUESTED_RELEASE_TAG: "" },
    { AGENTKIB_REQUESTED_RELEASE_TAG: "main" },
    { AGENTKIB_REQUESTED_RELEASE_TAG: "v0.20.0" },
    { AGENTKIB_VALIDATED_RELEASE_TAG: "v0.20.0" },
    { AGENTKIB_VALIDATED_RELEASE_SHA: "b".repeat(40) },
    { AGENTKIB_VALIDATED_RELEASE_SHA: "not-a-commit" },
    { APP_VERSION: "0.20.0" },
  ]) {
    assert.equal(
      isVerifiedLegacyReleaseRetry({ ...verifiedRetry, ...override }, "0.20.1", sourceSha),
      false,
      JSON.stringify(override),
    );
  }
  assert.equal(isVerifiedLegacyReleaseRetry(verifiedRetry, "0.20.0", sourceSha), false);
  assert.equal(isVerifiedLegacyReleaseRetry(verifiedRetry, "0.20.1", "b".repeat(40)), false);
});

test("malformed or noncanonical release tags never qualify", () => {
  for (const tag of [
    "0.20.1",
    "refs/tags/v0.20.1",
    "v0.20.1\n",
    "v00.20.1",
    "v0.020.1",
    "v0.20.01",
    "v0.20",
    "v0.20.1.0",
    "v-1.20.1",
    "v0.20.1/../../main",
  ]) {
    const version = tag.slice(1);
    assert.equal(
      isVerifiedLegacyReleaseRetry(
        {
          ...verifiedRetry,
          APP_VERSION: version,
          AGENTKIB_REQUESTED_RELEASE_TAG: tag,
          AGENTKIB_VALIDATED_RELEASE_TAG: tag,
        },
        version,
        sourceSha,
      ),
      false,
      tag,
    );
  }
});

test("runner skips only an absent legacy hook and keeps all other missing hooks failing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib legacy policy "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = path.join(directory, "apps/desktop");
  const scripts = path.join(desktop, "scripts");
  await mkdir(scripts, { recursive: true });
  const git = (arguments_) => {
    const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // Reuse only the current checkout's Git identity; the synthetic product files
  // live entirely in the temporary directory and require no commit or checkout.
  await writeFile(
    path.join(directory, ".git"),
    `gitdir: ${git(["rev-parse", "--absolute-git-dir"])}\n`,
  );
  const environment = {
    ...process.env,
    ...verifiedRetry,
    AGENTKIB_SOURCE_ROOT: directory,
    AGENTKIB_VALIDATED_RELEASE_SHA: git(["rev-parse", "HEAD"]),
  };
  delete environment.NODE_TEST_CONTEXT;
  const run = (override = {}) => {
    const result = spawnSync(process.execPath, [runner], {
      cwd: directory,
      env: { ...environment, ...override },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(result.error);
    return result;
  };
  await writeFile(path.join(desktop, "package.json"), JSON.stringify({ version: "0.20.1" }));
  const legacy = run();
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(
    legacy.stdout,
    /Skipping product policy tests for verified legacy release v0\.20\.1/,
  );
  assert.match(legacy.stdout, /real installer smoke and uninstall\/user-data checks still run/);
  for (const override of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { AGENTKIB_REQUESTED_RELEASE_TAG: "" },
    { SHOULD_PUBLISH: "false" },
    { AGENTKIB_VALIDATED_RELEASE_SHA: "b".repeat(40) },
  ]) {
    const rejected = run(override);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Missing tracked Windows installer policy/);
    assert.doesNotMatch(rejected.stdout, /Skipping product policy tests/);
  }
  await writeFile(path.join(desktop, "package.json"), JSON.stringify({ version: "0.20.2" }));
  const future = run({
    APP_VERSION: "0.20.2",
    AGENTKIB_REQUESTED_RELEASE_TAG: "v0.20.2",
    AGENTKIB_VALIDATED_RELEASE_TAG: "v0.20.2",
  });
  assert.notEqual(future.status, 0);
  assert.match(future.stderr, /Missing tracked Windows installer policy/);

  await writeFile(path.join(desktop, "package.json"), JSON.stringify({ version: "0.20.1" }));
  await writeFile(path.join(scripts, "windows-installer.nsh"), "existing product hook");
  const existing = run();
  assert.notEqual(existing.status, 0, "An existing hook must reach native validation");
  assert.doesNotMatch(existing.stdout, /Skipping product policy tests/);
});

test("workflow passes verified release outputs without conditioning the real installer smokes", async () => {
  const workflow = await readFile(
    path.join(repository, ".github/workflows/release-desktop.yml"),
    "utf8",
  );
  const step = workflow.slice(
    workflow.indexOf("      - name: Test native Windows uninstall policy"),
    workflow.indexOf("      - name: Upload Windows installer diagnostics"),
  );
  assert.match(step, /AGENTKIB_REQUESTED_RELEASE_TAG: \$\{\{ inputs\.release_tag \|\| '' \}\}/);
  for (const field of ["TAG", "SHA"]) {
    assert.match(
      step,
      new RegExp(
        `AGENTKIB_VALIDATED_RELEASE_${field}: \\$\\{\\{ needs\\.preflight\\.outputs\\.release_${field.toLowerCase()} \\}\\}`,
      ),
    );
  }
  assert.match(step, /if: runner\.os == 'Windows' && matrix\.arch == 'x64'/);
  assert.match(step, /if: runner\.os == 'Windows' && matrix\.arch == 'arm64-preview'/);
  assert.equal((step.match(/smoke-test-windows-installer\.ps1 -SearchRoot/g) || []).length, 2);
});

test("release preflight resolves tags explicitly instead of accepting a version-named branch", async (t) => {
  const workflow = await readFile(
    path.join(repository, ".github/workflows/release-desktop.yml"),
    "utf8",
  );
  const reference = workflow.match(/tag_sha=\$\(git rev-list -n 1 "([^"]+)"\)/)?.[1];
  assert.ok(reference, "The preflight must validate the selected release tag's commit");
  const tag = "v0.20.1";
  const selectedReference = reference.replace("$release_tag", tag);
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib legacy tag refs "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (arguments_, options = {}) => {
    const result = spawnSync("git", arguments_, { encoding: "utf8", ...options });
    assert.ifError(result.error);
    return result;
  };
  const sha = git(["-C", repository, "rev-parse", "HEAD"]).stdout.trim();
  const commit = git(["-C", repository, "cat-file", "commit", sha]);
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(git(["init", "--bare", directory]).status, 0);
  const inStore = (arguments_, options) => git(["--git-dir", directory, ...arguments_], options);
  // Copy just the existing commit, keeping refs and tag objects private. Mark
  // its shallow boundary explicitly: PR checkouts need not contain its parents.
  const copied = inStore(["hash-object", "-t", "commit", "-w", "--stdin"], {
    input: commit.stdout,
  });
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(copied.stdout.trim(), sha);
  await writeFile(path.join(directory, "shallow"), `${sha}\n`);
  assert.equal(inStore(["update-ref", `refs/heads/${tag}`, sha]).status, 0);
  const branch = inStore(["rev-list", "-n", "1", tag]);
  assert.equal(branch.status, 0, branch.stderr);
  assert.notEqual(inStore(["rev-list", "-n", "1", selectedReference]).status, 0);

  assert.equal(inStore(["update-ref", `refs/tags/${tag}`, sha]).status, 0);
  const lightweight = inStore(["rev-list", "-n", "1", selectedReference]);
  assert.equal(lightweight.status, 0, lightweight.stderr);
  assert.equal(lightweight.stdout.trim(), sha);

  const annotated = inStore(["mktag"], {
    input: `object ${sha}\ntype commit\ntag ${tag}\ntagger AgentKib Test <test@example.invalid> 0 +0000\n\nLegacy annotated tag fixture\n`,
  });
  assert.equal(annotated.status, 0, annotated.stderr);
  assert.equal(inStore(["update-ref", `refs/tags/${tag}`, annotated.stdout.trim()]).status, 0);
  const peeled = inStore(["rev-list", "-n", "1", selectedReference]);
  assert.equal(peeled.status, 0, peeled.stderr);
  assert.equal(peeled.stdout.trim(), sha);
});
