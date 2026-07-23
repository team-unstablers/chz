import { describe, expect, it } from "vitest";

import { createRenderer, displayWidth, truncateToWidth } from "./render.ts";
import type { ChzHarnessEvent } from "./realizer/types.ts";

const groupStart = (group: string, index: number, total: number): ChzHarnessEvent => ({
  kind: "group-start",
  group,
  label: group,
  index,
  total,
  text: `[chz-realize] [${index}/${total}] realizing ${group}`,
});

const groupEnd = (group: string, index: number, total: number): ChzHarnessEvent => ({
  kind: "group-end",
  group,
  label: group,
  index,
  total,
  status: "resolved",
  text: `[chz-realize] [${index}/${total}] [ OK ] ${group}`,
});

describe("width helpers", () => {
  it("counts Hangul and emoji as two columns", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("💭")).toBe(2);
  });

  it("truncates by display width, not code units", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
    expect(truncateToWidth("안녕하세요", 6)).toBe("안녕…");
    expect(truncateToWidth("anything", 0)).toBe("");
  });
});

describe("audit renderer", () => {
  it("indents reasoning under a per-realizer header", () => {
    const lines: string[] = [];
    const renderer = createRenderer({ simplify: false, color: false, err: (line) => lines.push(line) });
    renderer.event({
      kind: "reasoning",
      realizer: "R",
      turn: 1,
      maxTurns: 4,
      text: "두 원의 중심 거리를\n비교한다",
    });
    expect(lines).toEqual(["[R] reasoning turn 1/4", "    두 원의 중심 거리를", "    비교한다"]);
  });

  it("recomposes tool lines from structured fields without colors", () => {
    const lines: string[] = [];
    const renderer = createRenderer({ simplify: false, color: false, err: (line) => lines.push(line) });
    renderer.event({
      kind: "tool",
      realizer: "R",
      tool: "WriteFile",
      toolDetail: 'path="x.ts"',
      outcome: "ok",
      durationMs: 5,
      errored: false,
      text: '[R] WriteFile(path="x.ts") → ok · 5ms',
    });
    expect(lines).toEqual(['[R] WriteFile(path="x.ts") → ok · 5ms']);
  });

  it("styles reasoning with gray italics when colors are on", () => {
    const lines: string[] = [];
    const renderer = createRenderer({ simplify: false, color: true, err: (line) => lines.push(line) });
    renderer.event({ kind: "reasoning", realizer: "R", turn: 1, maxTurns: 2, text: "생각" });
    expect(lines[0]).toContain("\x1b[90m");
    expect(lines[1]).toContain("\x1b[3m");
    expect(lines[1]).toContain("    생각");
  });

  it("passes unknown-shaped events through as text", () => {
    const lines: string[] = [];
    const renderer = createRenderer({ simplify: false, color: false, err: (line) => lines.push(line) });
    renderer.event({ kind: "engine", text: "[chz-realize] warning: cycle" });
    renderer.event({ kind: "turn", text: "[R] turn 1/2" });
    expect(lines).toEqual(["[chz-realize] warning: cycle", "[R] turn 1/2"]);
  });
});

describe("plain simplify renderer (no TTY)", () => {
  it("keeps only group results and global engine notes", () => {
    const lines: string[] = [];
    const renderer = createRenderer({ simplify: true, color: false, err: (line) => lines.push(line) });
    renderer.event({ kind: "engine", text: "[chz-realize] warning: cycle" });
    renderer.event(groupStart("greet", 1, 1));
    renderer.event({ kind: "tool", group: "greet", tool: "ReadFile", outcome: "ok", text: "noise" });
    renderer.event({ kind: "reasoning", group: "greet", text: "noise" });
    renderer.event({ kind: "engine", group: "greet", text: "[chz-realize] 'greet': re-running tests" });
    renderer.event(groupEnd("greet", 1, 1));
    expect(lines).toEqual([
      "[chz-realize] warning: cycle",
      "[chz-realize] [1/1] [ OK ] greet",
    ]);
  });
});

describe("live renderer (TTY)", () => {
  const make = (columns = 60) => {
    const chunks: string[] = [];
    const renderer = createRenderer({
      simplify: true,
      color: false,
      err: () => {
        throw new Error("the live renderer must not use the line sink");
      },
      tty: { write: (chunk) => chunks.push(String(chunk)), columns },
    });
    return { chunks, renderer };
  };

  it("draws one in-place line per running group and settles it on group-end", () => {
    const { chunks, renderer } = make();
    renderer.event(groupStart("greet", 1, 2));
    expect(chunks[0]).toBe("[1/2] [ .. ] greet: starting…\n");

    renderer.event({ kind: "tool", group: "greet", tool: "ReadFile", toolDetail: 'path="a.ts"', outcome: "ok", text: "t" });
    // Redraw: cursor up over the live area, erase, repaint.
    expect(chunks[1]).toBe('\x1b[1A\r\x1b[0J[1/2] [ .. ] greet: ⚒ ReadFile(path="a.ts")\n');

    renderer.event({ kind: "reasoning", group: "greet", text: "원의 중심 거리 비교\n다음 줄" });
    expect(chunks[2]).toContain("💭 원의 중심 거리 비교");
    expect(chunks[2]).not.toContain("다음 줄");

    renderer.event(groupEnd("greet", 1, 2));
    expect(chunks[3]).toBe("\x1b[1A\r\x1b[0J[1/2] [ OK ] greet\n");
    renderer.close();
  });

  it("interleaves multiple running groups as separate lines", () => {
    const { chunks, renderer } = make();
    renderer.event(groupStart("a", 1, 2));
    renderer.event(groupStart("b", 2, 2));
    expect(chunks[1]).toBe("\x1b[1A\r\x1b[0J[1/2] [ .. ] a: starting…\n[2/2] [ .. ] b: starting…\n");

    renderer.event(groupEnd("a", 1, 2));
    // The finished line becomes permanent; only b stays live.
    expect(chunks[2]).toBe("\x1b[2A\r\x1b[0J[1/2] [ OK ] a\n[2/2] [ .. ] b: starting…\n");
    renderer.close();
  });

  it("falls back to 80 columns when the pty reports zero width", () => {
    const { chunks, renderer } = make(0);
    renderer.event(groupStart("greet", 1, 1));
    expect(chunks[0]).toBe("[1/1] [ .. ] greet: starting…\n");
    renderer.close();
  });

  it("truncates notes to the terminal width, counting wide characters", () => {
    const { chunks, renderer } = make(30);
    renderer.event(groupStart("greet", 1, 1));
    renderer.event({ kind: "reasoning", group: "greet", text: "아주아주아주아주 긴 리즈닝 텍스트" });
    const lastLine = chunks.at(-1)!;
    expect(lastLine.endsWith("…\n")).toBe(true);
    expect(displayWidth(lastLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd())).toBeLessThan(30);
    renderer.close();
  });

  it("suspends for interactive prompts and flushes queued results on resume", () => {
    const { chunks, renderer } = make();
    renderer.event(groupStart("greet", 1, 1));
    renderer.suspend();
    expect(chunks.at(-1)).toBe("\x1b[1A\r\x1b[0J");

    const before = chunks.length;
    renderer.event(groupEnd("greet", 1, 1));
    // While a prompt owns the terminal nothing is drawn.
    expect(chunks.length).toBe(before);

    renderer.resume();
    expect(chunks.at(-1)).toBe("[1/1] [ OK ] greet\n");
    renderer.close();
  });
});
