import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadChzConfig } from "./config.ts";

const tempDirectories: string[] = [];

/** Write a chz.config.js whose default export is `body`, and load it. */
async function loadConfig(body: string): ReturnType<typeof loadChzConfig> {
  const root = mkdtempSync(join(tmpdir(), "chz-config-"));
  tempDirectories.push(root);
  const path = join(root, "chz.config.js");
  writeFileSync(
    path,
    `const realizer = {
  name: 'test',
  supportedSymbolTypes: ['function'],
  realize: async () => ({ outcome: 'failed', symbol: null, reason: 'test' }),
};
export default ${body};
`,
    "utf8",
  );
  return loadChzConfig(path);
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blockedPaths", () => {
  it("accepts an array of project-relative globs", async () => {
    const loaded = await loadConfig(
      "{ realizers: [realizer], blockedPaths: ['infra/**', '*.snapshot.json'] }",
    );

    expect(loaded.config.blockedPaths).toEqual(["infra/**", "*.snapshot.json"]);
  });

  it("rejects a negated pattern, because the built-in list cannot be lifted", async () => {
    await expect(
      loadConfig("{ realizers: [realizer], blockedPaths: ['!**/chz.config.js'] }"),
    ).rejects.toThrow(/blockedPaths is add-only.*Remove the leading '!'/s);
  });

  it("rejects an absolute pattern and a non-string entry", async () => {
    await expect(
      loadConfig("{ realizers: [realizer], blockedPaths: ['/etc/**'] }"),
    ).rejects.toThrow(/project-relative/);
    await expect(
      loadConfig("{ realizers: [realizer], blockedPaths: [42] }"),
    ).rejects.toThrow(/array of non-empty glob strings/);
  });
});

describe("outputLanguage", () => {
  it("accepts BCP-47 tags", async () => {
    for (const tag of ["ko", "en", "ja", "zh-Hant", "pt-BR"]) {
      const loaded = await loadConfig(`{ realizers: [realizer], outputLanguage: '${tag}' }`);
      expect(loaded.config.outputLanguage).toBe(tag);
    }
  });

  it("rejects free text, which the prompt could not resolve to a language", async () => {
    await expect(
      loadConfig("{ realizers: [realizer], outputLanguage: 'Korean please' }"),
    ).rejects.toThrow(/must be a BCP-47 language tag such as 'ko', 'ja', or 'en'/);
  });
});
