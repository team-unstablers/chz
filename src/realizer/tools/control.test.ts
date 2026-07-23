import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChzAskUserQuestion,
  ChzImagineSymbol,
  ChzRealizeContext,
} from "../types.ts";
import { ChzControlToolRuntime } from "./control.ts";

const SYMBOL: ChzImagineSymbol = {
  name: "MyFunnyGame",
  type: "class",
  definition: "imagine class MyFunnyGame {}",
  file: "game.chz.ts",
  posLine: 1,
  posCol: 1,
  dependencies: [],
  circularDependencies: [],
};

const QUESTION = {
  question: "Should the realization use three.js?",
  header: "Dependency",
  options: [
    { label: "Use it (Recommended)", description: "Use three.js for rendering." },
    { label: "Do not use it", description: "Use WebGL without dependencies." },
  ],
};

const tempDirs: string[] = [];

async function makeContext(
  overrides: Partial<ChzRealizeContext> = {},
): Promise<ChzRealizeContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), "chz-control-"));
  tempDirs.push(projectRoot);
  return {
    projectRoot,
    outputDir: join(projectRoot, "chz", "realization", SYMBOL.name),
    activeProfile: "console",
    resolvedDependencies: [],
    maxTurns: 20,
    maxRetries: 3,
    baseContexts: "",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ChzControlToolRuntime AskUser", () => {
  it("round-trips answers, defaults multiple to false, and records the decision", async () => {
    let received: ChzAskUserQuestion[] | undefined;
    const context = await makeContext({
      now: () => new Date("2026-07-23T12:34:56.000Z"),
      askUser: async (questions) => {
        received = questions;
        return [["Use it (Recommended)"]];
      },
    });
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    const result = await runtime.execute("AskUser", { questions: [QUESTION] });

    expect(received?.[0]?.multiple).toBe(false);
    expect(result).toEqual({
      output:
        'User has answered your questions: "Should the realization use three.js?"="Use it (Recommended)". You can now continue with the user\'s answers in mind.',
    });
    expect(await readFile(join(context.outputDir, "CONTEXTS.md"), "utf8")).toBe(
      [
        "## MyFunnyGame",
        "",
        "- **Q**: Should the realization use three.js?",
        "- **A**: Use it (Recommended) (2026-07-23T12:34:56.000Z)",
        "",
      ].join("\n"),
    );
  });

  it("preserves existing contexts and records multiple and unanswered decisions", async () => {
    const context = await makeContext({
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      askUser: async () => [["A", "B"], []],
    });
    await mkdir(context.outputDir, { recursive: true });
    await writeFile(join(context.outputDir, "CONTEXTS.md"), "# Existing decision\n", "utf8");
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    const result = await runtime.execute("AskUser", {
      questions: [
        { ...QUESTION, multiple: true },
        { ...QUESTION, question: "Which fallback should be used?" },
      ],
    });

    expect(result?.output).toContain('"Should the realization use three.js?"="A, B"');
    expect(result?.output).toContain('"Which fallback should be used?"="Unanswered"');
    const contexts = await readFile(join(context.outputDir, "CONTEXTS.md"), "utf8");
    expect(contexts).toContain("# Existing decision\n\n## MyFunnyGame");
    expect(contexts).toContain("- **A**: A, B (2026-07-23T00:00:00.000Z)");
    expect(contexts).toContain("- **A**: Unanswered (2026-07-23T00:00:00.000Z)");
  });

  it("enforces the structural schema while treating label length as guidance", async () => {
    const askUser = vi.fn(async () => [["This label deliberately contains more than five words"]]);
    const context = await makeContext({ askUser });
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    const longHeader = await runtime.execute("AskUser", {
      questions: [{ ...QUESTION, header: "x".repeat(31) }],
    });
    expect(longHeader?.output).toBe(
      "Invalid tool input: questions[0].header must contain at most 30 characters. Please rewrite the input so it satisfies the expected schema.",
    );

    const tooFewOptions = await runtime.execute("AskUser", {
      questions: [{ ...QUESTION, options: [QUESTION.options[0]] }],
    });
    expect(tooFewOptions?.output).toContain("questions[0].options must contain at least 2 choices");

    const invalidMultiple = await runtime.execute("AskUser", {
      questions: [{ ...QUESTION, multiple: "yes" }],
    });
    expect(invalidMultiple?.output).toContain("questions[0].multiple must be a boolean");

    const longLabel = "This label deliberately contains more than five words";
    const accepted = await runtime.execute("AskUser", {
      questions: [
        {
          ...QUESTION,
          options: [
            { label: longLabel, description: "Still valid; the word count is guidance." },
            QUESTION.options[1],
          ],
        },
      ],
    });
    expect(accepted?.output).toContain(`=${JSON.stringify(longLabel)}`);
    expect(askUser).toHaveBeenCalledTimes(1);
  });

  it("automatically blocks when the session has no interactive question service", async () => {
    const context = await makeContext();
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    const result = await runtime.execute("AskUser", { questions: [QUESTION] });

    expect(result?.terminal).toEqual({
      kind: "blocked",
      reason: "User input is required, but this realize session is non-interactive.",
      todo:
        "Answer these questions and rerun chz realize: [Dependency] Should the realization use three.js?",
    });
    expect(result?.output).toContain("AskUser is unavailable in this non-interactive session");
  });

  it("also blocks when the injected question service refuses interaction", async () => {
    const context = await makeContext({
      askUser: async () => {
        throw new Error("non-interactive");
      },
    });
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    const result = await runtime.execute("AskUser", { questions: [QUESTION] });

    expect(result?.terminal?.kind).toBe("blocked");
    expect(result?.terminal).toMatchObject({ todo: expect.stringContaining(QUESTION.question) });
  });

  it("treats malformed answers as an internal harness error", async () => {
    const context = await makeContext({ askUser: async () => [] });
    const runtime = new ChzControlToolRuntime(SYMBOL, context);

    await expect(runtime.execute("AskUser", { questions: [QUESTION] })).rejects.toThrow(
      "AskUser service returned invalid answers",
    );
  });
});

