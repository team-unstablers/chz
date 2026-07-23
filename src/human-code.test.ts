import { describe, expect, it } from "vitest";

import { splitHumanCode } from "./human-code.ts";
import { extractImagineSpecs } from "./preprocessor.ts";

function split(source: string) {
  const fileName = "/project/example.chz.ts";
  return splitHumanCode(source, fileName, extractImagineSpecs(source, fileName));
}

describe("splitHumanCode", () => {
  it("splits direct and transitive imagine references into the epilogue", () => {
    const source = [
      'const prefix = "Ahoy";',
      "function decorate(name: string): string { return `${prefix}, ${name}!`; }",
      "imagine function greet(name: string): string {",
      "  requirements(`이름을 반환합니다.`);",
      "}",
      'const message = greet("Cheese");',
      "console.log(decorate(message));",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain('const prefix = "Ahoy";');
    expect(result.prologue).toContain("function decorate");
    expect(result.prologue).toContain("export { prefix, decorate };");
    expect(result.prologue).not.toContain("const message");
    expect(result.epilogue).toContain(
      'import { prefix, decorate } from "./__prologue__.ts";',
    );
    expect(result.epilogue).toContain('import { greet } from "./greet.ts";');
    expect(result.epilogue).toContain('const message = greet("Cheese");');
    expect(result.epilogue).toContain("console.log(decorate(message));");
    expect(result.epilogue).not.toContain("imagine function");
  });

  it("does not mistake strings, property names, or shadowed parameters for imagine references", () => {
    const source = [
      'const label = "greet";',
      'const object = { greet: "property" };',
      "function shadow(greet: string): string { return greet; }",
      "imagine function greet(name: string): string { requirements(`인사합니다.`); }",
      "console.log(label, object.greet, shadow(label));",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain("console.log(label, object.greet, shadow(label));");
    expect(result.epilogue).toBe("export {};\n");
  });

  it("keeps existing named exports without emitting a conflicting duplicate export", () => {
    const source = [
      'export const prefix = "Hi";',
      "imagine function greet(): string { requirements(`인사합니다.`); }",
      "console.log(prefix, greet());",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain('export const prefix = "Hi";');
    expect(result.prologue).not.toContain("export { prefix };");
    expect(result.epilogue).toContain('import { prefix } from "./__prologue__.ts";');
  });

  it("emits valid empty modules when the source contains only imagine declarations", () => {
    const source = "imagine function greet(): string { requirements(`인사합니다.`); }\n";

    expect(split(source)).toEqual({
      prologue: "export {};\n",
      epilogue: "export {};\n",
    });
  });

  it("keeps standalone comments while still marking the prologue as a module", () => {
    const source = [
      "// Human-owned source documentation.",
      "imagine function greet(): string { requirements(`인사합니다.`); }",
      "",
    ].join("\n");

    expect(split(source).prologue).toBe(
      "// Human-owned source documentation.\n\nexport {};\n",
    );
  });
});
