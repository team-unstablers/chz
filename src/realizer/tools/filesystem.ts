import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { CHZ_CONFIG_FILE } from "../config.ts";
import type { ChzDiagnostic, ChzRealizeContext } from "../types.ts";

const execFileAsync = promisify(execFile);

const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1_024;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_SEARCH_LIMIT = 100;
const BLOCKED_PATH_DESCRIPTION = ".env files (except .env.example), chz.config.js, keys, .git";
const RIPGREP_BLOCKED_PATH_ARGS = [
  "--iglob=!**/.git/**",
  "--iglob=!**/.env*",
  "--iglob=!**/chz.config.js",
  "--iglob=!**/*.pem",
  "--iglob=!**/*.key",
  "--iglob=!**/id_rsa*",
] as const;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".sqlite",
  ".tar",
  ".tiff",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

type ToolInput = Record<string, unknown>;

class ToolInputError extends Error {}

function asInput(input: unknown): ToolInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }
  return input as ToolInput;
}

function assertOnlyFields(input: ToolInput, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new ToolInputError(`unexpected property ${unexpected}`);
}

function stringField(input: ToolInput, name: string): string {
  const value = input[name];
  if (typeof value !== "string") {
    throw new ToolInputError(`${name} is required and must be a string`);
  }
  return value;
}

function optionalStringField(input: ToolInput, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string`);
  return value;
}

function optionalBooleanField(input: ToolInput, name: string): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`${name} must be a boolean`);
  return value;
}

function optionalIntegerField(
  input: ToolInput,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name];
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new ToolInputError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function canonicalizePossiblyMissing(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const canonicalAncestor = realpathSync.native(ancestor);
  const suffix = relative(ancestor, path);
  return suffix === "" ? canonicalAncestor : resolve(canonicalAncestor, suffix);
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * A glob match that also succeeds on the lowercased pair. The project may sit
 * on a case-insensitive filesystem — macOS APFS by default — where `Secrets/k`
 * and `secrets/k` name the same bytes, so a case-sensitive blocklist would be
 * a one-keystroke bypass. Over-blocking is the safe direction for a blocklist,
 * and it keeps the local check aligned with the case-insensitive `--iglob`
 * arguments handed to ripgrep.
 */
function matchesGlobLoosely(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern) ||
    matchesGlob(path.toLowerCase(), pattern.toLowerCase());
}

/**
 * The configured pattern blocking `rel`, or undefined when none does.
 *
 * `rel` is project-relative and POSIX-separated. Patterns follow the
 * gitignore/ripgrep reading the built-in list already uses, so the two halves
 * of the blocklist behave alike:
 *
 * - A pattern without `/` matches a path component at any depth: `*.pem`
 *   blocks `a/b/c.pem`, exactly as `--iglob=!*.pem` does.
 * - A pattern with `/` is anchored at the project root and blocks everything
 *   beneath what it matches, so `secrets/keys` blocks `secrets/keys/id`.
 * - A trailing `/**` additionally names the directory itself, so `secrets/**`
 *   blocks `secrets` and `ReadDir` cannot even list it.
 */
function configuredBlockMatch(rel: string, patterns: readonly string[]): string | undefined {
  if (patterns.length === 0) return undefined;
  const segments = toPosix(rel).split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return undefined;
  const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join("/"));

  return patterns.find((pattern) => {
    if (!pattern.includes("/")) {
      return segments.some((segment) => matchesGlobLoosely(segment, pattern));
    }
    const named = pattern.endsWith("/**") ? pattern.slice(0, -"/**".length) : undefined;
    return ancestors.some(
      (ancestor) =>
        matchesGlobLoosely(ancestor, pattern) ||
        (named !== undefined && matchesGlobLoosely(ancestor, named)),
    );
  });
}

/**
 * Pre-filter arguments for ripgrep. These are an optimization, not the
 * boundary: `#isBlockedPath` re-checks every path ripgrep returns, so a
 * pattern ripgrep reads differently costs a wasted scan, never a leak.
 */
