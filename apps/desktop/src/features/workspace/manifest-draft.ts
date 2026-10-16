import type { Manifest } from "@/core/types";

export function draftSectionCount(manifest: Manifest | undefined, baseline: string): number {
  if (!manifest || !baseline || JSON.stringify(manifest) === baseline) return 0;
  try {
    const saved = JSON.parse(baseline) as Manifest;
    return (Object.keys(manifest) as Array<keyof Manifest>).filter(
      (key) => JSON.stringify(manifest[key]) !== JSON.stringify(saved[key]),
    ).length;
  } catch {
    // Keep the draft visible if an unavailable baseline prevents a precise count.
    return 1;
  }
}
