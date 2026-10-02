// Load this local plugin only in an isolated acceptance config. No credentials.
import { makeGuard } from "./opencode-once-guard.mjs";

export const AgentKibOnce = async () => {
  const contractFile = process.env.AGENTKIB_QA_ONCE_CONTRACT;
  if (!contractFile) throw new Error("QA once contract required");
  const fetch = makeGuard(contractFile, { offline: process.env.AGENTKIB_QA_ONCE_OFFLINE === "1" });
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider.opencode ??= {};
      config.provider.opencode.options = {
        ...config.provider.opencode.options,
        baseURL: fetch.endpoint.replace(/\/chat\/completions$/, ""),
        fetch,
      };
    },
  };
};
