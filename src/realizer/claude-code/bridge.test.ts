import { describe, expect, it } from "vitest";

import { CHZ_HARNESS_TOOLS } from "../tools/catalog.ts";
import { createChzToolServer, loadClaudeCodeQuery } from "./bridge.ts";

/**
 * Speaks MCP to the in-process server the same way Claude Code does, so the
 * "raw JSON Schema, no Zod layer" claim is checked against the real library
 * rather than a stand-in.
 */
async function connectLoopback(server: { instance: unknown }): Promise<{
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (name: string, args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instance = server.instance as { connect: (transport: unknown) => Promise<void> };
  const client = new Client({ name: "chz-test", version: "0" });
  await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

  return {
    listTools: async () =>
      (await client.listTools()) as unknown as { tools: Array<Record<string, unknown>> },
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args as Record<string, unknown> })) as unknown as {
        content: Array<{ text: string }>;
        isError?: boolean;
      },
  };
}

describe("createChzToolServer", () => {
  it("republishes the docs/63 catalog verbatim, in advertised order", async () => {
    const server = await createChzToolServer(CHZ_HARNESS_TOOLS, async () => ({
      output: "",
      errored: false,
    }));
    const client = await connectLoopback(server);

    const listed = (await client.listTools()).tools;

    expect(listed.map((tool) => tool.name)).toEqual(CHZ_HARNESS_TOOLS.map((tool) => tool.name));
    // Write and verification tools lead; reading and searching follow (docs/63).
    expect(listed[0]!.name).toBe("WriteFile");
    expect(listed.at(-1)!.name).toBe("Abort");

    for (const [index, tool] of CHZ_HARNESS_TOOLS.entries()) {
      expect(listed[index]!.description).toBe(tool.description);
      // The schema survives the wire unchanged: no Zod rewrite, no drift.
      expect(listed[index]!.inputSchema).toEqual(tool.inputSchema);
      // Without this, tool search defers the schemas and the ordering signal dies.
      expect(listed[index]!._meta).toEqual({ "anthropic/alwaysLoad": true });
    }

    const askUser = listed.find((tool) => tool.name === "AskUser")!;
    const schema = askUser.inputSchema as {
      additionalProperties: boolean;
      properties: { questions: { minItems: number; items: { properties: { header: { maxLength: number } } } } };
    };
    // Constraints docs/63 requires at schema level rather than as runtime clamps.
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.questions.minItems).toBe(1);
    expect(schema.properties.questions.items.properties.header.maxLength).toBe(30);
  });

  it("passes arguments through unvalidated so the harness owns the error wording", async () => {
    const seen: Array<{ name: string; input: unknown }> = [];
    const server = await createChzToolServer(CHZ_HARNESS_TOOLS, async (name, input) => {
      seen.push({ name, input });
      return name === "Finish"
        ? { output: "Completion claimed.", errored: false }
        : {
            output: "Invalid tool input: questions must be a non-empty array. Please rewrite the input so it satisfies the expected schema.",
            errored: true,
          };
    });
    const client = await connectLoopback(server);

    const ok = await client.callTool("Finish", {});
    expect(ok.content[0]!.text).toBe("Completion claimed.");
    expect(ok.isError).toBeFalsy();

    // A payload that violates the schema must still reach the runtime, whose
    // canonical wording is what the model has to read.
    const bad = await client.callTool("AskUser", { questions: [], unexpected: true });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^Invalid tool input:/);
    expect(seen.at(-1)).toEqual({
      name: "AskUser",
      input: { questions: [], unexpected: true },
    });
  });
});

describe("loadClaudeCodeQuery", () => {
  it("loads query() from the installed Agent SDK", async () => {
    expect(typeof (await loadClaudeCodeQuery())).toBe("function");
  });
});
