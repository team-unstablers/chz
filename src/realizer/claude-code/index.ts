/** A Realizer that delegates the agentic loop to Claude Code (docs/61).
 *
 * Every other Realizer inherits `ChzRealizerBase` and implements one provider
 * turn. This one is the documented exception: Claude Code is already an agentic
 * harness, so the loop, context management, and prompt caching are handed over
 * wholesale — a harness inside a harness.
 *
 * What is *not* handed over is the tool surface. Claude Code's built-in tools
 * are switched off entirely (`tools: []`), and the docs/63 catalog is
 * republished over an in-process MCP server backed by the same
 * `ChzHarnessSession` the shared loop uses. That is what keeps read/write
 * boundaries, read-before-write staleness checks, output bounding, inline
 * diagnostics, and the secrets blocklist enforced in code rather than in
 * permission globs — and it is why there is no shell tool here either.
 *
 * One consequence is a gain rather than a loss: because the MCP server runs in
 * this process, `AskUser` reaches `context.askUser` directly. docs/63's rule
 * that a non-interactive session must degrade `AskUser` to `blocked` does not
 * apply, and the CLI's interactive prompt works as it does for every other
 * Realizer.
 *
 * One consequence *is* a loss, and it is a limitation rather than a design
 * choice: docs/64 specifies that the final turn narrows the tool list to
 * Finish/Block/Abort and injects a closing prompt so a session that runs out of
 * turns still hands over a summary. Delegating the loop makes that
 * unreachable — Claude Code stops at `maxTurns` with `error_max_turns` and
 * offers no seam to inject a last message. The turn cap therefore degrades to a
 * hard stop with no handover summary.
 */

import { mkdirSync } from "node:fs";

import { CHZ_HARNESS_TOOLS } from "../tools/catalog.ts";
import { ChzHarnessSession, collectResolution } from "../session.ts";
import { buildKickoffPrompt, buildSystemParts } from "../prompt.ts";
import type {
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzImagineSymbolType,
  ChzRealizer,
  ChzRealizeContext,
} from "../types.ts";
import {
  ChzClaudeCodeDependencyError,
  createChzToolServer,
  loadClaudeCodeQuery,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type ChzClaudeCodeAssistantMessage,
  type ChzClaudeCodeInitMessage,
  type ChzClaudeCodeMessage,
  type ChzClaudeCodeQuery,
  type ChzClaudeCodeResultMessage,
  type ChzClaudeCodeThinkingBlock,
  type ChzClaudeCodeToolServer,
  type ChzToolDispatch,
} from "./bridge.ts";

const MCP_SERVER_NAME = "chz";

/** Model errors that a human unblocks by preparing the environment, not by editing `.chz.ts`. */
const ENVIRONMENT_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
]);

export interface ClaudeCodeRealizerOptions {
  /** Model alias (`opus`, `sonnet`) or full model id; also the provenance label. */
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Hard spend ceiling for one session. Reaching it ends the session as blocked. */
  maxBudgetUsd?: number;
  /** Claude Code executable to drive instead of the one the SDK bundles. */
  claudePath?: string;
  /** Merged over `process.env`; the SDK replaces the child environment outright. */
  env?: Record<string, string>;
  /** Escape hatch passed straight through, e.g. `["--fallback-model", "sonnet"]`. */
  extraArgs?: string[];
  supportedSymbolTypes?: readonly ChzImagineSymbolType[];
}

export class ClaudeCodeRealizer implements ChzRealizer {
  readonly name = "ClaudeCodeRealizer";
  /** Read by `chz realize --dry-run` and recorded as `resolvedBy` provenance. */
  readonly modelLabel: string;
  readonly supportedSymbolTypes: readonly ChzImagineSymbolType[];

  readonly #options: ClaudeCodeRealizerOptions;

  constructor(options: ClaudeCodeRealizerOptions) {
    this.#options = options;
    this.modelLabel = options.model;
    this.supportedSymbolTypes = options.supportedSymbolTypes ?? ["function", "class", "variable"];
  }

  /** Overridden in tests so the suite runs without the optional dependencies. */
  protected loadQuery(): Promise<ChzClaudeCodeQuery> {
    return loadClaudeCodeQuery();
  }

  /** Overridden in tests to capture the dispatch closure without an MCP round trip. */
  protected createToolServer(dispatch: ChzToolDispatch): Promise<ChzClaudeCodeToolServer> {
    return createChzToolServer(CHZ_HARNESS_TOOLS, dispatch);
  }

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

    const session = new ChzHarnessSession(this.name, symbol, context);

