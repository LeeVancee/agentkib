// @vitest-environment node
import { createServer, request, Server } from "node:http";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConversationPath } from "./conversation-transport";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { HOSTED_ORIGIN, WebAccessService } from "./service";

const command = {
  available: true,
  command: "verified host command",
  shell: "posix",
  runOn: "host",
};

describe.each(["local", "lan"] as const)(
  "%s read-only Codex resume-command authorization",
  (mode) => {
    let dir: string,
      root: string,
      port: number,
      cookie: string,
      bearer: string,
      csrf: string,
      deviceId: string;
    let service: WebAccessService;
    let registered: { id: string; name: string; path: string }[];
    let sessions: { id: string; workspace_id: string; agent: string; availability: string }[];
    const resume = vi.fn();
    const runtime = vi.fn();
    const managed = vi.fn();
    const endpoint = "/managed/resume-command?sessionId=session";
    async function http(path: string, method = "GET", body?: unknown) {
      return new Promise<{
        status: number;
        data: Record<string, unknown>;
        headers: import("node:http").IncomingHttpHeaders;
      }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method,
            headers: {
              Host: `${mode === "lan" ? "192.168.20.10" : "127.0.0.1"}:${port}`,
              Origin: mode === "lan" ? HOSTED_ORIGIN : `http://127.0.0.1:${port}`,
              ...(cookie ? { Cookie: cookie } : {}),
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "GET" } : {}),
              ...(body === undefined
                ? {}
                : {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": csrf,
                    "X-AgentKib-Protocol": "2",
                  }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                data: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    async function pair() {
      const access = await http("/access");
      csrf = access.data.csrfToken as string;
      if (mode === "local") {
        cookie = access.headers["set-cookie"]![0]!.split(";")[0]!;
        deviceId = await approveLegacyBrowser(service, cookie, {
          send: false,
          approve: false,
          files: false,
          manage: false,
        });
      } else {
        bearer = access.data.bearerToken as string;
        const code = (await service.request({ operation: "generate-code" })).code!.value;
        const response = await http("/pair", "POST", { code, name: "Read-only browser" });
        deviceId = (response.data.pending as { id: string }).id;
        await service.request({ operation: "approve", id: deviceId, send: false, approve: false });
      }
    }
    beforeEach(async () => {
      cookie = bearer = csrf = deviceId = "";
      resume.mockReset().mockResolvedValue({ ...command, privateMetadata: "must not project" });
      managed.mockReset();
      runtime
        .mockReset()
        .mockImplementation(async (input: Record<string, unknown>) =>
          input.operation === "catalog"
            ? { workspaces: registered, sessions }
            : input.operation === "resume-command"
              ? resume(input)
              : {},
        );
      dir = await realpath(await mkdtemp(join(tmpdir(), "agentkib-resume-command-host-")));
      root = join(dir, "project");
      await mkdir(root);
      registered = [{ id: "workspace", name: "Project", path: root }];
      sessions = [
        { id: "session", workspace_id: "workspace", agent: "codex", availability: "readable" },
      ];
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      if (mode === "lan") {
        const original = Server.prototype.listen;
        vi.spyOn(Server.prototype, "listen").mockImplementation(function (
          this: Server,
          ...args: unknown[]
        ) {
          args[1] = "127.0.0.1";
          return Reflect.apply(original, this, args);
        } as typeof original);
      }
      service = new WebAccessService({
        mode: mode === "lan" ? "lan" : undefined,
        dataDir: join(dir, "state"),
        staticDir: root,
        runtimeRequest: runtime,
        managedRequest: managed,
        workspaceRequest: async () => registered,
        addresses: () => [{ name: "fixture", address: "192.168.20.10" }],
      });
      await service.initialize();
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: mode === "lan" ? HOSTED_ORIGIN : "",
        experimentalEnabled: false,
        ...(mode === "lan"
          ? { lanAddress: "192.168.20.10", allowPlaintext: true }
          : { allowedWorkspaceIds: ["workspace"] }),
      });
    });
    afterEach(async () => {
      await service?.shutdown();
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    });

    it("allows a paired read-only browser without files/manage/send or experimental controls", async () => {
      await pair();
      const result = await http(endpoint);
      expect(result).toMatchObject({ status: 200, data: command });
      expect(result.data).toEqual(command);
      expect(resume).toHaveBeenCalledExactlyOnceWith({
        operation: "resume-command",
        sessionId: "session",
      });
      expect((await http("/files/workspaces")).status).toBe(403);
      expect((await http("/managed/options")).status).toBe(403);
      expect(managed).not.toHaveBeenCalled();
    });

    it.each(["unknown", "claude-code", "unreadable", "unregistered"])(
      "rejects %s sessions before reading the command",
      async (reason) => {
        await pair();
        if (reason === "unknown") sessions = [];
        if (reason === "claude-code") sessions[0]!.agent = "claude-code";
        if (reason === "unreadable") sessions[0]!.availability = "unavailable";
        if (reason === "unregistered") registered = [];
        expect((await http(endpoint)).status).toBe(403);
        expect(resume).not.toHaveBeenCalled();
      },
    );

    it.each(["revoke", "rebind", "replace-directory"])(
      "rechecks %s before disclosing the command",
      async (change) => {
        await pair();
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        resume.mockImplementation(async () => {
          entered();
          await gate;
          return command;
        });
        const pending = http(endpoint);
        await started;
        if (change === "revoke") await service.request({ operation: "revoke", id: deviceId });
        if (change === "rebind") registered = [{ ...registered[0]!, path: dir }];
        if (change === "replace-directory") {
          await rename(root, `${root}-old`);
          await mkdir(root);
        }
        release();
        const response = await pending;
        expect([401, 403]).toContain(response.status);
        expect(response.data.command).toBeUndefined();
      },
    );

    it("rejects malformed backend projections through the existing HTTP error path", async () => {
      await pair();
      resume.mockResolvedValue({
        available: true,
        command: "untrusted",
        shell: "cmd",
        runOn: "host",
      });
      expect(await http(endpoint)).toMatchObject({
        status: 503,
        data: { error: "codex_context_unavailable" },
      });
    });

    it("registers only GET and preserves the closed desktop API route", async () => {
      await pair();
      expect(isConversationPath(endpoint, false)).toBe(true);
      expect(isConversationPath(endpoint, true)).toBe(false);
      expect(isConversationPath(`/managed/resume-command-extra?sessionId=session`, false)).toBe(
        false,
      );
      if (mode === "local")
        expect(await service.localRequest(endpoint)).toEqual({ status: 200, body: command });
      else expect((await http(endpoint, "OPTIONS")).status).toBe(204);
    });
  },
);
