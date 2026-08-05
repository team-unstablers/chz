/** The fixed harness tool surface from docs/63, in advertised order.
 *
 * This catalog is the single source of truth for every transport: the shared
 * agentic loop (`ChzRealizerBase`) advertises it directly, and
 * `ClaudeCodeRealizer` republishes the same JSON Schemas over MCP. Keeping it
 * out of `base.ts` lets a Realizer that deliberately does not inherit the
 * shared loop reach the catalog without importing the loop.
 */

import type { ChzToolDefinition } from "../types.ts";

const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const pathProperty = {
  type: "string",
  description:
    "An absolute path, or a path relative to the project root; a relative path that does not resolve there is also tried against the realization output directory.",
};
const pageProperties = {
  offset: { type: "integer", minimum: 1, description: "One-based starting line or entry." },
  limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum results." },
};

/** The complete, fixed harness tool surface from docs/63, in advertised order. */
export const CHZ_HARNESS_TOOLS: readonly ChzToolDefinition[] = [
  {
    name: "WriteFile",
    description:
      "Create or replace the complete contents of one non-sensitive file for the current increment inside the realization output directory. The file may be revised in later turns. Existing files must first be read with ReadFile. Parent directories are created automatically and inline diagnostics are returned.",
    inputSchema: objectSchema({ path: pathProperty, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "FindAndReplace",
    description:
      "Replace an exact string in a non-sensitive file inside the realization output directory. Read the file first. Whitespace and indentation must match exactly; set replaceAll only when every exact occurrence should change.",
    inputSchema: objectSchema(
      {
        path: pathProperty,
        oldString: { type: "string", minLength: 1 },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      ["path", "oldString", "newString"],
    ),
  },
  {
    name: "RunTests",
    description:
      "Run the engine-fixed vitest runner. Pass output-directory test files, or an empty array to run every test in this session's scope (the autogen and ensure tests of every symbol this session realizes, including all cycle members). This is useful feedback; Finish still triggers independent verification.",
    inputSchema: objectSchema({ testFiles: { type: "array", items: { type: "string" } } }, ["testFiles"]),
  },
  {
    name: "RunTypeCheck",
    description:
      "Run the engine-fixed strict TypeScript check over this session's scope files and everything they import.",
    inputSchema: objectSchema(),
  },
  {
    name: "RunLinter",
    description:
      "Run the engine-fixed restricted-subset linter over realized code, including no eval, no any, and no __epilogue__ imports.",
    inputSchema: objectSchema(),
  },
  {
    name: "ReadFile",
    description:
      "Read a UTF-8 text file with line-number prefixes. Use it freely on your own artifacts in the output directory; read any other project file only to fetch a specific fact that a concrete next edit is blocked on — never to survey the codebase or learn conventions. Sensitive paths such as chz.config.js and .env files (except .env.example) are inaccessible, as are any paths the project blocked in its configuration; the blocked ones are listed in <env>. Continue with a larger offset; prefer a large window over tiny repeated slices. Use Grep for specific content and Glob for uncertain paths. Do not copy line-number prefixes into edits.",
    inputSchema: objectSchema({ path: pathProperty, ...pageProperties }, ["path"]),
  },
  {
    name: "ReadDir",
    description:
      "List a directory inside the project root, only when a specific missing fact, such as an exact artifact path, blocks the next concrete edit — never to orient yourself in the codebase. Excludes sensitive and project-blocked paths; directories first and then lexically, with deterministic paging.",
    inputSchema: objectSchema({ path: pathProperty, ...pageProperties }, ["path"]),
  },
  {
    name: "Glob",
    description:
      "Find files by a gitignore-style glob inside the project root, only when a missing exact path blocks the next concrete edit — never to survey the project. Sensitive and project-blocked paths are excluded. Results are project-relative and unordered; do not rely on result order.",
    inputSchema: objectSchema(
      {
        pattern: { type: "string" },
        path: pathProperty,
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      ["pattern"],
    ),
  },
  {
    name: "Grep",
    description:
      "Search non-sensitive UTF-8 project files with a ripgrep/Rust regular expression, only when a specific missing fact blocks the next concrete edit — never to browse for conventions or similar code. Use include to restrict file names.",
    inputSchema: objectSchema(
      {
        pattern: { type: "string" },
        path: pathProperty,
        include: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      ["pattern"],
    ),
  },
  {
    name: "AskUser",
    description:
      "Ask the human one or more structural questions. Group related decisions into one call; put a recommended option first and suffix its label with (Recommended). Do not add an Other option because the UI supplies free-form input.",
    inputSchema: objectSchema(
      {
        questions: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              question: { type: "string", minLength: 1 },
              header: { type: "string", minLength: 1, maxLength: 30 },
              options: {
                type: "array",
                minItems: 2,
                items: objectSchema(
                  { label: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } },
                  ["label", "description"],
                ),
              },
              multiple: { type: "boolean" },
            },
            ["question", "header", "options"],
          ),
        },
      },
      ["questions"],
    ),
  },
  {
    name: "Finish",
    description: "Claim that implementation and tests are complete, then end the session for independent verification.",
    inputSchema: objectSchema(),
  },
  {
    name: "Block",
    description:
      "End the session because a concrete human action is required. State what is missing and an executable todo that unblocks a later realize run.",
    inputSchema: objectSchema({ reason: { type: "string", minLength: 1 }, todo: { type: "string", minLength: 1 } }, ["reason", "todo"]),
  },
  {
    name: "Abort",
    description:
      "End the session because the request is contradictory, impossible, or inappropriate. Use Block instead when environment preparation would unblock it.",
    inputSchema: objectSchema({ reason: { type: "string", minLength: 1 } }, ["reason"]),
  },
] as const;

export const TERMINAL_TOOL_NAMES = new Set(["Finish", "Block", "Abort"]);
export const TERMINAL_TOOLS = CHZ_HARNESS_TOOLS.filter((tool) => TERMINAL_TOOL_NAMES.has(tool.name));
