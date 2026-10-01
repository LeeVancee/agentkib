import { createHash, randomUUID } from "node:crypto";
import { WebAccessService, type WebAdminRequest, type WebPending } from "./service";

/** A pending request issued by the previous release, retained to exercise legacy grants. */
export function seedLegacyPending(service: WebAccessService, cookie: string) {
  const raw = cookie.slice(cookie.indexOf("=") + 1);
  const hash = createHash("sha256").update(raw).digest("hex");
  const browsers = (service as unknown as { browsers: Map<string, { pending?: WebPending }> })
    .browsers;
  const browser = browsers.get(hash);
  if (!browser) throw new Error("fixture_requires_bootstrap");
  const id = randomUUID();
  browser.pending = {
    id,
    name: "Legacy browser",
    verification: "12345678",
    expiresAt: Date.now() + 300_000,
  };
  return id;
}

export async function approveLegacyBrowser(
  service: WebAccessService,
  cookie: string,
  flags: Partial<Extract<WebAdminRequest, { operation: "approve" }>> = {},
) {
  const id = seedLegacyPending(service, cookie);
  await service.request({ operation: "approve", id, send: false, approve: false, ...flags });
  return id;
}
