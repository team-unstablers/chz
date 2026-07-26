/** Realize engine: turns preprocessed imagine specs into Realizer sessions. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  ChzCycleError,
  buildDependencyGraph,
  collectEstimatedDependencySources,
  type ChzDependencyGraph,
  type ChzRealizeGroup,
} from "./graph.ts";
import {
  splitHumanCode,
  type EntryPointNamedExport,
  type HumanCodeLayer,
  type HumanCodeSplit,
} from "./human-code.ts";
import {
  imagineSpecsFromChzSource,
  publicSurfaceText,
  realizationBaseName,
  type ImagineSpec,
} from "./preprocessor.ts";
import {
  collectTypeSymbolReferences,
  declarationEnsureScopes,
  symbolComesOnlyFromTypeScriptLib,
  type ChzSourceFile,
} from "./compiler/index.ts";
import { SyntaxKind } from "./compiler/ts-api.ts";
import { ChzVerificationToolRuntime } from "./realizer/tools/verification.ts";
import {
  humanCodeHash,
  readChzVersion,
  readRealizationCache,
  sha256,
  type RealizationCacheSymbol,
} from "./verify.ts";
import type {
  ChzAskUserAnswer,
  ChzAskUserQuestion,
  ChzGroupStatus,
  ChzHarnessEvent,
  ChzHarnessServices,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzRealizationScope,
  ChzRealizer,
  ChzResolutionResolved,
  ChzVerificationResult,
} from "./realizer/types.ts";

export * from "./graph.ts";
export * from "./realizer/index.ts";

export interface EmittedFile {
  relPath: string;
  content: string;
}

export interface RealizedSymbol {
  name: string;
  spec: ImagineSpec;
  symbol: ChzImagineSymbol;
  resolution: ChzResolutionResolved;
  files: EmittedFile[];
  /**
   * True when the committed realization was reused from the cache without a
   * session (docs/62 re-run). The resolution then carries the original
   * provenance so re-writing the cache stays byte-stable.
   */
  reused: boolean;
}

export interface RealizeResult {
  outcome: "resolved" | "blocked" | "failed";
  fileName: string;
  baseName: string;
  baseDir: string;
  symbols: RealizedSymbol[];
  resolutions: ChzImagineSymbolResolution[];
  files: EmittedFile[];
  reason?: string;
  todo?: string;
}

export interface IndependentVerificationInput {
  baseDir: string;
  /** The session's representative symbol (a cycle group has one session). */
  symbol: ChzImagineSymbol;
  resolution: ChzResolutionResolved;
  attempt: number;
  /**
   * The full verification scope: every symbol the session realized. For a
   * cycle group this covers all members — docs/62 completes a group only
   * when the whole group's tests are green, so custom verifiers must use
   * this scope rather than `symbol` alone.
   */
  scope: ChzRealizationScope;
}

export interface RealizeOptions {
  realizers: readonly ChzRealizer[];
  projectRoot?: string;
  activeProfile?: string;
  maxTurns?: number;
  maxRetries?: number;
  askUser?: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;
  now?: () => Date;
  harness?: ChzHarnessServices;
  /** Independent engine verification after Finish, scoped to one symbol. */
  verify?: (input: IndependentVerificationInput) => Promise<ChzVerificationResult>;
  /**
   * Whole-realization verification (epilogue wiring, entry point, full test
   * suite) after every symbol resolved. Defaults to the engine checks.
   */
  verifyRealization?: (baseDir: string) => Promise<ChzVerificationResult>;
  /** Explicit escape hatch used by --skip-tests. */
  skipVerification?: boolean;
  /** Maximum symbols one dependency cycle may contain (docs/62). */
  maxCycleSize?: number;
  /**
   * Safety-net test re-run (no LLM) for a cached symbol whose dependencies
   * changed internally (docs/62). Defaults to the engine's scoped RunTests.
   */
  retest?: (input: { baseDir: string; scope: ChzRealizationScope }) => Promise<ChzVerificationResult>;
  /** chz tool version gating cache reuse. Defaults to the packaged version. */
  chzVersion?: string;
  /**
   * Maximum realize sessions running concurrently (`-j`). Groups become
   * eligible as soon as every outside dependency has settled; per-symbol
   * verification scopes keep concurrent sessions from judging each other.
   * Default 1 (fully sequential).
   */
  jobs?: number;
}

export function realizationBaseDir(fileName: string): string {
  return resolve(dirname(fileName), "chz", "realization", realizationBaseName(fileName));
}

/**
 * Serialize AskUser batches: parallel sessions may escalate at the same
 * moment, but a human answers one question batch at a time. FIFO — the batch
 * that asked first is answered first, and a rejected batch never wedges the
 * queue for later questions.
 */
export function serializeAskUser(
  askUser: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>,
): (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]> {
  let queue: Promise<unknown> = Promise.resolve();
  return (questions) => {
    const turn = queue.then(() => askUser(questions));
    queue = turn.catch(() => undefined);
    return turn;
  };
}

