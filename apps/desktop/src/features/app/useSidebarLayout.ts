import { useEffect, useState } from "react";
import { useSidebarWidthStore, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "./sidebar-width-store";

export function useSidebarLayout() {
  const windowWidth = useWindowWidth();
  const sidebarWidth = useSidebarWidthStore((state) => state.width);
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, windowWidth - 640 - 52));

  return {
    maxWidth,
    visibleWidth: Math.min(sidebarWidth, maxWidth),
    canResize: windowWidth >= 1024,
  };
}

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return width;
}
