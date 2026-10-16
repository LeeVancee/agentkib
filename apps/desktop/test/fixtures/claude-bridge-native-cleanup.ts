import { rmSync } from "node:fs";
import type { Server, ServerResponse } from "node:http";

/** Finalize only resources created by the isolated native bridge fixture. */
export async function finishClaudeBridgeNative({
  saveEvidence,
  terminal,
  bridge,
  provider,
  held,
  root,
  failure,
}: {
  saveEvidence(): void;
  terminal: { close(): Promise<void> };
  bridge: { close(): Promise<void> };
  provider: Server;
  held: ReadonlySet<ServerResponse>;
  root: string;
  failure?: { error: unknown };
}): Promise<void> {
  const errors: unknown[] = failure ? [failure.error] : [];
  try {
    saveEvidence();
  } catch (error) {
    errors.push(error);
  } finally {
    // A failed evidence write or individual close must not leave later owned
    // resources alive. Preserve the evidence error if cleanup also fails.
    for (const release of [
      () => terminal.close(),
      () => bridge.close(),
      () => {
        for (const response of held) response.destroy();
      },
      () => {
        if (!provider.listening) return;
        return new Promise<void>((resolve, reject) => {
          provider.close((error) => (error ? reject(error) : resolve()));
        });
      },
      () => rmSync(root, { recursive: true, force: true }),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Native bridge finalization failed", { cause: errors[0] });
}
