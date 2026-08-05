import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeChzSource } from "../../compiler/index.ts";
import { buildEstimatedRealizeOrder } from "../../realize.ts";
import type { ChzHarnessEvent, ChzImagineSymbol, ChzRealizeContext } from "../types.ts";
import { ClaudeCodeRealizer, parseExtraArgs, type ClaudeCodeRealizerOptions } from "./index.ts";
import {
  ChzClaudeCodeDependencyError,
  type ChzClaudeCodeMessage,
  type ChzClaudeCodeQuery,
  type ChzClaudeCodeToolServer,
  type ChzToolDispatch,
} from "./bridge.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Script = (dispatch: ChzToolDispatch) => AsyncGenerator<ChzClaudeCodeMessage>;

/** Drives the realizer without the optional Claude Code dependencies installed. */
class FakeClaudeCodeRealizer extends ClaudeCodeRealizer {
  readonly seenOptions: Array<Record<string, unknown>> = [];
  readonly seenPrompts: string[] = [];
  loadFailure: unknown;

  #dispatch: ChzToolDispatch | undefined;

  constructor(
    options: ClaudeCodeRealizerOptions,
    private readonly script: Script,
  ) {
    super(options);
  }

  protected override async loadQuery(): Promise<ChzClaudeCodeQuery> {
    if (this.loadFailure !== undefined) throw this.loadFailure;
    return ({ prompt, options }) => {
      this.seenPrompts.push(prompt);
      this.seenOptions.push(options);
      return this.script(this.#dispatch!);
    };
  }

  protected override async createToolServer(
    dispatch: ChzToolDispatch,
  ): Promise<ChzClaudeCodeToolServer> {
    this.#dispatch = dispatch;
    return { type: "sdk", name: "chz", instance: {} };
  }
}

function init(status = "connected"): ChzClaudeCodeMessage {
  return { type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "chz", status }] };
}

function assistant(id: string, thinking?: string): ChzClaudeCodeMessage {
  return {
    type: "assistant",
    message: { id, content: thinking === undefined ? [] : [{ type: "thinking", thinking }] },
    parent_tool_use_id: null,
  };
}

interface Fixture {
  root: string;
  symbol: ChzImagineSymbol;
  outputDir: string;
  implementation: string;
  test: string;
  events: ChzHarnessEvent[];
  context: ChzRealizeContext;
}

function fixture(maxTurns = 4): Fixture {
  const root = mkdtempSync(join(tmpdir(), "chz-claude-code-realizer-"));
  roots.push(root);
  const sourceFile = join(root, "demo.chz.ts");
  const source =
    "imagine function answer(): number { ensure(answer() === 42, '42를 반환합니다.'); }\n";
  writeFileSync(sourceFile, source, "utf8");
  const analysis = analyzeChzSource(source, sourceFile);
  const symbol = buildEstimatedRealizeOrder(analysis)[0]!;
  analysis.dispose();

  const outputDir = join(root, "chz", "realization", "demo");
  const events: ChzHarnessEvent[] = [];
  return {
    root,
    symbol,
    outputDir,
    implementation: join(outputDir, "implementations", "answer.ts"),
    test: join(outputDir, "tests", "test_answer.autogen.ts"),
    events,
    context: {
      projectRoot: root,
      outputDir,
      activeProfile: "console",
      resolvedDependencies: [],
      maxTurns,
      maxRetries: 0,
      baseContexts: "",
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      harness: { onEvent: (event) => events.push(event) },
    },
  };
}

