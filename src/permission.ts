import { isAbsolute, relative, resolve } from "node:path";
import { project } from "./config.ts";

const denyList = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
const destructiveWord = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
const destructiveSubstrings = ["rm ", "> /etc/", "chmod 777"];
const pathTools = new Set(["read_file", "write_file", "edit_file"]);

export type Gate =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; reason: string };

function argsRecord(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

// Deny list hard-blocks bash. Risky commands and paths outside `root` ask.
export function gatePermission(name: string, args: unknown, root = project): Gate {
  const record = argsRecord(args);
  if (name === "bash") {
    const command = typeof record.command === "string" ? record.command : "";
    const denied = denyList.find((pattern) => command.includes(pattern));
    if (denied) return { verdict: "deny", reason: `'${denied}' is on the deny list` };
    if (destructiveWord.test(command)
      || destructiveSubstrings.some((keyword) => command.includes(keyword))) {
      return { verdict: "ask", reason: "Potentially destructive command" };
    }
  }
  if (pathTools.has(name)) {
    const path = typeof record.path === "string" ? record.path : "";
    const rel = relative(root, resolve(root, path));
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { verdict: "ask", reason: "Path outside the project workspace" };
    }
  }
  return { verdict: "allow" };
}

// Teammates never prompt. The lead runs the command or the call stays blocked.
export function teammatePermission(name: string, args: unknown, cwd: string): string | null {
  const gate = gatePermission(name, args, cwd);
  if (gate.verdict === "deny") return `Permission denied: ${gate.reason}`;
  if (gate.verdict === "ask" && name === "bash") {
    return "Permission required: ask Lead to run this command.";
  }
  if (gate.verdict === "ask") return "Permission required: path is outside the workspace.";
  return null;
}
