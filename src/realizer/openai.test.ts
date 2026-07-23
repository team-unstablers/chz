import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "../preprocessor.ts";
import { imagineSpecToSymbol } from "../realize.ts";
import { ChzOpenAIRealizer } from "./openai.ts";
import type { ChzRealizeContext } from "./types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ChzOpenAIRealizer", () => {
  it("maps the shared loop to OpenAI-compatible Chat Completions tool calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-openai-realizer-"));
    roots.push(root);
    const sourceFile = join(root, "demo.chz.ts");
    const source = "imagine function answer(): number { ensure(answer() === 42, '42를 반환합니다.'); }\n";
    writeFileSync(sourceFile, source, "utf8");
    const symbol = imagineSpecToSymbol(extractImagineSpecs(source, sourceFile)[0]!, source, sourceFile);
    const outputDir = join(root, "chz", "realization", "demo");
    const implementation = join(outputDir, "implementations", "answer.ts");
    const test = join(outputDir, "tests", "test_answer.autogen.ts");
    const requests: Array<Record<string, unknown>> = [];
    const reasoningEvents: string[] = [];
    const providerResponses: unknown[] = [
      {
        choices: [{ message: { content: null, reasoning_content: "I should write the implementation and its test.", tool_calls: [
          { id: "impl", type: "function", function: { name: "WriteFile", arguments: JSON.stringify({ path: implementation, content: "export function answer(): number { return 42; }\\n" }) } },
          { id: "test", type: "function", function: { name: "WriteFile", arguments: JSON.stringify({ path: test, content: "export {};\\n" }) } },
        ] } }],
      },
      {
        choices: [{ message: { content: null, tool_calls: [
          { id: "finish", type: "function", function: { name: "Finish", arguments: "{}" } },
        ] } }],
      },
    ];
    const client = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            const next = providerResponses.shift();
            if (next === undefined) throw new Error("provider response queue exhausted");
            return next;
          },
        },
      },
    } as unknown as OpenAI;
    const realizer = new ChzOpenAIRealizer({
      model: "compatible-model",
      client,
      maxApiRetries: 0,
    });
    const context: ChzRealizeContext = {
      projectRoot: root,
      outputDir,
      activeProfile: "console",
      resolvedDependencies: [],
      maxTurns: 2,
      maxRetries: 0,
      baseContexts: "",
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      harness: { onModelReasoning: (message) => reasoningEvents.push(message) },
    };

    const result = await realizer.realize(symbol, context);

    expect(result.outcome).toBe("resolved");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe("compatible-model");
    expect(requests.every((request) => request.temperature === 0.2)).toBe(true);
    const messages = requests[0]!.messages as Array<{ role: string; content: string }>;
    expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["system", "system"]);
    const tools = requests[0]!.tools as Array<{ function: { name: string; strict?: boolean } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("ReadFile");
    expect(tools[0]!.function.strict).toBeUndefined();
    const secondTools = requests[1]!.tools as Array<{ function: { name: string } }>;
    expect(secondTools.map((tool) => tool.function.name)).toEqual(["Finish", "Block", "Abort"]);
    expect(reasoningEvents).toEqual([
      "[ChzOpenAIRealizer] reasoning turn 1/2\nI should write the implementation and its test.",
    ]);
    expect(JSON.stringify(requests[1]!.messages)).not.toContain("I should write the implementation");
  });
});
