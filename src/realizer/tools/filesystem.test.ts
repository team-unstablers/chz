import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChzRealizeContext } from "../types.ts";
import { ChzFilesystemToolRuntime } from "./filesystem.ts";

const tempDirectories: string[] = [];
let projectRoot: string;
let outputDir: string;

function context(overrides: Partial<ChzRealizeContext> = {}): ChzRealizeContext {
  return {
    projectRoot,
    outputDir,
    activeProfile: "console",
    resolvedDependencies: [],
    maxTurns: 10,
    maxRetries: 2,
    baseContexts: "",
    ...overrides,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "chz-filesystem-tool-"));
  tempDirectories.push(projectRoot);
  outputDir = join(projectRoot, "chz", "realization", "example");
  mkdirSync(outputDir, { recursive: true });
});

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChzFilesystemToolRuntime path boundaries", () => {
  it("rejects path traversal for every filesystem tool", async () => {
    const runtime = new ChzFilesystemToolRuntime(context());

    await expect(runtime.execute("ReadFile", { path: "../secret.txt" })).resolves.toBe(
      `Read access denied: ../secret.txt is outside the project root (${projectRoot}).`,
    );
    await expect(runtime.execute("ReadDir", { path: "../outside" })).resolves.toContain(
      "Read access denied",
    );
    await expect(runtime.execute("Glob", { pattern: "**/*", path: "../outside" })).resolves.toContain(
      "Read access denied",
    );
    await expect(runtime.execute("Grep", { pattern: "secret", path: "../secret.txt" })).resolves.toContain(
      "Read access denied",
    );
    await expect(runtime.execute("WriteFile", { path: "../escape.ts", content: "x" })).resolves.toBe(
      `Write access denied: ../escape.ts is outside the realization output directory (${outputDir}). Realized code and tests must be written there.`,
    );
    await expect(runtime.execute("FindAndReplace", {
      path: "../escape.ts",
      oldString: "x",
      newString: "y",
    })).resolves.toContain(
      "Write access denied",
    );
  });

  it("resolves symlinks before checking boundaries and hides escaping directory entries", async () => {
    const outside = mkdtempSync(join(tmpdir(), "chz-filesystem-outside-"));
    tempDirectories.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(projectRoot, "outside-link"), "dir");
    symlinkSync(outside, join(outputDir, "write-link"), "dir");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("ReadFile", { path: "outside-link/secret.txt" })).toContain(
      "Read access denied",
    );
    expect(await runtime.execute("ReadDir", { path: "outside-link" })).toContain(
      "Read access denied",
    );
    expect(await runtime.execute("Glob", { pattern: "**/*", path: "outside-link" })).toContain(
      "Read access denied",
    );
    expect(await runtime.execute("Grep", { pattern: "secret", path: "outside-link" })).toContain(
      "Read access denied",
    );
    expect(await runtime.execute("WriteFile", {
      path: "chz/realization/example/write-link/created.ts",
      content: "unsafe",
    })).toContain("Write access denied");
    expect(await runtime.execute("FindAndReplace", {
      path: "chz/realization/example/write-link/secret.txt",
      oldString: "secret",
      newString: "unsafe",
    })).toContain("Write access denied");
    expect(await runtime.execute("ReadDir", { path: "." })).not.toContain("outside-link");
    expect(existsSync(join(outside, "created.ts"))).toBe(false);
  });

  it("applies the blocked-path list to direct reads and directory listings", async () => {
    writeFileSync(join(projectRoot, ".env"), "TOKEN=secret");
    writeFileSync(join(projectRoot, ".envrc"), "TOKEN=secret");
    writeFileSync(join(projectRoot, ".env.example"), "TOKEN=replace-me");
    writeFileSync(join(projectRoot, "chz.config.js"), "export default { apiKey: 'secret' };");
    writeFileSync(join(projectRoot, "public.txt"), "not secret");
    symlinkSync(join(projectRoot, "public.txt"), join(projectRoot, ".env.local"));
    writeFileSync(join(projectRoot, "server.pem"), "secret");
    mkdirSync(join(projectRoot, ".git"));
    writeFileSync(join(projectRoot, ".git", "config"), "secret");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("ReadFile", { path: ".env" })).toContain("matches the blocked-path list");
    expect(await runtime.execute("ReadFile", { path: ".envrc" })).toContain(
      "matches the blocked-path list",
    );
    expect(await runtime.execute("ReadFile", { path: "chz.config.js" })).toContain(
      "matches the blocked-path list",
    );
    expect(await runtime.execute("ReadFile", { path: ".git/config" })).toContain(
      "matches the blocked-path list",
    );
    expect(await runtime.execute("ReadFile", { path: ".env.local" })).toContain(
      "matches the blocked-path list",
    );
    expect(await runtime.execute("ReadFile", { path: "server.pem" })).toContain(
      "matches the blocked-path list",
    );
    expect(await runtime.execute("ReadFile", { path: ".env.example" })).toContain("TOKEN=replace-me");
    const listing = await runtime.execute("ReadDir", { path: "." });
    expect(listing).not.toContain(".env\n");
    expect(listing).not.toContain(".envrc");
    expect(listing).not.toContain(".git/");
    expect(listing).not.toContain("chz.config.js");
    expect(listing).not.toContain("server.pem");
    expect(listing).toContain(".env.example");

    expect(await runtime.execute("ReadFile", { path: "config.js" })).not.toContain("chz.config.js");
  });
});

