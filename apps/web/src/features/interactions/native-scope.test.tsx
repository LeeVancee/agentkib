import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativeScope } from "./native-scope";
afterEach(cleanup);
it("keeps permission paths and network scope visible while collapsing raw metadata", () => {
  const { container } = render(
    <NativeScope
      locale="en-US"
      value={{
        cwd: "/project",
        grantRoot: "/authorized",
        networkApprovalContext: { host: "example.test", protocol: "https" },
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/read"],
            write: ["/write"],
            entries: [{ access: "deny", path: { type: "glob_pattern", pattern: "/private/**" } }],
          },
        },
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Permission scope" })).toBeVisible();
  for (const value of ["/authorized", "/read", "/write", "/private/**", "https://example.test"])
    expect(screen.getByText(value, { exact: false, selector: "li" })).toBeVisible();
  expect(container.querySelector("details")).not.toHaveAttribute("open");
});
it("shows a command or network rule without expanding native JSON", () => {
  const { rerender } = render(
    <NativeScope
      locale="zh-CN"
      candidate
      value={{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }}
    />,
  );
  expect(screen.getByText(/git status/)).toBeVisible();
  rerender(
    <NativeScope
      locale="zh-CN"
      candidate
      value={{
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { action: "deny", host: "private.test" },
        },
      }}
    />,
  );
  expect(screen.getByText(/拒绝 · private.test/)).toBeVisible();
});
