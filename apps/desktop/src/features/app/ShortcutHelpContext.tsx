import { createContext, useContext, type ReactNode } from "react";

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
  children: ReactNode;
  openShortcutHelp: () => void;
}) {
  return (
    <ShortcutHelpContext.Provider value={{ openShortcutHelp }}>
      {children}
    </ShortcutHelpContext.Provider>
  );
}

export function useShortcutHelp() {
  return useContext(ShortcutHelpContext);
}