describe("ClaudeCodeRealizer", () => {
  it("delegates the loop while keeping the chz tool surface, and resolves on Finish", async () => {
    const f = fixture();
    const realizer = new FakeClaudeCodeRealizer(
      { model: "opus", effort: "high", maxBudgetUsd: 2 },
      async function* (dispatch) {
        yield init();
        yield assistant("msg-1", "Writing the implementation first.");
        // Claude Code splits one API turn across messages sharing an id.
        yield assistant("msg-1");
        await dispatch("WriteFile", {
          path: f.implementation,
          content: "export function answer(): number {\n  return 42;\n}\n",
        });
        await dispatch("WriteFile", { path: f.test, content: "export {};\n" });
        yield assistant("msg-2");
        await dispatch("Finish", {});
        yield { type: "result", subtype: "success", num_turns: 2 };
      },
    );

    const result = await realizer.realize(f.symbol, f.context);

    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.resolvedFile).toBe(f.implementation);
    expect(result.resolvedTestFiles).toEqual([f.test]);
    expect(result.resolvedBy).toBe("opus");

    // One turn per distinct message id, not per assistant message.
    const turns = f.events.filter((event) => event.kind === "turn").map((event) => event.text);
    expect(turns).toEqual([
      "[ClaudeCodeRealizer] turn 1/4",
      "[ClaudeCodeRealizer] turn 2/4",
    ]);
    expect(f.events.filter((event) => event.kind === "reasoning").map((event) => event.text)).toEqual([
      "Writing the implementation first.",
    ]);
    const tools = f.events.filter((event) => event.kind === "tool");
    expect(tools.map((event) => event.tool)).toEqual(["WriteFile", "WriteFile", "Finish"]);
    expect(tools.at(-1)!.outcome).toBe("finished");
  });

  it("hands Claude Code the canonical prompt and no built-in tools", async () => {
    const f = fixture();
    const realizer = new FakeClaudeCodeRealizer(
      { model: "opus", effort: "xhigh", maxBudgetUsd: 5, claudePath: "/opt/claude", env: { CHZ_TEST: "1" }, extraArgs: ["--fallback-model", "sonnet"] },
      async function* (dispatch) {
        yield init();
        await dispatch("Abort", { reason: "not needed for this assertion" });
      },
    );

    await realizer.realize(f.symbol, f.context);

    const options = realizer.seenOptions[0]!;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(["mcp__chz__*"]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.persistSession).toBe(false);
    expect(options.maxTurns).toBe(4);
    expect(options.cwd).toBe(f.root);
    expect(options.model).toBe("opus");
    expect(options.effort).toBe("xhigh");
    expect(options.maxBudgetUsd).toBe(5);
    expect(options.pathToClaudeCodeExecutable).toBe("/opt/claude");
    expect(options.extraArgs).toEqual({ "fallback-model": "sonnet" });

    // The docs/64 fixed part, the cache boundary, then the session baseline.
    const systemPrompt = options.systemPrompt as string[];
    expect(systemPrompt).toHaveLength(3);
    expect(systemPrompt[1]).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    expect(systemPrompt[0]).toContain("Division of roles");
    expect(systemPrompt[2]).toContain("Project root (read boundary)");
    expect(realizer.seenPrompts[0]).toContain("Realize `answer` now.");

    // env replaces the child environment outright, so PATH has to survive.
    const env = options.env as Record<string, string>;
    expect(env.CHZ_TEST).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("reports Block as blocked and Abort as failed", async () => {
    const blockedFixture = fixture();
    const blocked = await new FakeClaudeCodeRealizer({ model: "opus" }, async function* (dispatch) {
      yield init();
      await dispatch("Block", { reason: "three.js is not installed", todo: "Run `npm install three`." });
    }).realize(blockedFixture.symbol, blockedFixture.context);

    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome === "blocked") {
      expect(blocked.reason).toBe("three.js is not installed");
      expect(blocked.todo).toBe("Run `npm install three`.");
    }

    const abortedFixture = fixture();
    const aborted = await new FakeClaudeCodeRealizer({ model: "opus" }, async function* (dispatch) {
      yield init();
      await dispatch("Abort", { reason: "the request is self-contradictory" });
    }).realize(abortedFixture.symbol, abortedFixture.context);

    expect(aborted.outcome).toBe("failed");
    if (aborted.outcome === "failed") {
      expect(aborted.reason).toBe("the request is self-contradictory");
    }
  });

  it("maps every non-terminating session ending", async () => {
    const cases: Array<{
      message: ChzClaudeCodeMessage;
      outcome: string;
      reason: string | RegExp;
    }> = [
      {
        message: { type: "result", subtype: "error_max_turns", num_turns: 4 },
        outcome: "failed",
        reason: "Turn limit (4) reached without Finish, Block, or Abort.",
      },
      {
        message: { type: "result", subtype: "error_during_execution", errors: ["transport closed"] },
        outcome: "failed",
        reason: "Claude Code session failed: transport closed",
      },
      {
        message: { type: "result", subtype: "success", num_turns: 1 },
        outcome: "failed",
        reason: "Claude Code ended the session without Finish, Block, or Abort.",
      },
      {
        message: { type: "result", subtype: "error_max_budget_usd", num_turns: 9, total_cost_usd: 2.5 },
        outcome: "blocked",
        reason: /cost budget \(\$2\) after 9 turns \(\$2\.50 spent\)/,
      },
    ];

    for (const testCase of cases) {
      const f = fixture();
      const result = await new FakeClaudeCodeRealizer(
        { model: "opus", maxBudgetUsd: 2 },
        async function* () {
          yield init();
          yield testCase.message;
        },
      ).realize(f.symbol, f.context);

      expect(result.outcome).toBe(testCase.outcome);
      const reason = (result as { reason: string }).reason;
      if (typeof testCase.reason === "string") expect(reason).toBe(testCase.reason);
      else expect(reason).toMatch(testCase.reason);
    }
  });

  it("blocks rather than fails when the environment is the problem", async () => {
    const missing = fixture();
    const missingRealizer = new FakeClaudeCodeRealizer({ model: "opus" }, async function* () {
      yield init();
    });
    missingRealizer.loadFailure = new ChzClaudeCodeDependencyError(
      "@anthropic-ai/claude-agent-sdk",
      undefined,
    );
    const dependency = await missingRealizer.realize(missing.symbol, missing.context);
    expect(dependency.outcome).toBe("blocked");
    if (dependency.outcome === "blocked") {
      expect(dependency.todo).toContain("npm install @anthropic-ai/claude-agent-sdk");
    }

    const spawnFixture = fixture();
    const spawnRealizer = new FakeClaudeCodeRealizer({ model: "opus" }, async function* () {
      yield init();
    });
    spawnRealizer.loadFailure = new Error("spawn claude ENOENT");
    const spawned = await spawnRealizer.realize(spawnFixture.symbol, spawnFixture.context);
    expect(spawned.outcome).toBe("blocked");
    if (spawned.outcome === "blocked") {
      expect(spawned.todo).toContain("claudePath");
    }

    const authFixture = fixture();
    const auth = await new FakeClaudeCodeRealizer({ model: "opus" }, async function* () {
      yield init();
      yield { type: "assistant", message: { id: "m1", content: [] }, error: "authentication_failed" };
      yield { type: "result", subtype: "error_during_execution", errors: ["authentication_failed"] };
    }).realize(authFixture.symbol, authFixture.context);
    expect(auth.outcome).toBe("blocked");
    if (auth.outcome === "blocked") {
      expect(auth.todo).toContain("Authenticate Claude Code");
    }
  });

  it("fails the session when the harness tool server never connects", async () => {
    const f = fixture();
    const result = await new FakeClaudeCodeRealizer({ model: "opus" }, async function* () {
      yield init("failed");
      yield { type: "result", subtype: "success" };
    }).realize(f.symbol, f.context);

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.reason).toContain("harness tool server did not start");
    }
  });

  it("serializes a concurrent tool batch, as the shared loop does", async () => {
    const f = fixture();
    const order: string[] = [];
    f.context.harness = {
      onEvent: (event) => {
        f.events.push(event);
        if (event.kind === "tool") order.push(`end:${event.tool}`);
      },
    };

    await new FakeClaudeCodeRealizer({ model: "opus" }, async function* (dispatch) {
      yield init();
      // Claude Code batches independent calls; the runtimes' read-before-write
      // bookkeeping is only sound if they still execute one at a time.
      await Promise.all([
        dispatch("WriteFile", { path: f.implementation, content: "export const a = 1;\n" }),
        dispatch("WriteFile", { path: f.test, content: "export const b = 2;\n" }),
        dispatch("ReadFile", { path: f.implementation }),
      ]);
      await dispatch("Abort", { reason: "assertion complete" });
    }).realize(f.symbol, f.context);

    expect(order).toEqual(["end:WriteFile", "end:WriteFile", "end:ReadFile", "end:Abort"]);
    // The read observes the completed write rather than racing it.
    const read = f.events.filter((event) => event.tool === "ReadFile").at(-1)!;
    expect(read.errored).toBe(false);
  });

  it("rejects Finish when the required artifacts are missing", async () => {
    const f = fixture();
    const result = await new FakeClaudeCodeRealizer({ model: "opus" }, async function* (dispatch) {
      yield init();
      await dispatch("WriteFile", { path: f.implementation, content: "export function answer(): number {\n  return 42;\n}\n" });
      await dispatch("Finish", {});
    }).realize(f.symbol, f.context);

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.reason).toContain("test_answer.autogen.ts");
    }
  });
});

describe("parseExtraArgs", () => {
  it("converts CLI flags into the SDK's flag record", () => {
    expect(parseExtraArgs(["--max-budget-usd", "10.5"])).toEqual({ "max-budget-usd": "10.5" });
    expect(parseExtraArgs(["--fallback-model=sonnet"])).toEqual({ "fallback-model": "sonnet" });
    expect(parseExtraArgs(["--verbose"])).toEqual({ verbose: null });
    expect(parseExtraArgs(["--verbose", "--effort", "max"])).toEqual({ verbose: null, effort: "max" });
    expect(parseExtraArgs(["stray", "--a", "1"])).toEqual({ a: "1" });
  });
});