/** Realize every imagine symbol, selecting the first configured compatible Realizer. */
export async function realize(
  analysis: ChzSourceFile,
  options: RealizeOptions,
): Promise<RealizeResult> {
  // The caller owns the analyzer snapshot and must keep it alive until this
  // promise settles. Adapting the already-bound AST here performs no parse and
  // throws before any write if a direct caller bypassed CLI preflight.
  const specs = imagineSpecsFromChzSource(analysis);
  const { fileName } = analysis;
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const baseName = realizationBaseName(fileName);
  const baseDir = realizationBaseDir(fileName);
  const projectRoot = resolve(options.projectRoot ?? dirname(resolve(fileName)));
  const maxTurns = options.maxTurns ?? 24;
  const maxRetries = options.maxRetries ?? 2;
  const activeProfile =
    options.activeProfile ?? analysis.profile?.name ?? "console";
  mkdirSync(join(baseDir, "implementations"), { recursive: true });
  mkdirSync(join(baseDir, "tests"), { recursive: true });
  const humanCode = splitHumanCode(analysis, specs);
  const writeHumanCode = (): void => {
    writeFileSync(join(baseDir, "implementations", "__prologue__.ts"), humanCode.prologue, "utf8");
    writeFileSync(join(baseDir, "implementations", "__epilogue__.ts"), humanCode.epilogue, "utf8");
  };
  writeHumanCode();

  const resolutions: ChzImagineSymbolResolution[] = [];
  const resolvedByName = new Map<string, ChzResolutionResolved>();
  const realizedSymbols: RealizedSymbol[] = [];
  /**
   * Members of groups that did not resolve, with the root cause. Dependents
   * are skipped either way, but a blocked root keeps the run's outcome
   * "blocked" so the human still sees the todo (docs/63).
   */
  const unrealized = new Map<string, "failed" | "blocked">();

  // docs/62 re-run: an unchanged, undrifted, green cache entry is reused
  // without a session. A version mismatch discards the whole cache — the
  // engine's deterministic outputs (ensure harness, entry point) may differ
  // across chz versions, so old hashes stop being trustworthy.
  const chzVersion = options.chzVersion ?? readChzVersion();
  const previousCache = readRealizationCache(baseDir);
  // Recorded human decisions are part of the invalidation hash (docs/63): an
  // edited CONTEXTS.md discards the whole cache, because every cached symbol
  // may have been realized under answers that no longer hold.
  const cacheUsable =
    previousCache !== null &&
    previousCache.chzVersion === chzVersion &&
    previousCache.contextsHash === sha256(readContexts(baseDir));
  const cachedSymbols: Record<string, RealizationCacheSymbol> = cacheUsable
    ? previousCache.symbols
    : {};
  // A changed human layer (prologue/epilogue) cannot invalidate per symbol in
  // v0 — instead every reuse candidate goes through the retest safety net.
  const humanCodeChanged =
    cacheUsable &&
    previousCache.humanCodeHash !== humanCodeHash(humanCode.prologue, humanCode.epilogue);
  const specHashes = new Map(specs.map((spec) => [spec.name, sha256(spec.originalText)]));
  const specNames = new Set(specs.map((spec) => spec.name));
  // Confirmed edges outrank estimates from re-runs on (docs/62 stage 3) —
  // but only for unchanged specs; a changed spec disowns its old imports.
  const confirmedEdges = new Map<string, readonly string[]>();
  for (const spec of specs) {
    const entry = cachedSymbols[spec.name];
    if (
      entry !== undefined &&
      entry.specHash === specHashes.get(spec.name) &&
      Array.isArray(entry.dependencies)
    ) {
      confirmedEdges.set(spec.name, entry.dependencies.filter((name) => specNames.has(name)));
    }
  }

  let graph: ChzDependencyGraph;
  try {
    graph = buildDependencyGraph(analysis, {
      maxCycleSize: options.maxCycleSize,
      confirmedEdges,
    });
  } catch (error) {
    if (error instanceof ChzCycleError) return resultWithFailure("failed", error.message);
    throw error;
  }
  const emitEvent = (message: string, extra?: Partial<ChzHarnessEvent>): void =>
    options.harness?.onEvent?.({ kind: "engine", text: `[chz-realize] ${message}`, ...extra });
  for (const warning of graph.warnings) emitEvent(warning);

  // Symbols re-realized in this run, split by whether their public surface
  // (signature + ensure) differs from the cached one. Surface changes
  // invalidate dependents; internal-only changes send dependents through the
  // test re-run safety net instead (docs/62, per-hop rule).
  const changedSurface = new Set<string>();
  const changedInternal = new Set<string>();
  const askUser = options.askUser === undefined ? undefined : serializeAskUser(options.askUser);

  let launchedGroups = 0;
  const processGroup = async (group: ChzRealizeGroup): Promise<void> => {
    const members = group.symbols;
    const memberNames = new Set(members.map((member) => member.name));
    const representative = members[0]!;
    const displayLabel = members.map((member) => member.name).join(" ↔ ");
    // Observability only: launch order for progress display ([k/n]); the
    // authoritative ordering remains the topological scheduler below.
    const groupIndex = ++launchedGroups;
    const groupTotal = graph.groups.length;
    const lifecycle = (
      kind: "group-start" | "group-end",
      text: string,
      status?: ChzGroupStatus,
      detail?: string,
    ): void =>
      options.harness?.onEvent?.({
        kind,
        group: representative.name,
        label: displayLabel,
        index: groupIndex,
        total: groupTotal,
        ...(status === undefined ? {} : { status }),
        ...(detail === undefined ? {} : { detail }),
        text: `[chz-realize] [${groupIndex}/${groupTotal}] ${text}`,
      });
    const groupEnd = (status: ChzGroupStatus, detail?: string): void => {
      const badge = { resolved: " OK ", reused: " OK ", failed: "FAIL", blocked: "BLCK", skipped: "SKIP" }[status];
      lifecycle(
        "group-end",
        `[${badge}] ${displayLabel}${detail === undefined ? "" : ` — ${detail}`}`,
        status,
        detail,
      );
    };
    lifecycle("group-start", `realizing ${displayLabel}`);
    // Sessions report through a per-group harness so every event carries its
    // group; concurrent (-j) streams stay attributable to a symbol.
    const groupHarness: ChzHarnessServices | undefined = options.harness === undefined
      ? undefined
      : {
          ...options.harness,
          ...(options.harness.onEvent === undefined ? {} : {
            onEvent: (event: ChzHarnessEvent) =>
              options.harness!.onEvent!({ group: representative.name, ...event }),
          }),
        };

    // docs/62: a failed symbol halts only its dependents. Groups arrive in
    // topological order, so every outside dependency has already either
    // resolved or landed in `unrealized` — independent groups keep going.
    const missingDependency = members
      .flatMap((member) => member.dependencies)
      .find((dependency) => !memberNames.has(dependency.name) && unrealized.has(dependency.name));
    if (missingDependency !== undefined) {
      const cause = unrealized.get(missingDependency.name)!;
      groupEnd(
        "skipped",
        `dependency '${missingDependency.name}' ${cause === "blocked" ? "is blocked" : "was not realized"}`,
      );
      for (const member of members) {
        unrealized.set(member.name, cause);
        resolutions.push(
          cause === "blocked"
            ? {
                outcome: "blocked",
                symbol: member,
                reason: `Skipped '${member.name}': dependency '${missingDependency.name}' is blocked.`,
                todo: `Unblock '${missingDependency.name}', then rerun chz realize.`,
              }
            : {
                outcome: "failed",
                symbol: member,
                reason: `Skipped '${member.name}': dependency '${missingDependency.name}' was not realized.`,
              },
        );
      }
      return;
    }

    const renderedEnsures = new Map(
      members.map((member) => [
        member.name,
        renderEnsureHarness(
          analysis,
          specByName.get(member.name)!,
          specs,
          humanCode,
        ),
      ]),
    );
    const writeEnsures = (): void => {
      for (const [name, content] of renderedEnsures) {
        writeFileSync(join(baseDir, "tests", `test_${name}.ensure.ts`), content, "utf8");
      }
    };
    writeEnsures();

    const scope: ChzRealizationScope = { symbolNames: members.map((member) => member.name) };
    const groupLabel = members.map((member) => `'${member.name}'`).join(", ");

    // Reuse decision (docs/62). A member is reusable when its cache entry is
    // green, its spec is unchanged, and every committed artifact still hashes
    // to the recorded value (drift falls back to re-realizing). A cycle
    // reuses only as a whole — it was realized as one session.
    const memberReuseEntry = (member: ChzImagineSymbol): RealizationCacheSymbol | null => {
      const entry = cachedSymbols[member.name];
      if (entry === undefined || entry.testsPassed !== true) return null;
      // The cache is on-disk JSON: a hand-edited or corrupted entry must
      // degrade to a fresh realization, never crash a later engine step
      // (the reused provenance is written back verbatim at cache time).
      if (typeof entry.model !== "string") return null;
      if (typeof entry.realizedAt !== "string" || Number.isNaN(Date.parse(entry.realizedAt))) {
        return null;
      }
      if (entry.specHash !== specHashes.get(member.name)) return null;
      if (sha256(renderedEnsures.get(member.name)!) !== entry.ensureTestHash) return null;
      const implementation = join(baseDir, "implementations", `${member.name}.ts`);
      const autogen = join(baseDir, "tests", `test_${member.name}.autogen.ts`);
      if (!existsSync(implementation) || sha256(readFileSync(implementation, "utf8")) !== entry.implementationHash) return null;
      if (!existsSync(autogen) || sha256(readFileSync(autogen, "utf8")) !== entry.autogenTestHash) return null;
      return entry;
    };
    const reuseEntries = new Map<string, RealizationCacheSymbol>();
    for (const member of members) {
      const entry = memberReuseEntry(member);
      if (entry === null) break;
      reuseEntries.set(member.name, entry);
    }
    const outsideDependencies = members
      .flatMap((member) => member.dependencies)
      .filter((dependency) => !memberNames.has(dependency.name));
    const surfaceInvalidated = outsideDependencies.some((dependency) =>
      changedSurface.has(dependency.name),
    );
    let retestFeedback: string | undefined;
    if (reuseEntries.size === members.length && !surfaceInvalidated) {
      let reusable = true;
      const needsRetest =
        humanCodeChanged ||
        outsideDependencies.some((dependency) => changedInternal.has(dependency.name));
      // --skip-tests skips every engine verification, including this safety
      // net — reuse then proceeds unchecked, exactly like a fresh session.
      if (needsRetest && !options.skipVerification) {
        // A dependency (or the human layer) changed internally: contracts
        // stand, but behavior may have drifted. Re-run this group's tests
        // (no LLM); green stops the propagation, red invalidates the group.
        emitEvent(`${groupLabel}: dependencies changed internally — re-running tests`, { group: representative.name });
        const retested = options.retest === undefined
          ? await runScopedTests(baseDir, scope, projectRoot, activeProfile, maxTurns, maxRetries, groupHarness)
          : await options.retest({ baseDir, scope });
        if (!retested.passed) {
          reusable = false;
          retestFeedback = boundVerificationFeedback(retested.output);
          emitEvent(`${groupLabel}: tests went red under changed dependencies — re-realizing`, { group: representative.name });
        }
      }
      if (reusable) {
        for (const member of members) {
          const entry = reuseEntries.get(member.name)!;
          const spec = specByName.get(member.name)!;
          const resolution: ChzResolutionResolved = {
            outcome: "resolved",
            symbol: member,
            resolvedFile: join(baseDir, "implementations", `${member.name}.ts`),
            resolvedTestFiles: [join(baseDir, "tests", `test_${member.name}.autogen.ts`)],
            resolvedAt: new Date(entry.realizedAt),
            resolvedBy: entry.model,
          };
          resolutions.push(resolution);
          resolvedByName.set(member.name, resolution);
          realizedSymbols.push({
            name: member.name,
            spec,
            symbol: member,
            resolution,
            files: collectSymbolFiles(baseDir, spec, resolution),
            reused: true,
          });
        }
        groupEnd("reused", "unchanged — reused the cached realization");
        return;
      }
    }

    // A cycle is one session, so one Realizer must support every member type.
    const realizer = options.realizers.find((candidate) =>
      members.every((member) => candidate.supportedSymbolTypes.includes(member.type)),
    );
    if (realizer === undefined) {
      groupEnd("failed", "no compatible Realizer");
      for (const member of members) {
        unrealized.set(member.name, "failed");
        resolutions.push({
          outcome: "failed",
          symbol: member,
          reason: group.circular
            ? `No realizer supports every symbol type in the dependency cycle ${members.map((item) => `'${item.name}'`).join(", ")}.`
            : `No realizer found for symbol '${member.name}' (type: ${member.type}).`,
        });
      }
      return;
    }

    const memberResolution = (
      member: ChzImagineSymbol,
      resolution: ChzResolutionResolved,
    ): ChzResolutionResolved =>
      member === resolution.symbol ? resolution : {
        outcome: "resolved",
        symbol: member,
        resolvedFile: join(baseDir, "implementations", `${member.name}.ts`),
        resolvedTestFiles: [join(baseDir, "tests", `test_${member.name}.autogen.ts`)],
        // The session-level assumptions report covers the whole cycle.
        ...(resolution.assumptionsReport === undefined
          ? {}
          : { assumptionsReport: resolution.assumptionsReport }),
        resolvedAt: resolution.resolvedAt,
        resolvedBy: resolution.resolvedBy,
      };

    let feedback: string | undefined = retestFeedback;
    let groupResolution: ChzImagineSymbolResolution | undefined;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const baseContexts = readContexts(baseDir);
      const context = {
        projectRoot,
        outputDir: baseDir,
        activeProfile,
        scope,
        resolvedDependencies: [
          ...new Map(
            members
              .flatMap((member) => member.dependencies)
              .filter((dependency) => !memberNames.has(dependency.name))
              .flatMap((dependency) => {
                const resolution = resolvedByName.get(dependency.name);
                return resolution === undefined
                  ? []
                  : [[dependency.name, resolution] as const];
              }),
          ).values(),
        ],
        maxTurns,
        maxRetries,
        baseContexts,
        askUser,
        attempt,
        verificationFeedback: feedback,
        now: options.now,
        harness: groupHarness,
      };
      const resolution = await realizer.realize(representative, context);
      // These harnesses are human-contract material owned by the engine.
      // Restore them after every session so a model edit can never weaken
      // self-grading.
      writeEnsures();
      // The split human source is engine-owned for the same reason: the model
      // may read prologue helpers but must never rewrite either human layer.
      writeHumanCode();
      groupResolution = resolution;
      if (resolution.outcome !== "resolved") break;

      // The base harness validates every session file at Finish; a custom
      // Realizer may not, and a missing file must never surface later as a
      // raw fs error from provenance stamping or cache building.
      const requiredFiles = members.flatMap((member) =>
        member === resolution.symbol
          ? [resolution.resolvedFile, ...resolution.resolvedTestFiles]
          : [
              join(baseDir, "implementations", `${member.name}.ts`),
              join(baseDir, "tests", `test_${member.name}.autogen.ts`),
            ],
      );
      const missingFile = requiredFiles.find((file) => !existsSync(file));
      if (missingFile !== undefined) {
        groupResolution = {
          outcome: "failed",
          symbol: representative,
          reason: `Realizer claimed Finish, but ${relative(baseDir, missingFile)} was not written.`,
        };
        break;
      }

      const stampedAt = options.now ? options.now() : new Date();
      for (const member of members) {
        attachProvenance(
          specByName.get(member.name)!,
          memberResolution(member, resolution),
          stampedAt,
        );
      }
      if (options.skipVerification) break;

      const verification = options.verify === undefined
        ? await runDefaultVerification(
            baseDir,
            scope,
            projectRoot,
            activeProfile,
            maxTurns,
            maxRetries,
            options.harness,
          )
        : await options.verify({ baseDir, symbol: representative, resolution, attempt, scope });
      if (verification.passed) break;
      feedback = boundVerificationFeedback(verification.output);
      if (attempt > maxRetries) {
        groupResolution = {
          outcome: "failed",
          symbol: representative,
          reason: `Independent verification failed after ${attempt} attempt${attempt === 1 ? "" : "s"}:\n${feedback}`,
        };
      }
    }

    if (groupResolution === undefined) {
      groupResolution = {
        outcome: "failed",
        symbol: representative,
        reason: "Realizer returned no resolution.",
      };
    }

    if (groupResolution.outcome === "resolved") {
      for (const member of members) {
        const resolution = memberResolution(member, groupResolution);
        const spec = specByName.get(member.name)!;
        resolutions.push(resolution);
        resolvedByName.set(member.name, resolution);
        realizedSymbols.push({
          name: member.name,
          spec,
          symbol: member,
          resolution,
          files: collectSymbolFiles(baseDir, spec, resolution),
          reused: false,
        });
        // Classify the re-realization for downstream propagation: an
        // unchanged public surface sends dependents through the retest
        // safety net; a changed (or first-seen) surface invalidates them.
        const cached = cachedSymbols[member.name];
        if (cached !== undefined && cached.publicSurfaceHash === sha256(publicSurfaceText(spec))) {
          changedInternal.add(member.name);
        } else {
          changedSurface.add(member.name);
        }
      }
      groupEnd("resolved");
    } else {
      groupEnd(
        groupResolution.outcome === "blocked" ? "blocked" : "failed",
        groupResolution.reason.split("\n", 1)[0],
      );
      for (const member of members) {
        unrealized.set(member.name, groupResolution.outcome === "blocked" ? "blocked" : "failed");
        resolutions.push(
          member === groupResolution.symbol
            ? groupResolution
            : { ...groupResolution, symbol: member },
        );
      }
    }
  };

  // Ready-queue scheduler (`-j`). A group starts once every outside
  // dependency has settled (resolved, reused, or unrealized); up to `jobs`
  // groups run concurrently. jobs = 1 reproduces the sequential order
  // exactly, because the first ready group in topological order launches
  // alone each round.
  const jobs = Math.max(1, Math.floor(options.jobs ?? 1));
  const pendingGroups = [...graph.groups];
  const runningGroups = new Map<ChzRealizeGroup, Promise<void>>();
  const settledSymbol = (name: string): boolean =>
    resolvedByName.has(name) || unrealized.has(name);
  while (pendingGroups.length > 0 || runningGroups.size > 0) {
    for (let index = 0; index < pendingGroups.length && runningGroups.size < jobs; ) {
      const group = pendingGroups[index]!;
      const memberNames = new Set(group.symbols.map((member) => member.name));
      const ready = group.symbols.every((member) =>
        member.dependencies.every(
          (dependency) => memberNames.has(dependency.name) || settledSymbol(dependency.name),
        ),
      );
      if (!ready) {
        index++;
        continue;
      }
      pendingGroups.splice(index, 1);
      const task = processGroup(group).finally(() => {
        runningGroups.delete(group);
      });
      runningGroups.set(group, task);
    }
    if (runningGroups.size === 0) {
      // Unreachable on a well-formed SCC DAG; fail loudly instead of hanging.
      for (const group of pendingGroups.splice(0)) {
        for (const member of group.symbols) {
          unrealized.set(member.name, "failed");
          resolutions.push({
            outcome: "failed",
            symbol: member,
            reason: `Scheduler could not start '${member.name}': its dependencies never settled.`,
          });
        }
      }
      break;
    }
    await Promise.race(runningGroups.values());
  }

  // Concurrent completion order is nondeterministic; the reported order and
  // the cache field order must stay stable, so normalize to source order.
  const specOrder = new Map(specs.map((spec, index) => [spec.name, index]));
  realizedSymbols.sort((a, b) => specOrder.get(a.name)! - specOrder.get(b.name)!);
  resolutions.sort((a, b) => specOrder.get(a.symbol.name)! - specOrder.get(b.symbol.name)!);

  if (unrealized.size > 0) {
    const failed = resolutions.filter((resolution) => resolution.outcome === "failed");
    const blocked = resolutions.filter((resolution) => resolution.outcome === "blocked");
    const reason = [...new Set([...failed, ...blocked].map((resolution) => resolution.reason))]
      .join("\n");
    const todo = [...new Set(blocked.map((resolution) => resolution.todo))].join("\n");
    return resultWithFailure(
      failed.length > 0 ? "failed" : "blocked",
      reason,
      todo === "" ? undefined : todo,
    );
  }

  if (realizedSymbols.length > 0) {
    writeFileSync(
      join(baseDir, "implementation.ts"),
      renderEntryPoint(analysis, humanCode, specs),
      "utf8",
    );
  }

  // Per-symbol verification is scoped, so the human epilogue wiring, the entry
  // point, and cross-symbol integration have not been judged yet. One unscoped
  // pass covers them; its failures are not fed back to a model because no
  // single symbol owns them.
  if (realizedSymbols.length > 0 && !options.skipVerification) {
    const finalVerification = options.verifyRealization === undefined
      ? await runDefaultVerification(
          baseDir,
          undefined,
          projectRoot,
          activeProfile,
          maxTurns,
          maxRetries,
          options.harness,
        )
      : await options.verifyRealization(baseDir);
    if (!finalVerification.passed) {
      return resultWithFailure(
        "failed",
        `Whole-realization verification failed after every symbol resolved. The realized symbols are individually green; check the human-owned wiring (__epilogue__) and cross-symbol integration:\n${boundVerificationFeedback(finalVerification.output)}`,
      );
    }
  }
  const files = collectAllEmittedFiles(baseDir);
  return {
    outcome: "resolved",
    fileName,
    baseName,
    baseDir,
    symbols: realizedSymbols,
    resolutions,
    files,
  };

  function resultWithFailure(
    outcome: "blocked" | "failed",
    reason: string,
    todo?: string,
  ): RealizeResult {
    return {
      outcome,
      fileName,
      baseName,
      baseDir,
      symbols: realizedSymbols,
      resolutions,
      files: collectAllEmittedFiles(baseDir),
      reason,
      ...(todo === undefined ? {} : { todo }),
    };
  }
}

