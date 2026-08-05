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
