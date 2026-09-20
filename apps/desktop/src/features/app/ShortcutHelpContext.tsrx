/** @jsxImportSource octane */

import { createContext, useContext } from "octane";
import type { Renderable } from "@/lib/octane-types";

type ShortcutHelpContextValue = {
  openShortcutHelp: () => void;
};

const ShortcutHelpContext = createContext<ShortcutHelpContextValue>({
  openShortcutHelp: () => undefined,
});

export function ShortcutHelpProvider({
  children,
  openShortcutHelp,
}: {
  children: Renderable;
  openShortcutHelp: () => void;
}) {
  return (
    <ShortcutHelpContext value={{ openShortcutHelp }}>
      {children}
    </ShortcutHelpContext>
  );
}

export function useShortcutHelp() {
  return useContext(ShortcutHelpContext);
}
