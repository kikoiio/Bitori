import { resolve } from "node:path";

export const project = resolve(import.meta.dirname, "..");

export const { AGENT_CONTEXT_FILE, AGENT_REMINDER_FILE, OPENAI_MODEL } = process.env;
