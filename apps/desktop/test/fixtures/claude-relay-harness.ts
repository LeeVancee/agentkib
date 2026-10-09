import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest, type Server as HttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type Server } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
  RelayManager,
  buildFrpcConfig,
  validateCertificate,
  validateRegistration,
  type Registration,
} from "../../electron/main/web/relay/manager";

export const claudeRelayEnabled = process.env.AGENTKIB_TEST_CLAUDE_RELAY === "1";

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });

async function freePort() {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function certificate(directory: string, name: string, hosts: string[]) {
  const keyFile = join(directory, `${name}.key`);
  const certFile = join(directory, `${name}.crt`);
  const configFile = join(directory, `${name}.conf`);
  await writeFile(
    configFile,
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${hosts[0]}\n[ext]\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-x509",
      "-days",
      "1",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-config",
      configFile,
    ],
    { stdio: "ignore" },
  );
  return {
    keyFile,
    certFile,
    key: await readFile(keyFile, "utf8"),
    cert: await readFile(certFile, "utf8"),
  };
}

// Only provisioning is seeded: real broker registration/lease, temporary certificates,
// and random loopback ports replace public DNS/ACME/port 443. No production owner,
// authorization, TLS proxy, or backend execution method is replaced or mocked.
type ProvisionedRelay = {
  registration: Registration;
  key: string;
  certificate: string;
  abort: AbortController;
  generation: number;
  enabled: boolean;
  leaseUntil: number;
  wallLeaseUntil: number;
  probeToken: string;
  servers: Map<"control" | "preview", HttpsServer>;
  startTls(channel: "control", generation: number): Promise<void>;
};

