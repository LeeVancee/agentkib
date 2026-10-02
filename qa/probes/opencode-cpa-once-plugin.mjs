// QA-only official custom provider hook. Credentials stay in this process only.
import { makeGuard } from "./opencode-cpa-once-guard.mjs";
export const AgentKibCPAOnce = async () => {
  const contract = process.env.AGENTKIB_QA_ONCE_CONTRACT;
  const apiKey = process.env.AGENTKIB_QA_CPA_API_KEY;
  if (!contract || !apiKey) throw Error("Explicit CPA contract and process-only credential required");
  const fetch = makeGuard(contract, {offline: process.env.AGENTKIB_QA_ONCE_OFFLINE === "1"});
  return {config: async (config) => {
    if (JSON.stringify(config.enabled_providers) !== JSON.stringify(["agentkib-cpa"])) throw Error("Only reviewed CPA provider allowed");
    const provider = config.provider?.["agentkib-cpa"];
    if (!provider || provider.npm !== "@ai-sdk/openai-compatible") throw Error("Reviewed native OpenAI-compatible provider required");
    provider.options = {...provider.options, baseURL: fetch.endpoint.replace(/\/chat\/completions$/, ""), apiKey, fetch};
  }};
};
