import type { Manifest } from "@/core/types";

/** Adopt external changes unless doing so would overwrite an actual editor draft. */
export async function resolveRefreshedManifest({
  initialManifest,
  initialBaseline,
  cachedDraft,
  diskManifest,
  getCurrentManifest,
  confirmDiskVersion,
}: {
  initialManifest?: Manifest;
  initialBaseline: string;
  cachedDraft?: Manifest;
  diskManifest?: Manifest;
  getCurrentManifest: () => Manifest | undefined;
  confirmDiskVersion: () => Promise<boolean>;
}): Promise<Manifest | undefined> {
  const current = getCurrentManifest();
  const editedDuringRefresh = JSON.stringify(current) !== JSON.stringify(initialManifest);
  const candidate = editedDuringRefresh ? current : (initialManifest ?? cachedDraft);
  if (!diskManifest) return candidate;
  const candidateSnapshot = JSON.stringify(candidate);
  const diskSnapshot = JSON.stringify(diskManifest);
  const hasDraft = candidate && (editedDuringRefresh || candidateSnapshot !== initialBaseline);
  if (!hasDraft || candidateSnapshot === diskSnapshot) return diskManifest;
  if (initialBaseline && diskSnapshot !== initialBaseline) {
    const loadDisk = await confirmDiskVersion();
    const latest = getCurrentManifest();
    // A confirmation only covers the draft shown when the dialog opened.
    if (JSON.stringify(latest) !== JSON.stringify(current)) return latest;
    if (loadDisk) return diskManifest;
  }
  return candidate;
}

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
