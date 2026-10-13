import { useNavigate } from "@tanstack/react-router";

/** Both the Web router and the embedded desktop router expose these routes. */
export function useSessionNavigate() {
  return useNavigate() as unknown as (options: {
    to: string;
    params?: Record<string, string>;
    replace?: boolean;
    resetScroll?: boolean;
  }) => Promise<void>;
}
