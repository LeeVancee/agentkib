import { parseLanOrigin } from "@agentkib/web-client";

/** Undefined means a normal route; an empty address means an invalid legacy link. */
export function legacyConnectionLink(hash: string): { address: string } | undefined {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("connect");
  if (raw === null) return undefined;
  try {
    return { address: parseLanOrigin(raw) };
  } catch {
    return { address: "" };
  }
}
