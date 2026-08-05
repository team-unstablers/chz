import { mkdirSync } from "node:fs";

import { CHZ_HARNESS_TOOLS, TERMINAL_TOOL_NAMES, TERMINAL_TOOLS } from "./tools/catalog.ts";
import type { ChzTerminalState } from "./tools/control.ts";
import { ChzHarnessSession, collectResolution } from "./session.ts";
import { buildKickoffPrompt, buildSystemParts, TURN_LIMIT_PROMPT } from "./prompt.ts";
import type {
  ChzChatMessage,
  ChzChatResponse,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzImagineSymbolType,
  ChzRealizeContext,
  ChzRealizer,
  ChzToolCall,
  ChzToolDefinition,
} from "./types.ts";

export { CHZ_HARNESS_TOOLS } from "./tools/catalog.ts";

export interface ChzRealizerBaseOptions {
  model: string;
  supportedSymbolTypes?: readonly ChzImagineSymbolType[];
  /** Number of retries after the initial provider request. */
  maxApiRetries?: number;
  retryDelayMs?: number;
}

/**
 * Vendor-neutral Realizer harness. Subclasses implement only one provider turn;
 * this class owns the agent loop, tools, boundaries, turn cap, and retries.
 */
export abstract class ChzRealizerBase implements ChzRealizer {
  abstract readonly name: string;
  readonly modelLabel: string;
  readonly supportedSymbolTypes: readonly ChzImagineSymbolType[];
  private readonly maxApiRetries: number;
  private readonly retryDelayMs: number;

  protected constructor(options: ChzRealizerBaseOptions) {
    this.modelLabel = options.model;
    this.supportedSymbolTypes = options.supportedSymbolTypes ?? ["function", "class", "variable"];
    this.maxApiRetries = options.maxApiRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }


  /** Send exactly one provider turn. The shared loop executes returned tools. */
  protected abstract chat(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse>;

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    if (!this.supportedSymbolTypes.includes(symbol.type)) {
      return { outcome: "failed", symbol, reason: `${this.name} does not support symbol type '${symbol.type}'.` };
    }
    if (!Number.isInteger(context.maxTurns) || context.maxTurns < 1) {
      return { outcome: "failed", symbol, reason: "maxTurns must be an integer greater than zero." };
    }

    mkdirSync(context.outputDir, { recursive: true });
    let systemParts: readonly [string, string];
    try {
      systemParts = buildSystemParts(symbol, context, this.modelLabel);
    } catch (error) {
      return { outcome: "failed", symbol, reason: (error as Error).message };
    }

    const messages: ChzChatMessage[] = systemParts.map((content) => ({ role: "system", content }));
    messages.push({ role: "user", content: buildKickoffPrompt(symbol, context) });
    const session = new ChzHarnessSession(this.name, symbol, context);
    let terminal: ChzTerminalState | undefined;

    for (let turn = 1; turn <= context.maxTurns && terminal === undefined; turn++) {
      const closing = turn === context.maxTurns;
      if (closing) messages.push({ role: "user", content: TURN_LIMIT_PROMPT });
      session.emit({
        kind: "turn",
        realizer: this.name,
        turn,
        maxTurns: context.maxTurns,
        text: `[${this.name}] turn ${turn}/${context.maxTurns}`,
      });

      let response: ChzChatResponse;
      try {
        response = await this.chatWithRetry(messages, closing ? TERMINAL_TOOLS : CHZ_HARNESS_TOOLS);
      } catch (error) {
        return { outcome: "failed", symbol, reason: `Model request failed: ${(error as Error).message}` };
      }
      if (response.reasoning?.trim()) {
        session.emit({
          kind: "reasoning",
          realizer: this.name,
          turn,
          maxTurns: context.maxTurns,
          text: response.reasoning.trim(),
        });
      }
      messages.push(response.message);

      if (response.message.toolCalls.length === 0) {
        if (!closing) {
          messages.push({
            role: "user",
            content: "Call a tool to continue working, or call Finish, Block, or Abort to end the session.",
          });
        }
        continue;
      }

      for (const call of response.message.toolCalls) {
        const input = parseToolArguments(call);
        const execution = closing && !TERMINAL_TOOL_NAMES.has(call.name)
          ? session.reject(call.name, input.value, "Tools are disabled at the turn limit. Call Finish, Block, or Abort.")
          : input.error !== undefined
            ? session.reject(call.name, undefined, input.error)
            : await session.run(call.name, input.value);

        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: execution.output,
        });
        terminal = execution.terminal;
        if (terminal !== undefined) break;
      }
    }

    if (terminal === undefined) {
      return {
        outcome: "failed",
        symbol,
        reason: `Turn limit (${context.maxTurns}) reached without Finish, Block, or Abort.`,
      };
    }
    if (terminal.kind === "blocked") {
      return { outcome: "blocked", symbol, reason: terminal.reason, todo: terminal.todo };
    }
    if (terminal.kind === "aborted") {
      return { outcome: "failed", symbol, reason: terminal.reason };
    }

    try {
      return collectResolution(symbol, context, this.modelLabel);
    } catch (error) {
      return { outcome: "failed", symbol, reason: (error as Error).message };
    }
  }

  private async chatWithRetry(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxApiRetries; attempt++) {
      try {
        return await this.chat(messages, tools);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxApiRetries) break;
        await delay(this.retryDelayMs * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseToolArguments(call: ChzToolCall): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  if (typeof call.arguments !== "string") return { value: call.arguments };
  try {
    return { value: JSON.parse(call.arguments) as unknown };
  } catch (error) {
    return {
      error: `Invalid tool input: arguments are not valid JSON (${(error as Error).message}). Please rewrite the input so it satisfies the expected schema.`,
    };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