export async function startClaudeRelay(directory: string, targetPort: number) {
  const backendRoot = process.env.AGENTKIB_TEST_BACKEND_ROOT;
  const frpcPath = process.env.AGENTKIB_TEST_FRPC;
  const frpsPath = process.env.AGENTKIB_TEST_FRPS;
  if (!backendRoot || !frpcPath || !frpsPath)
    throw new Error(
      "Claude relay integration requires AGENTKIB_TEST_BACKEND_ROOT and verified AGENTKIB_TEST_FRPC/FRPS binaries",
    );
  for (const binary of [frpcPath, frpsPath])
    if (execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !== "0.68.0")
      throw new Error("Claude relay integration requires frp 0.68.0");
  await mkdir(directory, { recursive: true });
  const source = (path: string) => pathToFileURL(join(backendRoot, "services/relay", path)).href;
  const [{ RelayBroker }, { createHandlers }, { memoryStore }] = await Promise.all([
    import(/* @vite-ignore */ source("src/broker.mjs")),
    import(/* @vite-ignore */ source("src/server.mjs")),
    import(/* @vite-ignore */ source("test/helpers.mjs")),
  ]);
  const broker = await RelayBroker.open(
    {
      controlDomain: "remote.example.com",
      previewDomain: "preview.example.net",
      tunnelHost: "tunnel.example.com",
    },
    {
      store: memoryStore(),
      issueCertificate: async () => {
        throw new Error("Public CA disabled in offline fixture");
      },
    },
  );
  const servers: Server[] = [];
  const sockets = new Set<Duplex>();
  const processes: ChildProcess[] = [];
  const clients = new Set<WebSocket>();
  const logs: string[] = [];
  let manager: RelayManager | undefined;
  const close = async () => {
    for (const client of clients) client.terminate();
    await manager?.stop();
    await Promise.all(
      processes.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        timer.unref();
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            (server as HttpServer).closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    );
  };
  const track = (server: Server) => {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return server;
  };
  try {
    const handlers = createHandlers(broker, {}, new Map(), { trustProxyHeader: false });
    const apiPort = await listen(track(createHttpServer(handlers.api)));
    const pluginPort = await listen(track(createHttpServer(handlers.plugin)));
    const { invitation } = await broker.invite();
    const credential = randomBytes(32).toString("base64url");
    const registration = await fetch(`http://127.0.0.1:${apiPort}/v1/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitation,
        registrationId: randomBytes(24).toString("base64url"),
        credential,
      }),
    });
    if (registration.status !== 201) throw new Error("Real broker registration failed");
    const registered = (await registration.json()) as { deviceId: string };
    const authorization = await fetch(`http://127.0.0.1:${apiPort}/v1/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ deviceId: registered.deviceId }),
    });
    if (!authorization.ok) throw new Error("Real broker lease authorization failed");
    const lease = (await authorization.json()) as Record<string, unknown> & {
      leaseSeconds: number;
    };
    const brokerUrl = "https://broker.example.com";
    const device = validateRegistration({ ...lease, credential }, brokerUrl);
    const inner = await certificate(directory, "device", [device.controlHost, device.previewHost]);
    const outer = await certificate(directory, "transport", [device.tunnelHost]);
    validateCertificate(inner.cert, inner.key, [device.controlHost, device.previewHost]);
    manager = new RelayManager({
      brokerUrl,
      stateDirectory: directory,
      frpcPath,
      target: { host: "127.0.0.1", port: targetPort },
      preview: { host: "127.0.0.1", port: targetPort },
    });
    const provisioned = manager as unknown as ProvisionedRelay;
    Object.assign(provisioned, {
      registration: device,
      key: inner.key,
      certificate: inner.cert,
      abort: new AbortController(),
      generation: 1,
      enabled: true,
      leaseUntil: performance.now() + lease.leaseSeconds * 1000,
      wallLeaseUntil: Date.now() + lease.leaseSeconds * 1000,
    });
    await provisioned.startTls("control", 1);
    const localPort = (provisioned.servers.get("control")!.address() as { port: number }).port;
    const bindPort = await freePort();
    const remotePort = await freePort();
    // Deployment terminates only outer frp WSS here; inner device TLS stays encrypted.
    const edge = createTlsServer({ key: outer.key, cert: outer.cert }, (socket) => {
      const upstream = connect(bindPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const edgePort = await listen(track(edge));
    const q = JSON.stringify;
    await writeFile(
      join(directory, "frps.toml"),
      `bindAddr="127.0.0.1"\nbindPort=${bindPort}\nvhostHTTPSPort=${remotePort}\ntransport.tls.certFile=${q(outer.certFile)}\ntransport.tls.keyFile=${q(outer.keyFile)}\nlog.level="info"\n[[httpPlugins]]\nname="device"\naddr="127.0.0.1:${pluginPort}"\npath="/plugin"\nops=["Login","NewProxy","Ping","NewWorkConn","NewUserConn"]\n`,
    );
    const clientConfig = buildFrpcConfig(device, localPort, outer.certFile)
      .replace(`serverAddr = ${q(device.tunnelHost)}`, 'serverAddr = "127.0.0.1"')
      .replace("serverPort = 443", `serverPort = ${edgePort}`);
    await writeFile(join(directory, "frpc.toml"), clientConfig, { mode: 0o600 });
    for (const [binary, configuration] of [
      [frpsPath, "frps.toml"],
      [frpcPath, "frpc.toml"],
    ]) {
      const child = spawn(binary!, ["-c", join(directory, configuration!)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      processes.push(child);
      child.on("error", (error) => logs.push(error.message));
      for (const stream of [child.stdout, child.stderr])
        stream!.on("data", (chunk: Buffer) => {
          if (logs.length < 30) logs.push(chunk.toString().replaceAll(credential, "[redacted]"));
        });
    }
    const origin = `https://${device.controlHost}`;
    function http(
      path: string,
      body?: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) {
      return new Promise<{ status: number; text: string; cookies?: string[] }>(
        (resolve, reject) => {
          const request = httpsRequest(
            {
              hostname: "127.0.0.1",
              port: remotePort,
              servername: device.controlHost,
              ca: inner.cert,
              agent: false,
              timeout: 5_000,
              path,
              method: body ? "POST" : "GET",
              headers: {
                Host: device.controlHost,
                ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
                ...headers,
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode!,
                  text: Buffer.concat(chunks).toString(),
                  cookies: response.headers["set-cookie"],
                }),
              );
            },
          );
          request.on("error", reject);
          request.on("timeout", () =>
            request.destroy(new Error("Offline relay request timed out")),
          );
          request.end(body ? JSON.stringify(body) : undefined);
        },
      );
    }
    let ready = false;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const result = await http(`/__agentkib_relay_probe/${provisioned.probeToken}`);
        ready = result.status === 200 && result.text === provisioned.probeToken;
        if (ready) break;
      } catch {
        /* Connectors may still be registering; retry only this read-only probe. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Real frp tunnel did not become ready: ${logs.join("\n")}`);
    return {
      origin,
      previewOrigin: `https://${device.previewHost}`,
      http,
      socket(headers: Record<string, string>) {
        const ws = new WebSocket(`wss://127.0.0.1:${remotePort}/api/web/v1/socket`, {
          servername: device.controlHost,
          ca: inner.cert,
          handshakeTimeout: 10_000,
          headers: { Host: device.controlHost, Origin: origin, ...headers },
        });
        clients.add(ws);
        ws.on("error", () => {});
        ws.once("close", () => clients.delete(ws));
        return ws;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
