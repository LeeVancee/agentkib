export type FirstCloseBehavior = "minimize-to-tray" | "quit";
export type FirstCloseAction = "hide" | "minimize" | "quit";

export interface FirstCloseDecision {
  behavior: FirstCloseBehavior;
  action: FirstCloseAction;
}

export function firstCloseDecision(
  response: number,
  trayAvailable: boolean,
): FirstCloseDecision | undefined {
  if (response === 0) {
    return {
      behavior: "minimize-to-tray",
      action: trayAvailable ? "hide" : "minimize",
    };
  }
  if (response === 1) return { behavior: "quit", action: "quit" };
  return undefined;
}
