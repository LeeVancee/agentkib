export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}
