// Shared name rules for tasks, worktrees, and mailboxes.
const worktreeShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const agentNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export function isAgentName(name: string): boolean {
  return agentNamePattern.test(name);
}

export function worktreeNameError(name: unknown): string | null {
  if (typeof name !== "string" || !worktreeShape.test(name)) {
    return "worktree name must be 1-64 letters, digits, dots, "
      + "underscores, or dashes, and start with a letter or digit";
  }
  if (name.includes("..")) return "worktree name cannot contain '..'";
  return null;
}