/** Deterministic executable tests for human-authored ensures; engine-owned. */
export function renderEnsureHarness(
  analysis: ChzSourceFile,
  spec: ImagineSpec,
  allSpecs: readonly ImagineSpec[] = imagineSpecsFromChzSource(analysis),
  humanCode: HumanCodeSplit = splitHumanCode(analysis, allSpecs),
): string {
  const fileName = analysis.fileName;
  const base = realizationBaseName(fileName);
  const contracts = [
    ...spec.ensures.map((ensure) => ({ scope: spec.name, ensure })),
    ...spec.members.flatMap((member) =>
      member.ensures.map((ensure) => ({ scope: `${spec.name}.${member.name}`, ensure })),
    ),
  ];
  // Ensure imports and graph edges share the same Checker-symbol analysis. A
  // property name or shadowing local therefore cannot manufacture an import
  // that has no dependency edge.
  const mentioned = new Set(
    collectEstimatedDependencySources(analysis).get(spec.name)?.ensure ?? [],
  );
  const importedSymbols = allSpecs
    .filter((candidate) => candidate.name === spec.name || mentioned.has(candidate.name))
    .map((candidate) => candidate.name);
  const valueImports = contracts.length === 0
    ? ""
    : importedSymbols
        .map((name) => `import { ${name} } from "../implementations/${name}.ts";`)
        .join("\n") + "\n";
  const externalTypes = collectExternalTypeNames(
    analysis,
    spec,
    humanCode,
    new Set(importedSymbols),
  );
  const typeImports = externalTypes.length === 0
    ? ""
    : `import type { ${externalTypes.join(", ")} } from "../implementations/__prologue__.ts";\n`;
  const tests = contracts.length === 0
    ? "// No executable ensure() contracts were declared for this symbol.\n\nexport {};"
    : contracts.map(({ scope, ensure }, index) => {
        const label = ensure.messageSource ?? JSON.stringify(`${scope} ensure #${index + 1}`);
        // The identifier is deliberately position- and path-independent: the
        // harness content must depend only on the imagine block itself, so an
        // edit elsewhere in the file (or a different checkout path) never
        // changes the emitted harness and never defeats cache reuse (docs/62).
        const contractId = `${base}.chz.ts › ${scope} › ensure #${index + 1}`;
        if (ensure.kind === "assertion") {
          const failure = `ensure assertion failed (${contractId})\ncondition: ${ensure.source}`;
          return `it(${label}, () => {
  assert(
${indentSource(ensure.source, 4)},
    ${JSON.stringify(failure)},
  );
});`;
        }

        const failurePrefix = `ensure scenario failed (${contractId}): `;
        const falseResult = `ensure scenario returned false (${contractId})`;
        const argumentsFailure = `ensure scenario (${contractId}) must not declare parameters`;
        return `it(${label}, async () => {
  const scenario: () => unknown | Promise<unknown> = ${ensure.source};
  if (scenario.length !== 0) {
    throw new Error(${JSON.stringify(argumentsFailure)});
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error(${JSON.stringify(falseResult)});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(${JSON.stringify(failurePrefix)} + detail);
  }
});`;
      }).join("\n\n");

  return `/// test_${spec.name}.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from ${base}.chz.ts.

${valueImports}${typeImports}${contracts.length === 0 ? "" : `
declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

`}${tests}
`;
}

