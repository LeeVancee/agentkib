import { createContext, useContext, type ReactNode } from "react";
import type { useAppHistory } from "./useAppHistory";
import type { useAppNavigation } from "./useAppNavigation";

export type AppNavigationContextValue = {
  app: ReturnType<typeof useAppNavigation>;
  history: ReturnType<typeof useAppHistory>;
  searchOpen: boolean;
  onOpenSearch: () => void;
};

const AppNavigationContext = createContext<AppNavigationContextValue | null>(null);

export function AppNavigationProvider({
  value,
  children,
}: {
  value: AppNavigationContextValue;
  children: ReactNode;
}) {
  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>;
}

export function useAppNavigationContext() {
  const value = useContext(AppNavigationContext);
  if (!value) throw new Error("useAppNavigationContext must be used within AppNavigationProvider");
  return value;
}