describe("ChzControlToolRuntime terminal tools", () => {
  it("returns null for tools owned by another runtime", async () => {
    const runtime = new ChzControlToolRuntime(SYMBOL, await makeContext());
    await expect(runtime.execute("ReadFile", {})).resolves.toBeNull();
  });

  it("validates Finish input before ending successfully", async () => {
    const runtime = new ChzControlToolRuntime(SYMBOL, await makeContext());

    const invalid = await runtime.execute("Finish", { claim: true });
    expect(invalid?.output).toContain("Invalid tool input: Finish expects an empty object");
    expect(invalid?.terminal).toBeUndefined();

    expect(await runtime.execute("Finish", {})).toEqual({
      output: "Completion claimed. The engine will now run independent verification.",
      terminal: { kind: "finish" },
    });
  });

  it("validates and returns Block's reason and concrete todo", async () => {
    const runtime = new ChzControlToolRuntime(SYMBOL, await makeContext());

    expect((await runtime.execute("Block", { reason: "missing dependency" }))?.output).toContain(
      "Block.todo must be a non-empty string",
    );
    expect(
      await runtime.execute("Block", {
        reason: "three.js is not installed.",
        todo: "Run `npm install three`, then rerun `chz realize`.",
      }),
    ).toEqual({
      output:
        "Session blocked: three.js is not installed.\nTODO: Run `npm install three`, then rerun `chz realize`.",
      terminal: {
        kind: "blocked",
        reason: "three.js is not installed.",
        todo: "Run `npm install three`, then rerun `chz realize`.",
      },
    });
  });

  it("validates and returns Abort's reason", async () => {
    const runtime = new ChzControlToolRuntime(SYMBOL, await makeContext());

    expect((await runtime.execute("Abort", { reason: " " }))?.output).toContain(
      "Abort.reason must be a non-empty string",
    );
    expect(await runtime.execute("Abort", { reason: "The contracts contradict each other." })).toEqual({
      output: "Session aborted: The contracts contradict each other.",
      terminal: { kind: "aborted", reason: "The contracts contradict each other." },
    });
  });

  it("keeps the first terminal state and rejects every later control call", async () => {
    const runtime = new ChzControlToolRuntime(SYMBOL, await makeContext());
    await runtime.execute("Finish", {});

    expect(await runtime.execute("Abort", { reason: "changed mind" })).toEqual({
      output: "Session has already ended with Finish. Do not call another tool.",
      terminal: { kind: "finish" },
    });
    expect(await runtime.execute("AskUser", { questions: [QUESTION] })).toEqual({
      output: "Session has already ended with Finish. Do not call another tool.",
      terminal: { kind: "finish" },
    });
  });
});
