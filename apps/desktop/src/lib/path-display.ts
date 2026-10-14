function splitPath(path: string): string[] {
  // POSIX filenames may contain literal backslashes.
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  return path.split(windowsPath ? /[\\/]/ : /\//);
}

export function shortPath(path: string): string {
  const parts = splitPath(path).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

export function fileName(path: string): string {
  return splitPath(path).pop() ?? "";
}
