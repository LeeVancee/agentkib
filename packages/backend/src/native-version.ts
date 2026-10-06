/** Compare application versions without making claims about native protocol compatibility. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] | null => {
    if (value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) return null;
    const parts = value.split(".").map(Number);
    return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null;
  };
  const actual = parse(version);
  const threshold = parse(minimum);
  if (!actual || !threshold) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== threshold[index]) return actual[index]! > threshold[index]!;
  }
  return true;
}
