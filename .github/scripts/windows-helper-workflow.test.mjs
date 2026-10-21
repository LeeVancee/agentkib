import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("both Windows architectures bound helper concurrency without dropping fixtures or gates", async () => {
  const workflow = await readFile(new URL("../workflows/windows-x64.yml", import.meta.url), "utf8");
  const jobs = workflow.split(/^  (?=typecheck(?:-arm64)?:$)/m).slice(1);
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    const helper = job.slice(
      job.indexOf("      - name: Test release helpers and Windows uninstall observation"),
      job.indexOf("      - name: Test native Windows uninstall policy"),
    );
    assert.match(
      helper,
      /^        run: node --test --test-concurrency=1 \.github\/scripts\/\*\.test\.mjs$/m,
    );
    assert.doesNotMatch(
      helper,
      /continue-on-error|test-name-pattern|test-skip-pattern|\|\||retry/i,
    );
    assert.match(job, /run: node \.github\/scripts\/run-windows-installer-policy-tests\.mjs/);
    assert.match(job, /run: pnpm typecheck/);
    assert.match(job, /run: pnpm test:backend:stability --maxWorkers=2 --testTimeout=15000/);
  }
});
