/**
 * Whether a reviewed change writes the file Claude Code keeps its settings, state and user-scope
 * MCP servers in (`.claude.json`, in the home folder or in `CLAUDE_CONFIG_DIR`). A running Claude
 * Code holds its own copy of that file and may write it back whole, undoing the change, so the
 * review screens ask the user to close Claude Code first.
 */
export function isClaudeGlobalConfig(change: { target: string; scope: string }): boolean {
  return change.scope === "agent-home" && change.target.split(/[\\/]/).pop() === ".claude.json";
}
