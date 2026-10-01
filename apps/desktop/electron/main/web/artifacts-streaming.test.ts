// @vitest-environment node
import { expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactService } from "./artifacts";

const MiB = 1024 * 1024;
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("bounds aggregate streaming, memory and control latency independently of total file size", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentkib-stream-benchmark-"));
  let artifacts!: ArtifactService;
  const preview = createServer((req, res) => {
    void artifacts.handle(req, res);
  });
  const control = createServer((_req, res) => {
    res.end("control-ok");
  });
  const metrics: {
    fileMiB: number;
    transferredMiB: number;
    seconds: number;
    peakRssDeltaMiB: number;
    controlP95Ms: number;
  }[] = [];
  try {
    const previewOrigin = await listen(preview);
    const appOrigin = await listen(control);
    artifacts = new ArtifactService({
      previewOrigin,
      appOrigin,
      allowHttpLoopback: true,
      authorize: async () => ({ root, epoch: "grant" }),
    });
    const scope = { workspaceId: "project", deviceId: "phone" };
    for (const fileMiB of [512, 8192]) {
      const handle = await open(join(root, "large.mp4"), "w");
      await handle.truncate(fileMiB * MiB); // Sparse fixture: no multi-gigabyte allocation.
      await handle.close();
      const entry = (await artifacts.list(scope)).entries[0];
      const ticket = await artifacts.issueTicket(scope, { artifactId: entry.id });
      await (await fetch(appOrigin)).text();
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      let polling = false;
      const latency: number[] = [];
      const ping = async () => {
        if (polling) return;
        polling = true;
        const start = performance.now();
        try {
          await (await fetch(appOrigin)).text();
          latency.push(performance.now() - start);
        } finally {
          polling = false;
        }
      };
      const monitor = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
        void ping();
      }, 50);
      const start = performance.now();
      let received = 0;
      try {
        // Two concurrent Range readers share the same 2 MiB/s budget.
        await Promise.all(
          [0, 4 * MiB].map(async (offset) => {
            const response = await fetch(ticket.url, {
              headers: { Range: `bytes=${offset}-${offset + 4 * MiB - 1}` },
            });
            expect(response.status).toBe(206);
            const reader = response.body!.getReader();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              received += chunk.value.byteLength;
              peak = Math.max(peak, process.memoryUsage().rss);
            }
          }),
        );
      } finally {
        clearInterval(monitor);
      }
      const seconds = (performance.now() - start) / 1000;
      while (polling) await new Promise((resolve) => setTimeout(resolve, 5));
      latency.sort((a, b) => a - b);
      const result = {
        fileMiB,
        transferredMiB: received / MiB,
        seconds,
        peakRssDeltaMiB: (peak - baseline) / MiB,
        controlP95Ms: latency[Math.floor(latency.length * 0.95)] ?? Infinity,
      };
      metrics.push(result);
      expect(received).toBe(8 * MiB);
      expect(received / seconds).toBeLessThan(2.3 * MiB);
      expect(result.peakRssDeltaMiB).toBeLessThan(128);
      expect(latency.length).toBeGreaterThan(10);
      expect(result.controlP95Ms).toBeLessThan(1000);
    }
    expect(metrics[1].peakRssDeltaMiB).toBeLessThan(metrics[0].peakRssDeltaMiB + 64);
    console.info(
      "Local HTTP streaming benchmark (not an Internet or packet-loss measurement)",
      JSON.stringify(metrics),
    );
    if (process.env.AGENTKIB_STREAM_BENCHMARK_OUTPUT)
      await writeFile(
        process.env.AGENTKIB_STREAM_BENCHMARK_OUTPUT,
        JSON.stringify(
          {
            schemaVersion: 1,
            measuredAt: new Date().toISOString(),
            environment: "local HTTP, sparse files, shared 2 MiB/s output, no packet loss",
            metrics,
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    artifacts?.clear();
    await close(preview);
    await close(control);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
