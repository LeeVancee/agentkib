
import { createContext, useContext, type ComponentProps, type ReactNode } from "octane";
import { cn } from "@/lib/utils";

type DialogContextValue = { close: () => void };
const DialogContext = createContext<DialogContextValue | null>(null);

function Dialog({
  open = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  if (!open) return null;
  return <DialogContext value={{ close: () => onOpenChange?.(false) }}>{children}</DialogContext>;
}

function DialogPortal({ children }: { children?: ReactNode }) {
  return children;
}

function DialogClose({ onClick, ...props }: ComponentProps<"button">) {
  const context = useContext(DialogContext);
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context?.close();
      }}
    />
  );
}

function DialogOverlay({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-overlay" className={cn("fixed inset-0 z-50 bg-black/50", className)} {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <div
        role="dialog"
        aria-modal="true"
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border bg-background p-6 text-foreground shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClose
            className="absolute top-4 right-4 grid size-9 place-items-center rounded-md hover:bg-accent"
            aria-label="Close"
          >
            <span aria-hidden="true">×</span>
          </DialogClose>
        )}
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-2 text-left", className)} {...props} />;
}

function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="dialog-title" className={cn("text-lg font-semibold", className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogHeader, DialogOverlay, DialogPortal, DialogTitle };
