/** The only place chz knows the Claude Code Agent SDK exists.
 *
 * Two rules keep this file small on purpose:
 *
 * 1. **Nothing here imports the SDK's types.** `package.json` maps the `chz`
 *    export straight at TypeScript sources, so a consumer's `tsc` compiles this
 *    file; a single `import type` would break every project that installed chz
 *    without the optional Claude Code dependencies. The structural contracts
 *    below cover exactly the fields chz reads, and the pinned versions in the
 *    dependency errors are the drift alarm.
 * 2. **The harness tool surface stays raw JSON Schema.** The SDK's `tool()`
 *    helper accepts Zod raw shapes only, but `mcpServers` also takes a live
 *    `McpServer` instance, and MCP's own wire format for `tools/list` *is* JSON
 *    Schema. Registering low-level handlers therefore republishes
 *    `CHZ_HARNESS_TOOLS` (docs/63) byte for byte, with no second schema to drift
 *    and no Zod layer stripping unknown keys before the runtimes can reject them
 *    with the canonical `Invalid tool input:` wording.
 */

import type { ChzToolDefinition } from "../types.ts";

/** Pinned versions, surfaced in the dependency error so a drift is actionable. */
export const CLAUDE_AGENT_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_RANGE = "^0.3.222";
export const MCP_SDK_SPECIFIER = "@modelcontextprotocol/sdk";
export const MCP_SDK_RANGE = "^1.29.0";

/**
 * Marks the boundary between the cache-friendly fixed part of a system prompt
 * and its per-session remainder. Exported by the SDK as a plain string constant;
 * inlined here so the boundary costs no import.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/** Advertises a tool's full schema up front instead of deferring it to tool search. */
const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

export interface ChzClaudeCodeThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ChzClaudeCodeBlock = ChzClaudeCodeThinkingBlock | { type: string };

export interface ChzClaudeCodeInitMessage {
  type: "system";
  subtype: "init";
  tools: string[];
  mcp_servers: { name: string; status: string }[];
}

export interface ChzClaudeCodeAssistantMessage {
  type: "assistant";
  /** One API turn may span several messages that share an `id`. */
  message: { id: string; content: ChzClaudeCodeBlock[] };
  parent_tool_use_id?: string | null;
  error?: string;
}

export type ChzClaudeCodeResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export interface ChzClaudeCodeResultMessage {
  type: "result";
  subtype: ChzClaudeCodeResultSubtype;
  num_turns?: number;
  total_cost_usd?: number;
  errors?: string[];
  result?: string;
}

export type ChzClaudeCodeMessage =
  | ChzClaudeCodeInitMessage
  | ChzClaudeCodeAssistantMessage
  | ChzClaudeCodeResultMessage
  | { type: string; subtype?: string };

export type ChzClaudeCodeQuery = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<ChzClaudeCodeMessage>;

/** A `{ type: "sdk" }` MCP server config carrying a live server instance. */
export interface ChzClaudeCodeToolServer {
  type: "sdk";
  name: string;
  instance: unknown;
}

/** Executes one advertised harness tool and renders the model-facing result. */
export type ChzToolDispatch = (
  name: string,
  input: unknown,
) => Promise<{ output: string; errored: boolean }>;

/** A required Claude Code dependency is missing; the caller reports it as blocked. */
export class ChzClaudeCodeDependencyError extends Error {
  readonly todo: string;

  constructor(specifier: string, cause: unknown) {
    super(
      `ClaudeCodeRealizer requires ${specifier}, which is not installed. It is an optional peer dependency so that projects using other Realizers do not pay for it.`,
      { cause },
    );
    this.name = "ChzClaudeCodeDependencyError";
    this.todo = `Run: npm install ${CLAUDE_AGENT_SDK_SPECIFIER}@${CLAUDE_AGENT_SDK_RANGE} ${MCP_SDK_SPECIFIER}@${MCP_SDK_RANGE}`;
  }
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Imports an optional dependency. The specifier is passed through a variable so
 * TypeScript resolves the module at runtime only — a literal would make the
 * whole project fail to typecheck wherever the package is absent.
 */
async function importOptional(specifier: string): Promise<Record<string, unknown>> {
  const moduleSpecifier: string = specifier;
  try {
    return (await import(moduleSpecifier)) as Record<string, unknown>;
  } catch (error) {
    if (isModuleNotFound(error)) throw new ChzClaudeCodeDependencyError(specifier, error);
    throw error;
  }
}

export async function loadClaudeCodeQuery(): Promise<ChzClaudeCodeQuery> {
  const sdk = await importOptional(CLAUDE_AGENT_SDK_SPECIFIER);
  const query = sdk.query;
  if (typeof query !== "function") {
    throw new Error(
      `${CLAUDE_AGENT_SDK_SPECIFIER} does not export query(). Expected ${CLAUDE_AGENT_SDK_RANGE}.`,
    );
  }
  return query as ChzClaudeCodeQuery;
}

/**
 * Publishes the harness tool catalog over an in-process MCP server. The array
 * order is the advertised order of docs/63 — writing and verification first,
 * reading and searching after — so `alwaysLoad` matters: without it tool search
 * defers every schema and that ordering signal never reaches the model.
 */
export async function createChzToolServer(
  tools: readonly ChzToolDefinition[],
  dispatch: ChzToolDispatch,
): Promise<ChzClaudeCodeToolServer> {
  const serverModule = await importOptional(`${MCP_SDK_SPECIFIER}/server/mcp.js`);
  const typesModule = await importOptional(`${MCP_SDK_SPECIFIER}/types.js`);

  const McpServer = serverModule.McpServer as new (
    info: { name: string; version: string },
    options?: { capabilities?: Record<string, unknown> },
  ) => {
    server: {
      setRequestHandler: (
        schema: unknown,
        handler: (request: { params: { name: string; arguments?: unknown } }) => unknown,
      ) => void;
    };
  };

  const mcp = new McpServer({ name: "chz", version: "0" }, { capabilities: { tools: {} } });

  mcp.server.setRequestHandler(typesModule.ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      _meta: ALWAYS_LOAD_META,
    })),
  }));

  mcp.server.setRequestHandler(typesModule.CallToolRequestSchema, async (request) => {
    // Deliberately unvalidated: the harness runtimes own input validation so
    // their canonical error wording survives (docs/63).
    const execution = await dispatch(request.params.name, request.params.arguments ?? {});
    return {
      content: [{ type: "text", text: execution.output }],
      isError: execution.errored,
    };
  });

  return { type: "sdk", name: "chz", instance: mcp };
}