function ripgrepBlockArgs(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) =>
    pattern.endsWith("/**")
      ? [`--iglob=!${pattern}`, `--iglob=!${pattern.slice(0, -"/**".length)}`]
      : [`--iglob=!${pattern}`, `--iglob=!${pattern.replace(/\/+$/, "")}/**`],
  );
}

function hash(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function truncateLine(line: string, maximum = MAX_LINE_CHARS): string {
  const characters = Array.from(line);
  if (characters.length <= maximum) return line;
  return `${characters.slice(0, maximum).join("")}... (line truncated to ${maximum} chars)`;
}

function splitTextLines(contents: string): string[] {
  if (contents.length === 0) return [];
  const lines = contents.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(contents)) lines.pop();
  return lines;
}

function takeUtf8Start(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > byteLimit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function takeUtf8End(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const characters = Array.from(value);
  let bytes = 0;
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character);
    if (bytes + size > byteLimit) break;
    result = character + result;
    bytes += size;
  }
  return result;
}

function hasBinaryMagic(contents: Buffer): boolean {
  const signatures: readonly number[][] = [
    [0x7f, 0x45, 0x4c, 0x46],
    [0x4d, 0x5a],
    [0x00, 0x61, 0x73, 0x6d],
    [0x50, 0x4b, 0x03, 0x04],
    [0x89, 0x50, 0x4e, 0x47],
    [0xff, 0xd8, 0xff],
    [0x47, 0x49, 0x46, 0x38],
    [0x25, 0x50, 0x44, 0x46],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xcf, 0xfa, 0xed, 0xfe],
  ];
  return signatures.some(
    (signature) =>
      contents.length >= signature.length &&
      signature.every((byte, index) => contents[index] === byte),
  );
}

function looksBinary(path: string, contents: Buffer, decoded: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  if (hasBinaryMagic(contents.subarray(0, 16))) return true;
  if (contents.includes(0)) return true;
  if (decoded.length === 0) return false;

  let controls = 0;
  let count = 0;
  for (const character of decoded) {
    const code = character.codePointAt(0)!;
    count += 1;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
        (code >= 0x7f && code <= 0x9f)) {
      controls += 1;
    }
  }
  return count > 0 && controls / count > 0.3;
}

function decodeUtf8(contents: Buffer, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`File is not valid UTF-8: ${displayPath}`);
  }
}