    let query: ChzClaudeCodeQuery;
    let toolServer: ChzClaudeCodeToolServer;
    try {
      query = await this.loadQuery();
      // Claude Code may issue a batch of tools/call requests concurrently,
      // whereas the shared loop always runs one tool at a time. The runtimes
      // rely on that: read-before-write and the staleness check (docs/63) are
      // stated over a sequential view of the session. Queueing restores it.
      const queue = new SerialQueue();
      toolServer = await this.createToolServer(
        async (name, input) => await queue.run(async () => await session.run(name, input)),
      );
    } catch (error) {
      return this.#startupOrRuntimeFailure(symbol, error);
    }

    const abortController = new AbortController();
    const turns = new TurnTracker(this.name, context.maxTurns, session);
    let result: ChzClaudeCodeResultMessage | undefined;
    let environmentError: string | undefined;
    let startupFailure: string | undefined;

    try {
      const stream = query({
        prompt: buildKickoffPrompt(symbol, context),
        options: {
          // The canonical docs/64 prompt replaces Claude Code's own system
          // prompt outright, which also suppresses CLAUDE.md injection. The
          // boundary marker keeps the fixed part cacheable across sessions.
          systemPrompt: [systemParts[0], SYSTEM_PROMPT_DYNAMIC_BOUNDARY, systemParts[1]],
          // No built-in tools at all: the harness catalog is the whole surface,
          // and docs/63 deliberately has no shell tool.
          tools: [],
          mcpServers: { [MCP_SERVER_NAME]: toolServer },
          allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
          strictMcpConfig: true,
          // Nothing from ~/.claude or the project's .claude may leak into a
          // realize session; the prompt has to stay exactly what docs/64 says.
          settingSources: [],
          permissionMode: "dontAsk",
          maxTurns: context.maxTurns,
          cwd: context.projectRoot,
          persistSession: false,
          model: this.#options.model,
          ...(this.#options.effort === undefined ? {} : { effort: this.#options.effort }),
          ...(this.#options.maxBudgetUsd === undefined
            ? {}
            : { maxBudgetUsd: this.#options.maxBudgetUsd }),
          ...(this.#options.claudePath === undefined
            ? {}
            : { pathToClaudeCodeExecutable: this.#options.claudePath }),
          // `env` replaces the child environment rather than merging into it,
          // so PATH and HOME have to be carried over explicitly.
          env: { ...process.env, ...this.#options.env },
          ...(this.#options.extraArgs === undefined
            ? {}
            : { extraArgs: parseExtraArgs(this.#options.extraArgs) }),
          abortController,
        },
      });

      for await (const message of stream) {
        if (isInit(message)) {
          startupFailure = describeToolServerFailure(message);
          if (startupFailure !== undefined) break;
        } else if (isAssistant(message)) {
          environmentError ??= classifyAssistantError(message);
          turns.observe(message);
        } else if (isResult(message)) {
          result = message;
        }

        // Ending is declared through a tool, so stop at the first message
        // boundary after one fires. Aborting mid-handler would truncate the
        // tool result the model still has to see.
        if (session.terminal !== undefined) {
          abortController.abort();
          break;
        }
      }
    } catch (error) {
      if (session.terminal === undefined && startupFailure === undefined) {
        return this.#startupOrRuntimeFailure(symbol, error);
      }
    }

    const terminal = session.terminal;
    if (terminal?.kind === "blocked") {
      return { outcome: "blocked", symbol, reason: terminal.reason, todo: terminal.todo };
    }
    if (terminal?.kind === "aborted") {
      return { outcome: "failed", symbol, reason: terminal.reason };
    }
    if (terminal?.kind === "finish") {
      try {
        return collectResolution(symbol, context, this.modelLabel);
      } catch (error) {
        return { outcome: "failed", symbol, reason: (error as Error).message };
      }
    }

    if (startupFailure !== undefined) {
      return { outcome: "failed", symbol, reason: startupFailure };
    }
    return this.#endedWithoutTermination(symbol, context, result, environmentError);
  }

  #startupOrRuntimeFailure(symbol: ChzImagineSymbol, error: unknown): ChzImagineSymbolResolution {
    if (error instanceof ChzClaudeCodeDependencyError) {
      return { outcome: "blocked", symbol, reason: error.message, todo: error.todo };
    }
    const message = (error as Error).message;
    // A Claude Code that cannot be spawned is an environment problem, not
    // something a human fixes by editing the .chz.ts source (docs/63).
    if (/\bENOENT\b|not found|could not be spawned|spawn /i.test(message)) {
      return {
        outcome: "blocked",
        symbol,
        reason: `Claude Code could not be started: ${message}`,
        todo: "Install Claude Code, or point ClaudeCodeRealizer at it with the claudePath option, then rerun chz realize.",
      };
    }
    return { outcome: "failed", symbol, reason: `Claude Code session failed: ${message}` };
  }

  #endedWithoutTermination(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
    result: ChzClaudeCodeResultMessage | undefined,
    environmentError: string | undefined,
  ): ChzImagineSymbolResolution {
    if (result?.subtype === "error_max_budget_usd") {
      const spent = result.total_cost_usd;
      const cap = this.#options.maxBudgetUsd;
      return {
        outcome: "blocked",
        symbol,
        reason: `Claude Code stopped at its cost budget${cap === undefined ? "" : ` ($${cap})`} after ${result.num_turns ?? 0} turns${spent === undefined ? "" : ` ($${spent.toFixed(2)} spent)`}.`,
        todo: "Raise maxBudgetUsd on the ClaudeCodeRealizer in chz.config.js, or narrow the symbol's requirements, then rerun chz realize.",
      };
    }
    if (environmentError !== undefined) {
      return {
        outcome: "blocked",
        symbol,
        reason: `Claude Code could not reach the model: ${environmentError}.`,
        todo:
          environmentError === "billing_error"
            ? "Resolve the billing problem on the Claude account, then rerun chz realize."
            : "Authenticate Claude Code (run `claude` and sign in), then rerun chz realize.",
      };
    }
    if (result?.subtype === "error_max_turns") {
      return {
        outcome: "failed",
        symbol,
        reason: `Turn limit (${context.maxTurns}) reached without Finish, Block, or Abort.`,
      };
    }
    if (result?.subtype === "error_during_execution") {
      const detail = result.errors?.join("; ") ?? result.result ?? "no detail reported";
      return { outcome: "failed", symbol, reason: `Claude Code session failed: ${detail}` };
    }
    if (result === undefined) {
      return {
        outcome: "failed",
        symbol,
        reason: "Claude Code produced no result for this session.",
      };
    }
    return {
      outcome: "failed",
      symbol,
      reason: "Claude Code ended the session without Finish, Block, or Abort.",
    };
  }
}

/** Runs queued work one item at a time, in arrival order. */
class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    // Keep the chain alive when a task rejects; the caller still sees the error.
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Rebuilds the loop's `turn` and `reasoning` events from the message stream.
 * Claude Code may split one API turn across several assistant messages that
 * share a `message.id`, so the id — not the message count — is the turn key.
 */
class TurnTracker {
  #turn = 0;
  #lastMessageId: string | undefined;

  constructor(
    private readonly realizer: string,
    private readonly maxTurns: number,
    private readonly session: ChzHarnessSession,
  ) {}

  observe(message: ChzClaudeCodeAssistantMessage): void {
    // Subagent output carries the spawning tool call's id; only the main
    // conversation counts as a harness turn.
    if (message.parent_tool_use_id != null) return;

    const id = message.message?.id;
    if (id !== undefined && id !== this.#lastMessageId) {
      this.#lastMessageId = id;
      this.#turn += 1;
      this.session.emit({
        kind: "turn",
        realizer: this.realizer,
        turn: this.#turn,
        maxTurns: this.maxTurns,
        text: `[${this.realizer}] turn ${this.#turn}/${this.maxTurns}`,
      });
    }

    for (const block of message.message?.content ?? []) {
      if (block.type !== "thinking") continue;
      const thinking = (block as ChzClaudeCodeThinkingBlock).thinking?.trim();
      if (!thinking) continue;
      this.session.emit({
        kind: "reasoning",
        realizer: this.realizer,
        turn: this.#turn,
        maxTurns: this.maxTurns,
        text: thinking,
      });
    }
  }
}

/**
 * Converts CLI-style flags into the SDK's flag record. `--key value` and
 * `--key=value` both yield a value; a flag with no value becomes `null`, which
 * is how the SDK spells a boolean flag.
 */
export function parseExtraArgs(args: readonly string[]): Record<string, string | null> {
  const parsed: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      parsed[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[body] = next;
      index += 1;
    } else {
      parsed[body] = null;
    }
  }
  return parsed;
}

function isInit(message: ChzClaudeCodeMessage): message is ChzClaudeCodeInitMessage {
  return message.type === "system" && (message as { subtype?: string }).subtype === "init";
}

function isAssistant(message: ChzClaudeCodeMessage): message is ChzClaudeCodeAssistantMessage {
  return message.type === "assistant";
}

function isResult(message: ChzClaudeCodeMessage): message is ChzClaudeCodeResultMessage {
  return message.type === "result";
}

/** The harness tools are the only tools; a server that never connected is fatal. */
function describeToolServerFailure(message: ChzClaudeCodeInitMessage): string | undefined {
  const server = message.mcp_servers?.find((candidate) => candidate.name === MCP_SERVER_NAME);
  if (server === undefined) {
    return "The chz harness tool server was not registered with Claude Code, so the session had no tools to work with.";
  }
  if (server.status === "failed" || server.status === "needs-auth") {
    return `The chz harness tool server did not start (status: ${server.status}), so the session had no tools to work with.`;
  }
  return undefined;
}

function classifyAssistantError(message: ChzClaudeCodeAssistantMessage): string | undefined {
  return message.error !== undefined && ENVIRONMENT_ERRORS.has(message.error)
    ? message.error
    : undefined;
}
