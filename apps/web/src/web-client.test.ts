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
