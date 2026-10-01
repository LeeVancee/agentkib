// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { ContinuationCapability } from "@/core/types";
import { useSessionSourceCapability } from "./useSessionSourceCapability";
vi.mock("@/core/api", () => ({ api: { sessionSourceCapability: vi.fn() } }));
afterEach(cleanup);

it("does not enable a newly selected session from an old capability response", async () => {
  let resolveFirst!: (value: ContinuationCapability) => void;
  let resolveSecond!: (value: ContinuationCapability) => void;
  vi.mocked(api.sessionSourceCapability)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
  const { result, rerender } = renderHook(({ id }) => useSessionSourceCapability(id), {
    initialProps: { id: "old" },
  });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(api.sessionSourceCapability).toHaveBeenCalledWith("old"));
  rerender({ id: "new" });
  await waitFor(() => expect(api.sessionSourceCapability).toHaveBeenCalledWith("new"));
  await act(async () => resolveFirst({ status: "supported" }));
  expect(result.current).toBeUndefined();
  await act(async () => resolveSecond({ status: "unsupported", reason: "New format" }));
  await waitFor(() =>
    expect(result.current).toEqual({ status: "unsupported", reason: "New format" }),
  );
});

it("fails closed when the capability RPC is unavailable", async () => {
  vi.mocked(api.sessionSourceCapability).mockRejectedValueOnce(new Error("Runtime disconnected"));
  const { result } = renderHook(() => useSessionSourceCapability("session"));
  await waitFor(() => expect(result.current?.status).toBe("unavailable"));
});

it("rechecks a previously selected session without reusing its old allowed result", async () => {
  vi.mocked(api.sessionSourceCapability)
    .mockReset()
    .mockResolvedValueOnce({ status: "supported" })
    .mockReturnValueOnce(new Promise(() => {}))
    .mockReturnValueOnce(new Promise(() => {}));
  const { result, rerender } = renderHook(({ id }) => useSessionSourceCapability(id), {
    initialProps: { id: "old" },
  });
  await waitFor(() => expect(result.current?.status).toBe("supported"));
  rerender({ id: "new" });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(api.sessionSourceCapability).toHaveBeenCalledTimes(2));
  rerender({ id: "old" });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(api.sessionSourceCapability).toHaveBeenCalledTimes(3));
});
