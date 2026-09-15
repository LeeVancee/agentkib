import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Explicit, local QA only: never inherit this capability from saved settings or browser input. */
export function acceptanceSession(env: NodeJS.ProcessEnv): string | undefined {
  const id = env.AGENTKIB_WEB_ACCEPTANCE_SESSION;
  if (!id) return undefined;
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_web_acceptance_session");
  const user = realpathSync(env.AGENTKIB_BENCHMARK_USER_DATA ?? "");
  const runtime = realpathSync(env.AGENTKIB_BENCHMARK_DATA_DIR ?? "");
  const root = dirname(user);
  if (
    basename(user) !== "electron" ||
    runtime !== join(root, "runtime") ||
    dirname(root) !== realpathSync(tmpdir()) ||
    !basename(root).startsWith("agentkib-web-acceptance-")
  )
    throw new Error("web_acceptance_requires_isolated_temporary_data");
  return id;
}