describe("ReadFile and ReadDir", () => {
  it("returns numbered pages, deterministic directory pages, and continuation footers", async () => {
    writeFileSync(join(projectRoot, "source.ts"), "alpha\nbeta\ngamma\ndelta\n");
    mkdirSync(join(projectRoot, "z-dir"));
    mkdirSync(join(projectRoot, "a-dir"));
    writeFileSync(join(projectRoot, "b.txt"), "b");
    writeFileSync(join(projectRoot, "a.txt"), "a");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("ReadFile", { path: "source.ts", offset: 2, limit: 2 })).toBe(
      "2: beta\n3: gamma\n(Showing lines 2-3 of 4. Use offset=4 to continue.)",
    );
    expect(await runtime.execute("ReadFile", { path: "source.ts", offset: 4, limit: 2 })).toBe(
      "4: delta\n(End of file - total 4 lines)",
    );
    expect(await runtime.execute("ReadDir", { path: ".", limit: 2 })).toBe(
      "a-dir/\nchz/\n(Showing entries 1-2 of 6. Use offset=3 to continue.)",
    );
  });

  it("rejects invalid UTF-8 and binary files without recording them as read", async () => {
    writeFileSync(join(projectRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(projectRoot, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("ReadFile", { path: "invalid.txt" })).toBe(
      "File is not valid UTF-8: invalid.txt",
    );
    expect(await runtime.execute("ReadFile", { path: "binary.dat" })).toBe(
      "Cannot read binary file: binary.dat",
    );
  });

  it("validates paging input rather than silently clamping it", async () => {
    const runtime = new ChzFilesystemToolRuntime(context());
    expect(await runtime.execute("ReadFile", { path: "x", limit: 2_001 })).toBe(
      "Invalid tool input: limit must be an integer between 1 and 2000. Please rewrite the input so it satisfies the expected schema.",
    );
  });
});

describe("Glob and Grep", () => {
  it("uses ripgrep syntax, formats grouped matches, and excludes blocked files", async () => {
    mkdirSync(join(projectRoot, "src"));
    writeFileSync(join(projectRoot, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n");
    writeFileSync(join(projectRoot, "src", "b.ts"), "export const needle = 3;\n");
    writeFileSync(join(projectRoot, "src", "ignored.js"), "const needle = 4;\n");
    writeFileSync(join(projectRoot, ".env"), "needle=secret\n");
    writeFileSync(join(projectRoot, ".envrc"), "needle=secret-envrc\n");
    writeFileSync(join(projectRoot, ".env.example"), "needle=example\n");
    writeFileSync(join(projectRoot, "chz.config.js"), "const needle = 'secret-config';\n");
    const runtime = new ChzFilesystemToolRuntime(context());

    const glob = await runtime.execute("Glob", { pattern: "**/*.ts" });
    expect(glob?.split("\n").sort()).toEqual(["src/a.ts", "src/b.ts"]);

    const grep = await runtime.execute("Grep", { pattern: "needle", include: "*.ts" });
    expect(grep).toContain("Found 2 matches");
    expect(grep).toContain("src/a.ts:\n  Line 1: const needle = 1;");
    expect(grep).toContain("src/b.ts:\n  Line 1: export const needle = 3;");
    expect(grep).not.toContain("ignored.js");
    expect(grep).not.toContain("secret");
    const broadGrep = await runtime.execute("Grep", { pattern: "needle" });
    expect(broadGrep).toContain("needle=example");
    expect(broadGrep).not.toContain("secret-envrc");
    expect(broadGrep).not.toContain("secret-config");
    expect(await runtime.execute("Glob", { pattern: "**/chz.config.js" })).toBe("No files found");
    expect(await runtime.execute("Grep", {
      pattern: "needle",
      include: "chz.config.js",
    })).toBe("No matches found");
    expect(await runtime.execute("Grep", { pattern: "needle", include: ".env*" })).toBe(
      "No matches found",
    );
    expect(await runtime.execute("Grep", { pattern: "needle", path: "chz.config.js" })).toContain(
      "Read access denied",
    );
    expect(await runtime.execute("Grep", { pattern: "needle", path: ".env.example" })).toContain(
      "Line 1: needle=example",
    );
  });

  it("reports truncation and exposes ripgrep regex errors", async () => {
    writeFileSync(join(projectRoot, "many.ts"), "hit\nhit\nhit\n");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("Grep", { pattern: "hit", limit: 2 })).toContain(
      "(Results truncated: showing first 2 results.",
    );
    expect(await runtime.execute("Grep", { pattern: "[" })).toContain("Invalid regex pattern:");
  });
});

describe("WriteFile and FindAndReplace", () => {
  it("blocks sensitive output paths while allowing .env.example", async () => {
    const runtime = new ChzFilesystemToolRuntime(context());
    const config = "chz/realization/example/chz.config.js";
    const environment = "chz/realization/example/.env.local";
    const example = "chz/realization/example/.env.example";

    expect(await runtime.execute("WriteFile", { path: config, content: "secret" })).toContain(
      "Write access denied",
    );
    expect(await runtime.execute("WriteFile", { path: environment, content: "secret" })).toContain(
      "Write access denied",
    );
    expect(existsSync(join(outputDir, "chz.config.js"))).toBe(false);
    expect(existsSync(join(outputDir, ".env.local"))).toBe(false);

    writeFileSync(join(outputDir, "chz.config.js"), "secret");
    expect(await runtime.execute("FindAndReplace", {
      path: config,
      oldString: "secret",
      newString: "changed",
    })).toContain("Write access denied");
    expect(readFileSync(join(outputDir, "chz.config.js"), "utf8")).toBe("secret");

    expect(await runtime.execute("WriteFile", { path: example, content: "TOKEN=\n" })).toBe(
      `Created file successfully: ${example}`,
    );
    expect(await runtime.execute("ReadFile", { path: example })).toContain("TOKEN=");
  });

  it("enforces read-before-overwrite, stale hashes, and refreshes the hash after writes", async () => {
    const file = join(outputDir, "implementation.ts");
    const displayPath = "chz/realization/example/implementation.ts";
    writeFileSync(file, "export const value = 1;\n");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("WriteFile", { path: displayPath, content: "replacement\n" })).toBe(
      `Refusing to overwrite an existing file you have not read. Read ${displayPath} first, or use FindAndReplace for a partial edit.`,
    );
    await runtime.execute("ReadFile", { path: displayPath });
    writeFileSync(file, "externally changed\n");
    expect(await runtime.execute("WriteFile", { path: displayPath, content: "replacement\n" })).toBe(
      `File changed since you last read it. Read ${displayPath} again before editing.`,
    );
    await runtime.execute("ReadFile", { path: displayPath });
    expect(await runtime.execute("WriteFile", { path: displayPath, content: "replacement\n" })).toBe(
      `Wrote file successfully: ${displayPath}`,
    );
    expect(await runtime.execute("WriteFile", { path: displayPath, content: "second\n" })).toBe(
      `Wrote file successfully: ${displayPath}`,
    );
    expect(readFileSync(file, "utf8")).toBe("second\n");
  });

  it("creates parent directories and preserves an existing BOM and CRLF style", async () => {
    const runtime = new ChzFilesystemToolRuntime(context());
    const created = "chz/realization/example/nested/new.ts";
    expect(await runtime.execute("WriteFile", { path: created, content: "one\ntwo\n" })).toBe(
      `Created file successfully: ${created}`,
    );
    expect(readFileSync(join(outputDir, "nested", "new.ts"), "utf8")).toBe("one\ntwo\n");

    const existing = join(outputDir, "windows.ts");
    const display = "chz/realization/example/windows.ts";
    writeFileSync(existing, "\uFEFFone\r\ntwo\r\n", "utf8");
    await runtime.execute("ReadFile", { path: display });
    await runtime.execute("WriteFile", { path: display, content: "alpha\nbeta\n" });
    expect(readFileSync(existing, "utf8")).toBe("\uFEFFalpha\r\nbeta\r\n");
  });

  it("performs exact replacement and returns actionable errors for unsafe replacements", async () => {
    const file = join(outputDir, "replace.ts");
    const display = "chz/realization/example/replace.ts";
    writeFileSync(file, "same\nsame\n");
    const runtime = new ChzFilesystemToolRuntime(context());

    expect(await runtime.execute("FindAndReplace", {
      path: display,
      oldString: "same",
      newString: "new",
    })).toBe(`You must read ${display} with ReadFile before editing it.`);
    await runtime.execute("ReadFile", { path: display });
    expect(await runtime.execute("FindAndReplace", {
      path: display,
      oldString: "same",
      newString: "new",
    })).toContain("Found multiple exact matches for oldString (2 occurrences)");
    const edited = await runtime.execute("FindAndReplace", {
      path: display,
      oldString: "same",
      newString: "new",
      replaceAll: true,
    });
    expect(edited).toContain(`Edit applied successfully: ${display}\nReplacements: 2`);
    expect(readFileSync(file, "utf8")).toBe("new\nnew\n");
    expect(await runtime.execute("FindAndReplace", {
      path: display,
      oldString: "new",
      newString: "$&-literal",
      replaceAll: true,
    })).toContain("Replacements: 2");
    expect(readFileSync(file, "utf8")).toBe("$&-literal\n$&-literal\n");
    expect(await runtime.execute("FindAndReplace", {
      path: display,
      oldString: "missing",
      newString: "replacement",
    })).toBe(
      "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
    );
  });

  it("appends at most 20 inline ERROR diagnostics and ignores diagnostic runner failures", async () => {
    const diagnoseFile = vi.fn(async () => Array.from({ length: 22 }, (_, index) => ({
      file: "diagnostic.ts",
      line: index + 1,
      col: 5,
      code: "TS2322",
      message: "Type mismatch",
      severity: (index === 21 ? "warning" : "error") as "error" | "warning",
    })));
    const runtime = new ChzFilesystemToolRuntime(context({ harness: { diagnoseFile } }));
    const display = "chz/realization/example/diagnostic.ts";
    const response = await runtime.execute("WriteFile", { path: display, content: "bad" });

    expect(diagnoseFile).toHaveBeenCalledWith(realpathSync.native(resolve(outputDir, "diagnostic.ts")));
    expect(response).toContain("Diagnostics detected in this file, please fix:");
    expect(response).toContain("ERROR [20:5]");
    expect(response).not.toContain("ERROR [21:5]");
    expect(response).toContain("... and 1 more");

    const failingRuntime = new ChzFilesystemToolRuntime(context({
      harness: { diagnoseFile: async () => { throw new Error("diagnostics crashed"); } },
    }));
    expect(await failingRuntime.execute("WriteFile", {
      path: "chz/realization/example/runner-failed.ts",
      content: "still written",
    })).toBe("Created file successfully: chz/realization/example/runner-failed.ts");
  });
});

describe("common output bounding", () => {
  it("does not clean logs through a tool-output symlink that escapes the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "chz-tool-output-outside-"));
    tempDirectories.push(outside);
    const outsideLog = join(outside, "tool_1.log");
    writeFileSync(outsideLog, "must survive");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(outsideLog, eightDaysAgo, eightDaysAgo);
    mkdirSync(join(projectRoot, ".chz"), { recursive: true });
    symlinkSync(outside, join(projectRoot, ".chz", "tool-output"), "dir");

    new ChzFilesystemToolRuntime(context());

    expect(readFileSync(outsideLog, "utf8")).toBe("must survive");
  });

  it("deletes expired tool logs while preserving recent and unrelated files", () => {
    const directory = join(projectRoot, ".chz", "tool-output");
    mkdirSync(directory, { recursive: true });
    const expired = join(directory, "tool_1.log");
    const recent = join(directory, "tool_2.log");
    const unrelated = join(directory, "session.log");
    writeFileSync(expired, "expired");
    writeFileSync(recent, "recent");
    writeFileSync(unrelated, "unrelated");
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1_000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1_000);
    utimesSync(expired, eightDaysAgo, eightDaysAgo);
    utimesSync(recent, oneDayAgo, oneDayAgo);
    utimesSync(unrelated, eightDaysAgo, eightDaysAgo);

    new ChzFilesystemToolRuntime(context());

    expect(existsSync(expired)).toBe(false);
    expect(readFileSync(recent, "utf8")).toBe("recent");
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated");
  });

  it("stores the full output and returns a bounded head/tail preview", () => {
    const runtime = new ChzFilesystemToolRuntime(context());
    const full = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join("\n");
    const bounded = runtime.boundOutput(full);
    const logPath = join(realpathSync.native(projectRoot), ".chz", "tool-output", "tool_1.log");

    expect(bounded).toContain(`full content saved to ${logPath}`);
    expect(bounded).toContain("line 1");
    expect(bounded).toContain("line 2100");
    expect(bounded.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(50 * 1_024);
    expect(readFileSync(logPath, "utf8")).toBe(full);
  });
});