function indentSource(source: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return source.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function collectExternalTypeNames(
  analysis: ChzSourceFile,
  spec: ImagineSpec,
  humanCode: HumanCodeSplit,
  valueImports: ReadonlySet<string>,
): string[] {
  const declaration = analysis.imagineDeclarations.find((candidate) =>
    candidate.name === spec.name
  );
  if (declaration === undefined) {
    throw new Error(
      `The analyzed declaration for '${spec.name}' disappeared before ensure emission.`,
    );
  }

  const symbols = new Map<number, string>();
  const addReferences = (
    references: ReturnType<typeof collectTypeSymbolReferences>,
  ): void => {
    for (const { symbol } of references) {
      if (symbolComesOnlyFromTypeScriptLib(symbol)) continue;
      if (humanCode.humanSymbolLayers.get(symbol.id) !== "prologue") {
        continue;
      }
      if (!valueImports.has(symbol.name)) {
        symbols.set(symbol.id, symbol.name);
      }
    }
  };
  addReferences(
    collectTypeSymbolReferences(
      analysis,
      declaration.declaration,
      declaration.declaration,
    ),
  );
  for (const scope of declarationEnsureScopes(declaration)) {
    addReferences(
      collectTypeSymbolReferences(
        analysis,
        scope.ensure.conditionOrScenario,
        scope.owner,
      ),
    );
  }
  return [...new Set(symbols.values())].sort();
}

function renderForwardName(item: EntryPointNamedExport): string {
  return item.importedName === item.exportedName
    ? item.importedName
    : `${item.importedName} as ${item.exportedName}`;
}

function renderNamedForwards(
  items: readonly EntryPointNamedExport[],
  moduleName: string,
): string[] {
  const value = items
    .filter((item) => !item.typeOnly)
    .map(renderForwardName);
  const type = items
    .filter((item) => item.typeOnly)
    .map(renderForwardName);
  return [
    ...(value.length === 0
      ? []
      : [`export { ${value.join(", ")} } from ${JSON.stringify(moduleName)};`]),
    ...(type.length === 0
      ? []
      : [`export type { ${type.join(", ")} } from ${JSON.stringify(moduleName)};`]),
  ];
}

function layerExports(
  humanCode: HumanCodeSplit,
  layer: HumanCodeLayer,
): string[] {
  const moduleName = `./implementations/__${layer}__.ts`;
  const named = humanCode.entryPoint.named.filter(
    (item) =>
      item.source.kind === "layer" &&
      item.source.layer === layer,
  );
  const star = humanCode.entryPoint.star
    .filter((item) => item.layer === layer)
    .map((item) => item.rendered);
  const defaultExport = humanCode.entryPoint.default?.layer === layer
    ? [
        humanCode.entryPoint.default.typeOnly
          ? `export type { default } from ${JSON.stringify(moduleName)};`
          : `export { default } from ${JSON.stringify(moduleName)};`,
      ]
    : [];
  return [
    ...renderNamedForwards(named, moduleName),
    ...star,
    ...defaultExport,
  ];
}

export function renderEntryPoint(
  analysis: ChzSourceFile,
  humanCode: HumanCodeSplit,
  specs: readonly ImagineSpec[] = imagineSpecsFromChzSource(analysis),
): string {
  const base = realizationBaseName(analysis.fileName);
  const declarationExported = new Set(
    analysis.imagineDeclarations
      .filter((declaration) =>
        declaration.declaration.modifiers?.some((modifier) =>
          modifier.kind === SyntaxKind.ExportKeyword
        ) === true
      )
      .map((declaration) => declaration.name),
  );
  const explicitImagineExports = humanCode.entryPoint.named.filter(
    (item) => item.source.kind === "imagine",
  );
  const imagineLines = specs.flatMap((spec) => {
    const forwards: EntryPointNamedExport[] = [
      ...(declarationExported.has(spec.name)
        ? [{
            source: { kind: "imagine" as const, name: spec.name },
            importedName: spec.name,
            exportedName: spec.name,
            typeOnly: false,
          }]
        : []),
      ...explicitImagineExports.filter(
        (item) =>
          item.source.kind === "imagine" &&
          item.source.name === spec.name,
      ),
    ];
    const moduleName = `./implementations/${spec.name}.ts`;
    const rendered = renderNamedForwards(forwards, moduleName);
    const hasRuntimeForward = forwards.some((item) => !item.typeOnly);
    return hasRuntimeForward
      ? rendered
      : [`import ${JSON.stringify(moduleName)};`, ...rendered];
  });
  const prologueExports = layerExports(humanCode, "prologue");
  const epilogueExports = layerExports(humanCode, "epilogue");
  const sections = [
    'import "./implementations/__prologue__.ts";',
    ...prologueExports,
    ...imagineLines,
    'import "./implementations/__epilogue__.ts";',
    ...epilogueExports,
  ];
  return `/// implementation.ts — realization entry point for ${base}.chz.ts (AUTO-GENERATED by chz-realize).
/// Loads human prologue, realized symbols, then human epilogue. Do not edit; re-run \`chz realize\` instead.

${sections.join("\n")}
`;
}

function attachProvenance(spec: ImagineSpec, resolution: ChzResolutionResolved, now: Date): void {
  const implementation = readFileSync(resolution.resolvedFile, "utf8");
  if (!implementation.includes("AUTO-GENERATED CODE - DO NOT EDIT")) {
    const declaration = spec.type === "function"
      ? `imagine function ${spec.name}(${spec.parameters})${spec.returnType ? `: ${spec.returnType}` : ""}`
      : `imagine class ${spec.name}`;
    writeFileSync(
      resolution.resolvedFile,
      `/// ${spec.name}.ts\n/// realization of \`${declaration}\`\n/// realized by ${resolution.resolvedBy} (via chz-realize) on ${now.toISOString()}\n///\n/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)\n\n${implementation.trim()}\n\n/// END OF AUTO-GENERATED CODE\n`,
      "utf8",
    );
  }
  for (const testFile of resolution.resolvedTestFiles) {
    const test = readFileSync(testFile, "utf8");
    if (test.includes("AUTO-GENERATED tests")) continue;
    writeFileSync(
      testFile,
      `/// ${relative(dirname(testFile), testFile)}\n/// AUTO-GENERATED tests for \`imagine ${spec.type} ${spec.name}\`, authored by ${resolution.resolvedBy}\n/// (via chz-realize) on ${now.toISOString()}.\n\n${test.trim()}\n`,
      "utf8",
    );
  }
}

function collectSymbolFiles(
  baseDir: string,
  spec: ImagineSpec,
  resolution: ChzResolutionResolved,
): EmittedFile[] {
  const paths = [
    resolution.resolvedFile,
    ...resolution.resolvedTestFiles,
    join(baseDir, "tests", `test_${spec.name}.ensure.ts`),
  ];
  return [...new Set(paths)].filter(existsSync).map((path) => ({
    relPath: relative(baseDir, path).split("\\").join("/"),
    content: readFileSync(path, "utf8"),
  }));
}

function collectAllEmittedFiles(baseDir: string, directory = baseDir): EmittedFile[] {
  if (!existsSync(directory)) return [];
  const result: EmittedFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectAllEmittedFiles(baseDir, path));
    else if (entry.isFile() && entry.name !== "CONTEXTS.md" && entry.name !== "realization-cache.json") {
      result.push({
        relPath: relative(baseDir, path).split("\\").join("/"),
        content: readFileSync(path, "utf8"),
      });
    }
  }
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readContexts(baseDir: string): string {
  const path = join(baseDir, "CONTEXTS.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function boundVerificationFeedback(output: string): string {
  const lines = output.split(/\r?\n/);
  const boundedLines = lines.length <= 2_000 ? lines : [...lines.slice(0, 1_000), "... output truncated ...", ...lines.slice(-1_000)];
  let bounded = boundedLines.join("\n");
  if (Buffer.byteLength(bounded, "utf8") > 51_200) {
    bounded = Buffer.from(bounded, "utf8").subarray(0, 51_000).toString("utf8") + "\n... output truncated ...";
  }
  return bounded;
}

/**
 * The docs/62 safety net: run one group's tests (autogen + ensure) with no
 * LLM involved, through the same fixed RunTests runner the sessions use.
 */
async function runScopedTests(
  baseDir: string,
  scope: ChzRealizationScope,
  projectRoot: string,
  activeProfile: string,
  maxTurns: number,
  maxRetries: number,
  harness: ChzHarnessServices | undefined,
): Promise<ChzVerificationResult> {
  const context = {
    projectRoot,
    outputDir: baseDir,
    activeProfile,
    scope,
    resolvedDependencies: [],
    maxTurns,
    maxRetries,
    baseContexts: "",
    harness,
  };
  const runtime = new ChzVerificationToolRuntime(context, (path) => resolve(projectRoot, path));
  const rendered = await runtime.execute("RunTests", { testFiles: [] });
  if (rendered === null) return { passed: false, output: "The RunTests runner was unavailable." };
  try {
    const parsed = JSON.parse(rendered) as { passed?: boolean; output?: string };
    return { passed: parsed.passed === true, output: parsed.output ?? rendered };
  } catch {
    return { passed: false, output: rendered };
  }
}

async function runDefaultVerification(
  baseDir: string,
  scope: ChzRealizationScope | undefined,
  projectRoot: string,
  activeProfile: string,
  maxTurns: number,
  maxRetries: number,
  harness: ChzHarnessServices | undefined,
): Promise<ChzVerificationResult> {
  const context = {
    projectRoot,
    outputDir: baseDir,
    activeProfile,
    scope,
    resolvedDependencies: [],
    maxTurns,
    maxRetries,
    baseContexts: "",
    harness,
  };
  const runtime = new ChzVerificationToolRuntime(context, (path) => resolve(projectRoot, path));
  const checks = await Promise.all([
    runtime.execute("RunTests", { testFiles: [] }),
    runtime.execute("RunTypeCheck", {}),
    runtime.execute("RunLinter", {}),
  ]);
  const names = ["Tests", "Type check", "Linter"];
  const parsed = checks.map((check, index) => {
    if (check === null) return { passed: false, output: `${names[index]} tool was unavailable.` };
    try {
      return JSON.parse(check) as { passed: boolean; output?: string; diagnostics?: unknown[] };
    } catch {
      return { passed: false, output: check };
    }
  });
  return {
    passed: parsed.every((check) => check.passed),
    output: parsed.map((check, index) =>
      `## ${names[index]}\n${check.output ?? JSON.stringify(check.diagnostics ?? [], null, 2)}`,
    ).join("\n\n"),
  };
}
