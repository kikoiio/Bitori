import OpenAI from "openai";
import { OPENAI_MODEL } from "./config.ts";

const client = new OpenAI({ maxRetries: 0 });
const model = OPENAI_MODEL?.trim() || "gpt-5-mini";

// One-shot non-streaming call, used for history summarization.
export async function requestText(instructions: string, input: string): Promise<string> {
  const { text } = await requestOnce(instructions, input, 8000);
  return text;
}

// Workflow steps have no tools. Tokens come from the response usage when present.
export async function requestWorkflowStep(instructions: string, input: string): Promise<{ text: string; tokens: number }> {
  return requestOnce(instructions, input, 2000);
}

// The goal evaluator is a separate tool-free call with a short answer.
export async function requestGoalEvaluation(instructions: string, input: string): Promise<string> {
  const { text } = await requestOnce(instructions, input, 512);
  return text;
}

async function requestOnce(instructions: string, input: string, maxOutputTokens: number): Promise<{ text: string; tokens: number }> {
  const response = await client.responses.create({
    model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
  });
  const usage = response.usage;
  return {
    text: response.output_text.trim(),
    tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
  };
}

export async function request(
  input: OpenAI.Responses.ResponseInput,
  tools: OpenAI.Responses.FunctionTool[],
  print: (text: string) => void,
) {
  const stream = await client.responses.create({
    model,
    input,
    tools,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  });

  let hasText = false;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      hasText ||= Boolean(event.delta);
      print(event.delta);
    } else if (event.type === "response.completed") {
      const { output } = event.response;
      const tokens = usageTokens(event.response.usage);
      if (hasText) return { output, hasText, tokens };
      const text = output.flatMap((item) => item.type === "message" ? item.content : [])
        .map((part) => part.type === "output_text" ? part.text : part.refusal)
        .join("");
      print(text);
      return { output, hasText: Boolean(text.trim()), tokens };
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      const detail = event.response.error?.message ?? event.response.incomplete_details?.reason;
      throw new Error(detail ? `${event.type}: ${detail}` : event.type);
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  throw new Error("The stream ended before response.completed.");
}

function usageTokens(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): number {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return 0;
  return input + output;
}
