import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import type { Access } from "@agentkib/web-client";
import { dictionaries, type Locale } from "@agentkib/conversation-ui/i18n";
import { PairingPage } from "./pairing-page";
import { codePairingCopy } from "./code-pairing-copy";

let locale: Locale = "zh-CN";
let pairingMode: Access["pairingMode"];
let connectionType = "same-origin";
vi.mock("@agentkib/conversation-ui/features/sessions/session-context", () => ({
  useSession: () => ({
    t: dictionaries[locale],
    locale,
    access: { status: "unpaired", pairingMode },
    connection: { type: connectionType },
    code: "",
    name: "Test browser",
    setCode: vi.fn(),
    setName: vi.fn(),
    pair: vi.fn(),
    busy: false,
  }),
}));
afterEach(cleanup);

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
