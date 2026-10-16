import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import type { Access } from "@agentkib/web-client";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { PairingPage } from "./pairing-page";
import { codePairingCopy } from "./code-pairing-copy";
import { pairingErrorCopy, pairingErrorText } from "./pairing-error-copy";

let locale: Locale = "zh-CN";
let pairingMode: Access["pairingMode"];
let connectionType = "same-origin";
let pairingError: string | undefined;
let busy = false;
const refresh = vi.fn();
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => ({
    t: dictionaries[locale],
    locale,
    access: { status: "unpaired", pairingMode },
    connection: { type: connectionType },
    code: "12345678",
    name: "Test browser",
    setCode: vi.fn(),
    setName: vi.fn(),
    pair: vi.fn(),
    busy,
    pairingError,
    refresh,
  }),
}));
afterEach(cleanup);
beforeEach(() => {
  pairingError = undefined;
  busy = false;
  refresh.mockReset();
});

it.each(Object.keys(codePairingCopy) as Locale[])(
  "shows direct full access and removes the confirmation step in %s",
  (value) => {
    locale = value;
    connectionType = "same-origin";
    pairingMode = "code";
    render(<PairingPage />);
    expect(screen.getByRole("heading", { name: codePairingCopy[value].title })).toBeVisible();
    expect(screen.getByText(codePairingCopy[value].scope)).toBeVisible();
    expect(screen.getByLabelText(codePairingCopy[value].code)).toBeVisible();
    expect(screen.queryByText(dictionaries[value].pending)).not.toBeInTheDocument();
  },
);

it.each(["legacy", "lan", "confirmation"])("keeps the %s pairing boundary", (mode) => {
  locale = "zh-CN";
  connectionType = mode === "lan" ? "lan-http" : "same-origin";
  pairingMode = mode === "legacy" ? undefined : mode === "lan" ? "code" : "confirmation";
  render(<PairingPage />);
  expect(screen.getByText(dictionaries[locale].pending)).toBeVisible();
  expect(screen.queryByText(codePairingCopy[locale].scope)).not.toBeInTheDocument();
});

it.each(Object.keys(pairingErrorCopy) as Locale[])(
  "shows actionable pairing errors and a reconnect action in %s",
  (value) => {
    locale = value;
    pairingMode = "code";
    connectionType = "same-origin";
    pairingError = "invalid_pairing_code";
    render(<PairingPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      pairingErrorCopy[value].invalid_pairing_code,
    );
    expect(screen.getByLabelText(codePairingCopy[value].code)).toHaveValue("12345678");
    expect(screen.getByLabelText(codePairingCopy[value].code)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: dictionaries[value].retry }));
    expect(refresh).toHaveBeenCalledWith(true);
  },
);

it.each(Object.keys(pairingErrorCopy) as Locale[])(
  "provides a localized fallback in %s",
  (value) => {
    const copy = pairingErrorCopy[value];
    for (const code of Object.keys(copy) as (keyof typeof copy)[]) {
      if (code !== "requesting") expect(pairingErrorText(value, code)).toBe(copy[code]);
    }
    expect(pairingErrorText(value, "server stack or unknown error")).toBe(
      pairingErrorCopy[value].request_failed,
    );
    expect(pairingErrorText(value, "toString")).toBe(pairingErrorCopy[value].request_failed);
  },
);

it("disables both fields and shows progress while the pairing request is pending", () => {
  locale = "zh-CN";
  pairingMode = "code";
  connectionType = "same-origin";
  busy = true;
  render(<PairingPage />);

  expect(screen.getByLabelText(codePairingCopy[locale].code)).toBeDisabled();
  expect(screen.getByLabelText(dictionaries[locale].name)).toBeDisabled();
  expect(screen.getByRole("button", { name: pairingErrorCopy[locale].requesting })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: pairingErrorCopy[locale].requesting }).closest("form"),
  ).toHaveAttribute("aria-busy", "true");
});
