import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/ui/resizable";
import { Sheet, SheetContent } from "../../components/ui/sheet";

const ArtifactWidthContext = createContext<RefObject<number> | null>(null);

export function ArtifactWorkspace({
  children,
  browser,
}: {
  children: ReactNode;
  browser: ReactNode;
}) {
  const width = useRef(360);
  return (
    <ArtifactWidthContext value={width}>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
        <ResizablePanel id="conversation" minSize="35%" className="flex min-h-0 min-w-0 flex-col">
          {children}
        </ResizablePanel>
        {browser}
      </ResizablePanelGroup>
    </ArtifactWidthContext>
  );
}

/** A stable portal host keeps media mounted when switching between docked and sheet layouts. */
export function ArtifactPanel({
  children,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
}) {
  const width = useContext(ArtifactWidthContext);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (wide || !host) return;
    const popup = host.querySelector<HTMLElement>('[data-slot="sheet-content"]');
    if (popup && !popup.contains(document.activeElement)) popup.focus();
  }, [wide, host]);
  const content = (
    <>
      <div ref={setHost} className="h-full min-h-0 min-w-0" />
      {host && (
        <Sheet
          open
          modal={!wide}
          disablePointerDismissal={wide}
          onOpenChange={(open) => !open && onClose()}
        >
          <SheetContent
            container={host}
            docked={wide}
            role={wide ? "complementary" : "dialog"}
            aria-modal={wide ? undefined : true}
            aria-labelledby={labelledBy}
            finalFocus={() => {
              const active = document.activeElement;
              if (active && active !== document.body && !host.contains(active)) return false;
              return true;
            }}
          >
            {children}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
  if (!width) return content;
  return (
    <>
      <ResizableHandle
        aria-labelledby={labelledBy}
        className={wide ? "transition-colors hover:bg-ring/40" : "hidden"}
      />
      <ResizablePanel
        id="conversation-files"
        defaultSize={wide ? width.current : 0}
        minSize={wide ? 320 : 0}
        maxSize={wide ? "55%" : 0}
        groupResizeBehavior="preserve-pixel-size"
        style={{ overflow: "visible" }}
        className="h-full min-h-0 min-w-0"
        onResize={(size) => {
          if (wide && size.inPixels >= 320) width.current = size.inPixels;
        }}
      >
        {content}
      </ResizablePanel>
    </>
  );
}
