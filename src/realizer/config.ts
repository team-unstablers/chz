import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ChzImagineSymbol,
  ChzProjectConfig,
  ChzRealizer,
} from "./types.ts";

export const CHZ_CONFIG_FILE = "chz.config.js";

/** Identity helper that gives JavaScript/TypeScript configs an explicit API. */
export function defineConfig(config: ChzProjectConfig): ChzProjectConfig {
  return config;
}

export interface LoadedChzConfig {
  path: string;
  projectRoot: string;
  config: ChzProjectConfig;
}

/** Search from a source directory upward, stopping at the filesystem root. */
export function findChzConfig(from: string): string | null {
  let directory = resolve(from);
  if (existsSync(directory) && !statSync(directory).isDirectory()) directory = dirname(directory);

  const root = parse(directory).root;
  for (;;) {
    const candidate = join(directory, CHZ_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

/** Load and structurally validate the ESM default export of chz.config.js. */
export async function loadChzConfig(path: string): Promise<LoadedChzConfig> {
  const absolute = isAbsolute(path) ? path : resolve(path);
  const url = pathToFileURL(absolute);
  // The mtime query avoids stale config modules in long-lived API consumers.
  url.searchParams.set("mtime", String(statSync(absolute).mtimeMs));
  const module = (await import(url.href)) as { default?: unknown };
  const value = module.default;
  if (!isRecord(value)) {
    throw new Error(`${absolute}: default export must be a chz configuration object.`);
  }
  if (!Array.isArray(value.realizers) || value.realizers.length === 0) {
    throw new Error(`${absolute}: 'realizers' must be a non-empty array.`);
  }
  for (const [index, realizer] of value.realizers.entries()) {
    if (!isRealizer(realizer)) {
      throw new Error(
        `${absolute}: realizers[${index}] must provide name, supportedSymbolTypes, and realize(symbol, context).`,
      );
    }
  }
  if (value.maxTurns !== undefined && (!Number.isInteger(value.maxTurns) || (value.maxTurns as number) < 1)) {
    throw new Error(`${absolute}: maxTurns must be an integer greater than zero.`);
  }
  if (value.maxRetries !== undefined && (!Number.isInteger(value.maxRetries) || (value.maxRetries as number) < 0)) {
    throw new Error(`${absolute}: maxRetries must be a non-negative integer.`);
  }
  if (value.profile !== undefined && typeof value.profile !== "string") {
    throw new Error(`${absolute}: profile must be a string.`);
  }
  if (
    value.maxCycleSize !== undefined &&
    (!Number.isInteger(value.maxCycleSize) || (value.maxCycleSize as number) < 1)
  ) {
    throw new Error(`${absolute}: maxCycleSize must be an integer greater than zero.`);
  }
  if (
    value.include !== undefined &&
    (!Array.isArray(value.include) ||
      value.include.length === 0 ||
      !value.include.every((item) => typeof item === "string" && item.length > 0))
  ) {
    throw new Error(`${absolute}: include must be a non-empty array of glob strings.`);
  }
  if (value.jobs !== undefined && (!Number.isInteger(value.jobs) || (value.jobs as number) < 1)) {
    throw new Error(`${absolute}: jobs must be an integer greater than zero.`);
  }
  if (value.blockedPaths !== undefined) {
    if (
      !Array.isArray(value.blockedPaths) ||
      !value.blockedPaths.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      throw new Error(`${absolute}: blockedPaths must be an array of non-empty glob strings.`);
    }
    // The built-in secrets list is a floor, not a default: letting a config
    // re-open .env or chz.config.js would turn one edit into a key leak.
    const negated = (value.blockedPaths as string[]).find((pattern) => pattern.startsWith("!"));
    if (negated !== undefined) {
      throw new Error(
        `${absolute}: blockedPaths is add-only; '${negated}' cannot un-block a path. Remove the leading '!'.`,
      );
    }
    const absolutePattern = (value.blockedPaths as string[]).find((pattern) => isAbsolute(pattern));
    if (absolutePattern !== undefined) {
      throw new Error(
        `${absolute}: blockedPaths entries are project-relative; '${absolutePattern}' must not be an absolute path.`,
      );
    }
  }

  return {
    path: absolute,
    projectRoot: dirname(absolute),
    config: value as unknown as ChzProjectConfig,
  };
}

/** First matching Realizer wins, as specified by docs/61. */
export function selectRealizer(
  realizers: readonly ChzRealizer[],
  symbol: ChzImagineSymbol,
): ChzRealizer | null {
  return realizers.find((realizer) => realizer.supportedSymbolTypes.includes(symbol.type)) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealizer(value: unknown): value is ChzRealizer {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    Array.isArray(value.supportedSymbolTypes) &&
    value.supportedSymbolTypes.every((item) => typeof item === "string") &&
    typeof value.realize === "function"
  );
}
