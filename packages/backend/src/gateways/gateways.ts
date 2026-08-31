import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { backendError } from "../contracts.js";
export const Gateway = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  base_url: z.string().url(),
  enabled: z.boolean().default(true),
  token: z.string().optional(),
});
export const GatewayConfig = z.object({
  schema_version: z.number().int().default(1),
  gateways: z.array(Gateway).default([]),
});
export type Gateway = z.infer<typeof Gateway>;
export type GatewayConfig = z.infer<typeof GatewayConfig>;
export function validateGatewayUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw backendError("VALIDATION", "Gateway URL is invalid");
  return url;
}
export function maskGateway(gateway: Gateway): Gateway {
  return gateway.token ? { ...gateway, token: "[REDACTED]" } : gateway;
}
export async function loadGatewayConfig(file: string): Promise<GatewayConfig> {
  try {
    const config = GatewayConfig.parse(JSON.parse(await readFile(file, "utf8")));
    config.gateways.forEach((item) => validateGatewayUrl(item.base_url));
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return GatewayConfig.parse({});
    if (error instanceof Error && error.name === "BackendError") throw error;
    throw backendError("VALIDATION", "Gateway config is invalid");
  }
}
export async function saveGatewayConfig(file: string, config: GatewayConfig): Promise<void> {
  const parsed = GatewayConfig.parse(config);
  parsed.gateways.forEach((item) => validateGatewayUrl(item.base_url));
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function listGateways(file: string): Promise<Gateway[]> {
  return (await loadGatewayConfig(file)).gateways.map(maskGateway);
}
