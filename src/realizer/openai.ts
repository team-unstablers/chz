import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { ChzRealizerBase, type ChzRealizerBaseOptions } from "./base.ts";
import type {
  ChzChatMessage,
  ChzChatResponse,
  ChzToolDefinition,
} from "./types.ts";

export interface ChzOpenAIRealizerOptions
  extends Omit<ChzRealizerBaseOptions, "model"> {
  /** Chat Completions model ID understood by the target API. */
  model: string;
  /** Defaults to OPENAI_API_KEY. Compatible local APIs may use any placeholder. */
  apiKey?: string;
  /** Defaults to OPENAI_BASE_URL, then the official OpenAI endpoint. */
  baseURL?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  /** Injectable official-SDK client, primarily for tests and custom transports. */
  client?: OpenAI;
}

/** OpenAI Chat Completions transport; all harness behavior lives in the base. */
export class ChzOpenAIRealizer extends ChzRealizerBase {
  readonly name = "ChzOpenAIRealizer";
  private readonly client: OpenAI;

  constructor(private readonly options: ChzOpenAIRealizerOptions) {
    super(options);
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed",
        baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
        organization: options.organization,
        project: options.project,
        timeout: options.timeoutMs,
        // ChzRealizerBase owns provider retries so every transport behaves alike.
        maxRetries: 0,
      });
  }

  protected async chat(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse> {
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      temperature: 0.2,
      messages: messages.map(toOpenAIMessage),
      tools: tools.map(toOpenAITool),
      tool_choice: "auto",
    });
    const message = response.choices[0]?.message;
    if (message === undefined) {
      throw new Error("OpenAI-compatible API returned no choices.");
    }
    const reasoning = extractReasoning(message);

    return {
      message: {
        role: "assistant",
        content: message.content ?? "",
        toolCalls: (message.tool_calls ?? []).flatMap((call) =>
          call.type === "function"
            ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }]
            : [],
        ),
      },
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }
}

function extractReasoning(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  for (const candidate of [record.reasoning_content, record.reasoning, record.reasoning_details]) {
    const parts = collectReasoningText(candidate);
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

function collectReasoningText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(collectReasoningText);
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  return [record.text, record.content, record.summary].flatMap(collectReasoningText);
}

function toOpenAIMessage(message: ChzChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments:
                    typeof call.arguments === "string"
                      ? call.arguments
                      : JSON.stringify(call.arguments),
                },
              })),
            }),
      };
  }
}

function toOpenAITool(tool: ChzToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
