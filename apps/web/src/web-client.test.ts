import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, SseParser, WebClient } from "@agentkib/web-client";

const info = {
  protocolVersion: 1,
  transport: "lan",
  capabilities: { read: true, send: true, approve: true },
};
const access = {
  status: "approved",
  csrfToken: "csrf",
  bearerToken: "secret",
  bootId: "boot",
  experimentalEnabled: true,
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WebClient transport boundaries", () => {
  it("explicit connection types preserve transport boundaries and legacy construction", async () => {
    const sameOrigin = vi.fn().mockResolvedValue(json(access));
    const local = new WebClient(sameOrigin, { type: "same-origin" });
    await local.access();
    expect(local.origin).toBe("");
    expect(sameOrigin).toHaveBeenCalledWith(
      "/api/web/v1/access",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const lan = vi.fn().mockResolvedValueOnce(json(info)).mockResolvedValueOnce(json(access));
    const remote = new WebClient(lan, { type: "lan-http", origin: "http://192.168.1.10:1422" });
    await remote.access();
    expect(remote.connection.type).toBe("lan-http");
    expect(lan).toHaveBeenCalledWith(
      "http://192.168.1.10:1422/api/web/v1/access",
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(new WebClient(undefined, remote.origin).connection).toEqual(remote.connection);
    expect(new WebClient().connection).toEqual({ type: "same-origin" });
    expect(
      () => new WebClient(undefined, { type: "lan-http", origin: "https://public.example" }),
    ).toThrow("invalid_lan_address");
  });

  it("bounds same-origin reads and mutations to 25 seconds and queries a receipt without replay", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const transport = vi.fn().mockResolvedValue(json({ found: false, requestId: "request" }));
    const client = new WebClient(transport);
    await client.receipt("request");
    expect(timeout).toHaveBeenCalledWith(25000);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/api/web/v1/requests/request",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("uses same-origin cookies and CSRF and sends a mutation only once", async () => {
    const transport = vi.fn().mockResolvedValue(json({ accepted: true }));
    const client = new WebClient(transport);
    client.csrfToken = "csrf";

    await client.request("send", { text: "hello" });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/web/v1/send",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf" },
      }),
    );
  });

  it("keeps hosted bearer credentials out of Access and never sends cookies", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ accepted: true }));
    const client = new WebClient(transport, "http://192.168.1.10:1422");

    await expect(client.catalog()).rejects.toMatchObject({ code: "access_ended" });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.access()).resolves.not.toHaveProperty("bearerToken");
    await client.request("send", { text: "hello" });

    expect(transport.mock.calls[2][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
      },
    });
  });

  it("does not access or control an incompatible hosted backend", async () => {
    const transport = vi.fn().mockResolvedValue(json({ ...info, protocolVersion: 2 }));
    const client = new WebClient(transport, "http://10.0.0.1:1422");

    await expect(client.access()).rejects.toMatchObject({ code: "incompatible_protocol" });
    await expect(client.request("send", {})).rejects.toBeInstanceOf(ApiError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["not-dispatched", "unknown", undefined, "invalid"])(
    "preserves only recognized mutation outcome %s",
    async (controlOutcome) => {
      const client = new WebClient(
        vi.fn().mockResolvedValue(json({ code: "permission_denied", controlOutcome }, 403)),
      );

      await expect(client.request("send", {})).rejects.toMatchObject({
        code: "permission_denied",
        controlOutcome: controlOutcome === "invalid" ? undefined : controlOutcome,
      });
    },
  );
});

describe("hosted SSE", () => {
  it("parses CRLF, multiline data and arbitrary network chunks", () => {
    const emit = vi.fn();
    const parser = new SseParser(emit);
    for (const chunk of ["event: snap", "shot\r\ndata: {\r\n", "data: }\r\n\r", "\n"])
      parser.push(chunk);
    expect(emit).toHaveBeenCalledExactlyOnceWith("snapshot", "{\n}");
  });

  it("decodes split UTF-8 records and retries only the stream", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode('event: snapshot\r\ndata: {"status":"空闲"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3)
          controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
      },
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(json({}, 401));
    const client = new WebClient(transport, "http://10.0.0.1:1422");
    await client.access();
    const event = vi.fn();
    const open = vi.fn();
    const error = vi.fn();

    const close = client.stream("session", { event, open, error });
    await vi.advanceTimersByTimeAsync(0);
    expect(event).toHaveBeenCalledWith("snapshot", '{"status":"空闲"}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(event).toHaveBeenCalledWith("access-ended", "");
    expect(transport).toHaveBeenCalledTimes(4);

    close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport).toHaveBeenCalledTimes(4);
  });
});

describe("attachment upload transport", () => {
  it("uploads binary with CSRF, reports progress and returns only the attachment handle", async () => {
    let xhr!: FakeUpload;
    class FakeUpload {
      timeout = 0;
      withCredentials = false;
      status = 201;
      responseText = JSON.stringify({
        id: "a",
        name: "a.png",
        mime: "image/png",
        size: 3,
        version: "v",
      });
      upload: {
        onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
      } = {};
      onload?: () => void;
      onerror?: () => void;
      ontimeout?: () => void;
      onabort?: () => void;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      abort = vi.fn(() => this.onabort?.());
      constructor() {
        xhr = this;
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeUpload);
    const client = new WebClient();
    client.csrfToken = "csrf";
    const progress = vi.fn();
    const file = new File(["abc"], "a.png", { type: "image/png" });
    const pending = client.uploadAttachment("session", file, progress);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-CSRF-Token", "csrf");
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    expect(progress).toHaveBeenCalledWith(50);
    xhr.onload?.();
    await expect(pending).resolves.toMatchObject({ id: "a", version: "v" });
    vi.unstubAllGlobals();
  });
  it("fails closed for an unpaired LAN client before creating a transfer", async () => {
    const constructor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", constructor);
    const client = new WebClient(undefined, {
      type: "lan-http",
      origin: "http://192.168.1.10:1422",
    });
    await expect(
      client.uploadAttachment("session", new File(["a"], "a.txt"), vi.fn()),
    ).rejects.toMatchObject({ code: "access_ended" });
    expect(constructor).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

it("preserves native goal intent and explicit null budget over the existing one-shot mutation transport", async () => {
  const transport = vi.fn().mockResolvedValue(json({ accepted: true }));
  const client = new WebClient(transport);
  client.csrfToken = "csrf";
  const body = {
    bootId: "boot",
    requestId: "goal-update",
    sessionId: "s",
    expectedRevision: 2,
    objective: "Revise goal",
    intent: "update" as const,
    tokenBudget: null,
  };
  await client.codexAction("goal-set", body);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith(
    "/api/web/v1/codex/goal-set",
    expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
  );
});
