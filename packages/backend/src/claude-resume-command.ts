/** A copyable command is data: every host path and native ID is a literal shell argument. */
export function claudeResumeCommand(
  cwd: string,
  config: string,
  nativeId: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId))
    throw new Error("unverified-session-identity");
  if ([cwd, config].some((value) => !value || value.includes("\0")))
    throw new Error("claude-context-unavailable");
  const shell = platform === "win32" ? "powershell" : "posix";
  const quote = (value: string) =>
    shell === "powershell"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const command =
    shell === "powershell"
      ? `try { Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; $env:CLAUDE_CONFIG_DIR = ${quote(config)}; & claude --resume ${quote(nativeId)} } catch { Write-Error $_ }`
      : `cd -- ${quote(cwd)} && CLAUDE_CONFIG_DIR=${quote(config)} claude --resume ${quote(nativeId)}`;
  return { available: true as const, command, shell, runOn: "host" as const };
}
