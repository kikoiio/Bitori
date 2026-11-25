import { isScheduledTurn } from "../cron.ts";
import { mcpRegistry } from "../mcp.ts";
import { gatePermission } from "../permission.ts";
import type { PreToolUseCall } from "./core.ts";

export type ConfirmFn = (reason: string, name: string, argsJson: string) => Promise<boolean>;

function scheduledDenial(): string {
  return "Permission denied: scheduled turns cannot request interactive approval";
}

export function createPermissionHook(confirm: ConfirmFn) {
  return async ({ name, args, argsJson }: PreToolUseCall): Promise<string | undefined> => {
    const gate = gatePermission(name, args);
    if (gate.verdict === "deny") return `Permission denied: ${gate.reason}`;
    // A scheduled turn shares the prompt's input stream, so it cannot ask.
    if (gate.verdict === "ask" && isScheduledTurn()) return scheduledDenial();
    if (gate.verdict === "ask" && !(await confirm(gate.reason, name, argsJson))) {
      return "Permission denied by user.";
    }
    // Unknown and confirm-policy MCP tools ask. Allow-policy tools do not.
    if (name.startsWith("mcp__") && mcpRegistry.policy(name) !== "allow") {
      if (isScheduledTurn()) return scheduledDenial();
      if (!(await confirm(`External tool ${name}`, name, argsJson))) {
        return "Permission denied by user.";
      }
    }
    return undefined;
  };
}