function detectNewline(contents: string): "\n" | "\r\n" {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeNewlines(contents: string, newline: "\n" | "\r\n"): string {
  return contents.replace(/\r\n|\r|\n/g, newline);
}

function withoutBom(contents: string): string {
  return contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
}

function xmlEscape(contents: string): string {
  return contents
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Filesystem and search tool implementation used by a single Realizer session. */
export class ChzFilesystemToolRuntime {
  readonly #context: ChzRealizeContext;
  readonly #projectRoot: string;
  readonly #outputDir: string;
  readonly #blockedPaths: readonly string[];
  readonly #ripgrepBlockArgs: readonly string[];
  readonly #readHashes = new Map<string, string>();
  #outputSequence = 0;

  constructor(context: ChzRealizeContext) {
    this.#context = context;
    this.#projectRoot = canonicalizePossiblyMissing(resolve(context.projectRoot));
    this.#outputDir = canonicalizePossiblyMissing(resolve(context.outputDir));
    // Configured patterns add to the built-in list, never replace it (docs/63).
    this.#blockedPaths = [...(context.blockedPaths ?? [])];
    this.#ripgrepBlockArgs = [
      ...RIPGREP_BLOCKED_PATH_ARGS,
      ...ripgrepBlockArgs(this.#blockedPaths),
    ];
    this.#cleanExpiredToolOutputs();
  }

  async execute(name: string, input: unknown): Promise<string | null> {
    const supported = new Set([
      "ReadFile",
      "ReadDir",
      "Glob",
      "Grep",
      "WriteFile",
      "FindAndReplace",
    ]);
    if (!supported.has(name)) return null;

    try {
      const parsed = asInput(input);
      let output: string;
      switch (name) {
        case "ReadFile":
          assertOnlyFields(parsed, ["path", "offset", "limit"]);
          output = this.#readFile(
            stringField(parsed, "path"),
            optionalIntegerField(parsed, "offset", 1, 1, Number.MAX_SAFE_INTEGER),
            optionalIntegerField(parsed, "limit", MAX_LINES, 1, MAX_LINES),
          );
          break;
        case "ReadDir":
          assertOnlyFields(parsed, ["path", "offset", "limit"]);
          output = this.#readDir(
            stringField(parsed, "path"),
            optionalIntegerField(parsed, "offset", 1, 1, Number.MAX_SAFE_INTEGER),
            optionalIntegerField(parsed, "limit", MAX_LINES, 1, MAX_LINES),
          );
          break;
        case "Glob":
          assertOnlyFields(parsed, ["pattern", "path", "limit"]);
          output = await this.#glob(
            stringField(parsed, "pattern"),
            optionalStringField(parsed, "path"),
            optionalIntegerField(parsed, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_LINES),
          );
          break;
        case "Grep":
          assertOnlyFields(parsed, ["pattern", "path", "include", "limit"]);
          output = await this.#grep(
            stringField(parsed, "pattern"),
            optionalStringField(parsed, "path"),
            optionalStringField(parsed, "include"),
            optionalIntegerField(parsed, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_LINES),
          );
          break;
        case "WriteFile":
          assertOnlyFields(parsed, ["path", "content"]);
          output = await this.#writeFile(
            stringField(parsed, "path"),
            stringField(parsed, "content"),
          );
          break;
        case "FindAndReplace":
          assertOnlyFields(parsed, ["path", "oldString", "newString", "replaceAll"]);
          output = await this.#findAndReplace(
            stringField(parsed, "path"),
            stringField(parsed, "oldString"),
            stringField(parsed, "newString"),
            optionalBooleanField(parsed, "replaceAll") ?? false,
          );
          break;
        default:
          return null;
      }
      return this.boundOutput(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rendered = error instanceof ToolInputError
        ? `Invalid tool input: ${message}. Please rewrite the input so it satisfies the expected schema.`
        : message;
      return this.boundOutput(rendered);
    }
  }

  boundOutput(output: string): string {
    const lines = output.split("\n");
    if (lines.length <= MAX_LINES && Buffer.byteLength(output) <= MAX_BYTES) return output;

    const outputDirectory = canonicalizePossiblyMissing(
      resolve(this.#projectRoot, ".chz", "tool-output"),
    );
    if (!contains(this.#projectRoot, outputDirectory)) {
      throw new Error("Cannot store bounded tool output because .chz/tool-output escapes the project root.");
    }
    mkdirSync(outputDirectory, { recursive: true });
    let fullPath: string;
    do {
      this.#outputSequence += 1;
      fullPath = resolve(outputDirectory, `tool_${this.#outputSequence}.log`);
    } while (existsSync(fullPath));
    writeFileSync(fullPath, output, "utf8");

    const marker = [
      `... output truncated; full content saved to ${fullPath} ...`,
      "Use ReadFile with offset/limit, or Grep, to inspect the full output.",
    ].join("\n");
    const previewLineCount = Math.min(lines.length, MAX_LINES - 2);
    const headLineCount = Math.ceil(previewLineCount / 2);
    const tailLineCount = Math.floor(previewLineCount / 2);
    let head = lines.slice(0, headLineCount).join("\n");
    let tail = tailLineCount === 0 ? "" : lines.slice(-tailLineCount).join("\n");

    const separators = tail === "" ? 1 : 2;
    const availableBytes = Math.max(0, MAX_BYTES - Buffer.byteLength(marker) - separators);
    head = takeUtf8Start(head, Math.ceil(availableBytes / 2));
    tail = takeUtf8End(tail, Math.floor(availableBytes / 2));
    return tail === "" ? `${head}\n${marker}` : `${head}\n${marker}\n${tail}`;
  }

  #cleanExpiredToolOutputs(): void {
    const requestedDirectory = resolve(this.#projectRoot, ".chz", "tool-output");
    if (!existsSync(requestedDirectory)) return;
    try {
      const outputDirectory = realpathSync.native(requestedDirectory);
      if (!contains(this.#projectRoot, outputDirectory)) return;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1_000;
      for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^tool_\d+\.log$/.test(entry.name)) continue;
        const path = resolve(outputDirectory, entry.name);
        if (statSync(path).mtimeMs < sevenDaysAgo) rmSync(path, { force: true });
      }
    } catch {
      // Retention cleanup is best-effort and must not prevent a realize session.
    }
  }

  /**
   * The second reading of a relative path, or undefined when there is none.
   *
   * A session spends nearly all of its time inside the output directory, so
   * `implementations/foo.ts` is at least as likely to mean the artifact it just
   * wrote as a file at the top of the project. The project root stays the
   * documented base and always wins; this is only consulted when that reading
   * turns out not to work.
   *
   * It must never *invent* a location, which is the danger of a blanket retry:
   * a path denied for escaping the output directory would come back as a
   * plausible-looking path inside it, and the model would silently get a file
   * it did not ask for. Each caller therefore requires evidence that the
   * fallback names something already there.
   */
  #outputRelative(displayPath: string): string | undefined {
    if (isAbsolute(displayPath)) return undefined;
    const primary = resolve(this.#context.projectRoot, displayPath);
    const fallback = resolve(this.#context.outputDir, displayPath);
    return fallback === primary ? undefined : fallback;
  }

  #resolveRead(displayPath: string): string {
    const primary = resolve(this.#context.projectRoot, displayPath);
    const fallback = this.#outputRelative(displayPath);
    // Evidence for a read is the file itself. When neither reading exists the
    // primary is used, so "File not found" still names what was asked for.
    const lexical =
      !existsSync(primary) && fallback !== undefined && existsSync(fallback) ? fallback : primary;
    const canonical = canonicalizePossiblyMissing(lexical);
    if (!contains(this.#projectRoot, canonical)) {
      throw new Error(
        `Read access denied: ${displayPath} is outside the project root (${this.#context.projectRoot}).`,
      );
    }
    const policyLexical = resolve(
      this.#projectRoot,
      relative(resolve(this.#context.projectRoot), lexical),
    );
    const blocked = this.#blockedPathReason(policyLexical) ?? this.#blockedPathReason(canonical);
    if (blocked !== undefined) {
      throw new Error(`Read access denied: ${displayPath} matches the blocked-path list (${blocked}).`);
    }
    return canonical;
  }

  #resolveWrite(displayPath: string): string {
    const primary = resolve(this.#context.projectRoot, displayPath);
    const fallback = this.#outputRelative(displayPath);
    // Evidence for a write is an existing directory to write into: the file
    // itself may legitimately be new, but its parent must already be part of
    // the realization layout. Without that condition a path that escapes the
    // output directory — through `..` or through a symlink — would be quietly
    // rewritten into a fresh tree inside it.
    const lexical =
      !contains(this.#outputDir, canonicalizePossiblyMissing(primary)) &&
      fallback !== undefined &&
      existsSync(dirname(fallback)) &&
      contains(this.#outputDir, canonicalizePossiblyMissing(fallback))
        ? fallback
        : primary;
    const canonical = canonicalizePossiblyMissing(lexical);
    if (!contains(this.#outputDir, canonical)) {
      throw new Error(
        `Write access denied: ${displayPath} is outside the realization output directory (${this.#context.outputDir}). Realized code and tests must be written there.`,
      );
    }
    const policyLexical = resolve(
      this.#projectRoot,
      relative(resolve(this.#context.projectRoot), lexical),
    );
    const blocked = this.#blockedPathReason(policyLexical) ?? this.#blockedPathReason(canonical);
    if (blocked !== undefined) {
      throw new Error(`Write access denied: ${displayPath} matches the blocked-path list (${blocked}).`);
    }
    return canonical;
  }

  #isBlockedPath(path: string): boolean {
    return this.#blockedPathReason(path) !== undefined;
  }

  /**
   * How `path` is blocked, or undefined when it is not. The two halves are
   * reported differently on purpose: a built-in match names the fixed list,
   * while a configured match names the pattern, because only the second one
   * has an edit the human can make in response.
   */
  #blockedPathReason(path: string): string | undefined {
    const rel = relative(this.#projectRoot, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    const components = rel.split(sep);
    const builtIn = components.some((component) => {
      const lower = component.toLowerCase();
      if (lower === ".git") return true;
      if (lower === "chz.config.js") return true;
      if (lower === ".env.example") return false;
      if (lower.startsWith(".env")) return true;
      if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
      return lower.startsWith("id_rsa");
    });
    if (builtIn) return BLOCKED_PATH_DESCRIPTION;

    const configured = configuredBlockMatch(rel, this.#blockedPaths);
    return configured === undefined
      ? undefined
      : `configured pattern '${configured}' in ${CHZ_CONFIG_FILE}`;
  }

  #readFile(displayPath: string, offset: number, limit: number): string {
    const path = this.#resolveRead(displayPath);
    if (!existsSync(path)) throw new Error(this.#missingFileMessage(displayPath));
    if (statSync(path).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${displayPath}. Use ReadDir instead.`);
    }

    const contents = readFileSync(path);
    let decoded: string;
    try {
      decoded = decodeUtf8(contents, displayPath);
    } catch (error) {
      if (BINARY_EXTENSIONS.has(extname(path).toLowerCase()) || hasBinaryMagic(contents)) {
        throw new Error(`Cannot read binary file: ${displayPath}`);
      }
      throw error;
    }
    if (looksBinary(path, contents, decoded)) throw new Error(`Cannot read binary file: ${displayPath}`);

    const lines = splitTextLines(decoded);
    if (lines.length > 0 && offset > lines.length) {
      throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines).`);
    }
    if (lines.length === 0 && offset !== 1) {
      throw new Error(`Offset ${offset} is out of range for this file (0 lines).`);
    }

    this.#readHashes.set(path, hash(contents));
    const start = offset - 1;
    const selected: string[] = [];
    let cappedByBytes = false;
    for (let index = start; index < Math.min(lines.length, start + limit); index += 1) {
      const rendered = `${index + 1}: ${truncateLine(lines[index]!)}`;
      const withCandidate = [...selected, rendered].join("\n");
      // Keep enough room for the mandatory continuation footer so this tool's
      // own byte cap does not immediately trigger the common dispatcher cap.
      if (Buffer.byteLength(withCandidate) > MAX_BYTES - 200) {
        cappedByBytes = true;
        break;
      }
      selected.push(rendered);
    }

    const end = selected.length === 0 ? offset - 1 : offset + selected.length - 1;
    let footer: string;
    if (cappedByBytes) {
      footer = `(Output capped at 50 KB. Showing lines ${offset}-${end}. Use offset=${end + 1} to continue.)`;
    } else if (end < lines.length) {
      footer = `(Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.)`;
    } else {
      footer = `(End of file - total ${lines.length} lines)`;
    }
    return selected.length === 0 ? footer : `${selected.join("\n")}\n${footer}`;
  }

  #missingFileMessage(displayPath: string): string {
    const lexical = resolve(this.#context.projectRoot, displayPath);
    const parent = dirname(lexical);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) return `File not found: ${displayPath}`;

    const needle = basename(lexical).toLowerCase();
    const candidates = readdirSync(parent)
      .flatMap((entry): string[] => {
        const lower = entry.toLowerCase();
        if (!lower.includes(needle) && !needle.includes(lower)) return [];
        const candidate = resolve(parent, entry);
        try {
          const canonical = realpathSync.native(candidate);
          if (!contains(this.#projectRoot, canonical) || this.#isBlockedPath(candidate) ||
              this.#isBlockedPath(canonical)) {
            return [];
          }
          return [toPosix(relative(resolve(this.#context.projectRoot), candidate))];
        } catch {
          return [];
        }
      })
      .slice(0, 3);
    return candidates.length === 0
      ? `File not found: ${displayPath}`
      : `File not found: ${displayPath}\n\nDid you mean one of these?\n${candidates.join("\n")}`;
  }

  #readDir(displayPath: string, offset: number, limit: number): string {
    const path = this.#resolveRead(displayPath);
    if (!existsSync(path)) throw new Error(`File not found: ${displayPath}`);
    if (!statSync(path).isDirectory()) {
      throw new Error(`Path is a file, not a directory: ${displayPath}. Use ReadFile instead.`);
    }

    const entries = readdirSync(path, { withFileTypes: true })
      .flatMap((entry): { name: string; directory: boolean }[] => {
        const entryPath = resolve(path, entry.name);
        try {
          const canonical = realpathSync.native(entryPath);
          if (!contains(this.#projectRoot, canonical) || this.#isBlockedPath(entryPath) ||
              this.#isBlockedPath(canonical)) {
            return [];
          }
          return [{ name: entry.name, directory: statSync(entryPath).isDirectory() }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => Number(right.directory) - Number(left.directory) ||
        left.name.localeCompare(right.name, "en"));

    if (entries.length > 0 && offset > entries.length) {
      throw new Error(`Offset ${offset} is out of range for this directory (${entries.length} entries).`);
    }
    if (entries.length === 0 && offset !== 1) {
      throw new Error(`Offset ${offset} is out of range for this directory (0 entries).`);
    }
    const page = entries.slice(offset - 1, offset - 1 + limit);
    const rendered = page.map((entry) => `${entry.name}${entry.directory ? "/" : ""}`);
    const end = page.length === 0 ? offset - 1 : offset + page.length - 1;
    const footer = end < entries.length
      ? `(Showing entries ${offset}-${end} of ${entries.length}. Use offset=${end + 1} to continue.)`
      : `(${entries.length} entries)`;
    return rendered.length === 0 ? footer : `${rendered.join("\n")}\n${footer}`;
  }

  async #glob(pattern: string, displayPath: string | undefined, limit: number): Promise<string> {
    const startDisplay = displayPath ?? this.#context.projectRoot;
    const start = this.#resolveRead(startDisplay);
    if (!existsSync(start)) throw new Error(`File not found: ${startDisplay}`);
    if (!statSync(start).isDirectory()) throw new Error(`Glob path must be a directory: ${startDisplay}`);

    const startRelative = relative(this.#projectRoot, start) || ".";
    const args = [
      "--files",
      "--no-config",
      `--glob=${pattern}`,
      ...this.#ripgrepBlockArgs,
      startRelative,
    ];
    const { stdout } = await this.#runRipgrep(args);
    const files = stdout.split(/\r?\n/).filter(Boolean).flatMap((entry): string[] => {
      const absolute = resolve(this.#projectRoot, entry);
      try {
        const canonical = realpathSync.native(absolute);
        if (!contains(this.#projectRoot, canonical) || this.#isBlockedPath(absolute) ||
            this.#isBlockedPath(canonical)) {
          return [];
        }
        return [toPosix(relative(this.#projectRoot, canonical))];
      } catch {
        return [];
      }
    });
    if (files.length === 0) return "No files found";
    const shown = files.slice(0, limit);
    if (files.length > limit) {
      shown.push(
        `(Results truncated: showing first ${limit} results. Use a more specific pattern or path, or raise limit.)`,
      );
    }
    return shown.join("\n");
  }

  async #grep(
    pattern: string,
    displayPath: string | undefined,
    include: string | undefined,
    limit: number,
  ): Promise<string> {
    const startDisplay = displayPath ?? this.#context.projectRoot;
    const start = this.#resolveRead(startDisplay);
    if (!existsSync(start)) throw new Error(`File not found: ${startDisplay}`);

    const startRelative = relative(this.#projectRoot, start) || ".";
    const args = [
      "--json",
      "--line-number",
      "--no-config",
      "--hidden",
    ];
    if (include !== undefined) args.push(`--glob=${include}`);
    args.push(...this.#ripgrepBlockArgs);
    args.push("--", pattern, startRelative);

    let stdout: string;
    try {
      ({ stdout } = await this.#runRipgrep(args));
      // The broad .env.* exclusion above also catches the explicitly allowed
      // .env.example. Search that one allowlisted name in a separate pass so
      // no other .env.* file ever becomes a ripgrep input.
      if (include === undefined) {
        const exampleArgs = [
          "--json",
          "--line-number",
          "--no-config",
          "--hidden",
          "--glob=**/.env.example",
          // The allowlisted name is still subject to the configured patterns:
          // the built-in list is a floor, and a project may raise it.
          ...ripgrepBlockArgs(this.#blockedPaths),
          "--",
          pattern,
          startRelative,
        ];
        const exampleResult = await this.#runRipgrep(exampleArgs);
        stdout += exampleResult.stdout;
      }
    } catch (error) {
      const details = error as Error & { stderr?: string; code?: number | string };
      if (details.code === 2 || details.stderr?.includes("regex parse error")) {
        throw new Error(`Invalid regex pattern: ${(details.stderr ?? details.message).trim()}`);
      }
      throw error;
    }

    const matches: { file: string; line: number; text: string }[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (line === "") continue;
      const event = JSON.parse(line) as {
        type: string;
        data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
      };
      if (event.type !== "match" || event.data?.path?.text === undefined ||
          event.data.line_number === undefined || event.data.lines?.text === undefined) {
        continue;
      }
      const absolute = resolve(this.#projectRoot, event.data.path.text);
      let canonical: string;
      try {
        canonical = realpathSync.native(absolute);
      } catch {
        continue;
      }
      if (!contains(this.#projectRoot, canonical) || this.#isBlockedPath(absolute) ||
          this.#isBlockedPath(canonical)) {
        continue;
      }
      matches.push({
        file: toPosix(relative(this.#projectRoot, canonical)),
        line: event.data.line_number,
        text: truncateLine(event.data.lines.text.replace(/\r?\n$/, "")),
      });
    }

    if (matches.length === 0) return "No matches found";
    const shown = matches.slice(0, limit);
    const grouped = new Map<string, { line: number; text: string }[]>();
    for (const match of shown) {
      const values = grouped.get(match.file) ?? [];
      values.push({ line: match.line, text: match.text });
      grouped.set(match.file, values);
    }
    const blocks = [...grouped].map(([file, values]) => [
      `${file}:`,
      ...values.map((value) => `  Line ${value.line}: ${value.text}`),
    ].join("\n"));
    let output = `Found ${shown.length} matches\n${blocks.join("\n\n")}`;
    if (matches.length > limit) {
      output += `\n(Results truncated: showing first ${limit} results. Use a more specific pattern or path, or raise limit.)`;
    }
    return output;
  }

  async #runRipgrep(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("rg", args, {
        cwd: this.#projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const details = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (details.code === 1) return { stdout: details.stdout ?? "", stderr: details.stderr ?? "" };
      throw error;
    }
  }

  async #writeFile(displayPath: string, content: string): Promise<string> {
    const path = this.#resolveWrite(displayPath);
    const existed = existsSync(path);
    if (existed && statSync(path).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${displayPath}`);
    }

    let rendered = content;
    if (existed) {
      const previous = readFileSync(path);
      this.#assertWritableSnapshot(path, displayPath, previous, true);
      const decoded = decodeUtf8(previous, displayPath);
      const hasBom = previous.length >= 3 && previous[0] === 0xef && previous[1] === 0xbb && previous[2] === 0xbf;
      rendered = normalizeNewlines(withoutBom(content), detectNewline(decoded));
      if (hasBom) rendered = `\uFEFF${rendered}`;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered, "utf8");
    this.#readHashes.set(path, hash(readFileSync(path)));
    const response = existed
      ? `Wrote file successfully: ${displayPath}`
      : `Created file successfully: ${displayPath}`;
    return response + await this.#inlineDiagnostics(path, displayPath);
  }

  async #findAndReplace(
    displayPath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): Promise<string> {
    if (oldString.length === 0) {
      throw new Error("oldString must not be empty. Use WriteFile to create or overwrite a file.");
    }
    const path = this.#resolveWrite(displayPath);
    if (!existsSync(path)) throw new Error(`File not found: ${displayPath}`);
    if (statSync(path).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${displayPath}`);
    }

    const previous = readFileSync(path);
    this.#assertWritableSnapshot(path, displayPath, previous, false);
    const decoded = decodeUtf8(previous, displayPath);
    const hasBom = previous.length >= 3 && previous[0] === 0xef && previous[1] === 0xbb && previous[2] === 0xbf;
    const contents = withoutBom(decoded);
    const newline = detectNewline(decoded);
    const oldNormalized = normalizeNewlines(withoutBom(oldString), newline);
    const newNormalized = normalizeNewlines(withoutBom(newString), newline);
    if (oldNormalized === newNormalized) {
      throw new Error("No changes to apply: oldString and newString are identical.");
    }

    const occurrences = contents.split(oldNormalized).length - 1;
    if (occurrences === 0) {
      throw new Error(
        "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
      );
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `Found multiple exact matches for oldString (${occurrences} occurrences). Provide more surrounding context to make it unique, or set replaceAll to true.`,
      );
    }

    const replacements = replaceAll ? occurrences : 1;
    const matchIndex = contents.indexOf(oldNormalized);
    const edited = replaceAll
      ? contents.split(oldNormalized).join(newNormalized)
      : contents.slice(0, matchIndex) + newNormalized + contents.slice(matchIndex + oldNormalized.length);
    writeFileSync(path, `${hasBom ? "\uFEFF" : ""}${edited}`, "utf8");
    this.#readHashes.set(path, hash(readFileSync(path)));

    const fullDiff = this.#diffPreview(oldNormalized, newNormalized, Number.MAX_SAFE_INTEGER);
    try {
      this.#context.harness?.onEvent?.({
        kind: "diff",
        tool: "FindAndReplace",
        text: `FindAndReplace diff for ${displayPath}:\n${fullDiff}`,
      });
    } catch {
      // Audit logging is supplemental and must not turn a successful edit into a failure.
    }
    const response = [
      `Edit applied successfully: ${displayPath}`,
      `Replacements: ${replacements}`,
      this.#diffPreview(oldNormalized, newNormalized, 6),
    ].join("\n");
    return response + await this.#inlineDiagnostics(path, displayPath);
  }

  #assertWritableSnapshot(
    path: string,
    displayPath: string,
    current: Buffer,
    wholeFileOverwrite: boolean,
  ): void {
    const previousHash = this.#readHashes.get(path);
    if (previousHash === undefined) {
      if (wholeFileOverwrite) {
        throw new Error(
          `Refusing to overwrite an existing file you have not read. Read ${displayPath} first, or use FindAndReplace for a partial edit.`,
        );
      }
      throw new Error(`You must read ${displayPath} with ReadFile before editing it.`);
    }
    if (previousHash !== hash(current)) {
      throw new Error(`File changed since you last read it. Read ${displayPath} again before editing.`);
    }
  }

  #diffPreview(oldString: string, newString: string, limit: number): string {
    const oldLines = splitTextLines(oldString).slice(0, limit).map((line) => `- ${truncateLine(line, 240)}`);
    const newLines = splitTextLines(newString).slice(0, limit).map((line) => `+ ${truncateLine(line, 240)}`);
    return ["Old:", ...oldLines, "New:", ...newLines].join("\n");
  }

  async #inlineDiagnostics(path: string, displayPath: string): Promise<string> {
    const diagnose = this.#context.harness?.diagnoseFile;
    if (diagnose === undefined) return "";
    let diagnostics: ChzDiagnostic[];
    try {
      diagnostics = await diagnose(path);
    } catch {
      return "";
    }
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length === 0) return "";
    const shown = errors.slice(0, 20).map((diagnostic) =>
      `ERROR [${diagnostic.line}:${diagnostic.col}] ${diagnostic.code}: ${xmlEscape(diagnostic.message)}`,
    );
    if (errors.length > 20) shown.push(`... and ${errors.length - 20} more`);
    return [
      "",
      "Diagnostics detected in this file, please fix:",
      `<diagnostics file="${xmlEscape(displayPath)}">`,
      ...shown,
      "</diagnostics>",
    ].join("\n");
  }
}
