import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  ChzImagineSymbol,
  ChzRealizeContext,
  ChzResolutionResolved,
} from "./types.ts";

/** Canonical fixed prompt from docs/64-realize-harness-prompt.ko.md. */
export const CHZ_REALIZER_SYSTEM = `You are the Cheese Realizer, the implementation engine of the Cheese
language.

A human has written an \`imagine\` declaration: a signature, natural-language
requirements, and \`ensure\` contracts — everything except the implementation.
Your job is to realize it: emit the implementation and its tests inside the
output directory, within the boundaries this harness enforces.

# Division of roles

Cheese's core principle: the LLM implements, the human supervises. How to
implement is yours to decide; what to build, and any decision that reshapes
the artifact's structure, belongs to the human. When a decision is the
human's, escalate it — never bury it in an assumption.

# Your context is pre-assembled

The session context below already carries what realization usually needs:
the symbol specification, the public surfaces of resolved dependencies, and
the decisions recorded in previous sessions. You rarely need to explore the
project to get oriented — when the supplied context covers the task, extra
survey turns are wasted turns. Reach for ReadFile, ReadDir, Glob, or Grep
when a specific fact is missing from the context, not as an opening move.

# Quick triage, then code

Triage from the supplied session context. Unless one of the conditions below
applies, begin the first implementation increment in the first turn,
normally starting with a WriteFile rather than a read. Do not spend turns
surveying the codebase or only describing a plan.

- Impossible in principle, or inappropriate to fulfill: call Abort now.
- Materially better with a structural decision only the human can approve
  (e.g. adding an external dependency): call AskUser now.
- Progress requires a human action (installing a dependency, providing a
  credential or fixture): call Block now, with a concrete todo.

Aborting after dozens of turns of work wastes the human's time and tokens.

# Ambiguity

If the requirements leave room for interpretation and either reading is easy
to change later: pick a reasonable one, mark it with an inline \`ASSUMPTION:\`
comment (what you assumed, and why), and keep going. Do not escalate these.

Decisions recorded from previous sessions appear in the session context.
They are settled: build on them, do not ask again.

# Incremental workflow

Work through realization as a sequence of feedback-driven increments, not as
one-shot generation.

- Treat the supplied symbol specification, dependency surfaces, and recorded
  decisions as the default working context. Do not read project files merely
  to learn the architecture, conventions, or surrounding code.
- Read or search project files only when a specific missing fact blocks the
  next concrete edit, or when a diagnostic cannot be understood from the
  supplied context and current artifacts. Use the narrowest relevant tool and
  stop when that question is answered.
- Identify a small number of coherent behaviors that together satisfy the
  symbol specification and every ensure contract, then immediately implement
  the first one. Do not spend a separate turn only describing the plan.
- Implement and test one coherent behavior, or one tightly coupled group of
  behaviors, at a time.
- For a class, an increment is normally a constructor invariant, one public
  behavior, or a tightly coupled group of members — not necessarily the whole
  class and not mechanically one method per turn.
- Treat tool results as checkpoints. After a material write or a verification
  failure, inspect the returned diagnostics before deciding dependent edits.
- Independent tool calls may be batched, but never call Finish in the same
  response as writes or verification whose results you have not yet seen.
- Prefer targeted tests while iterating. After all behaviors are covered, run
  the complete tests, type checker, and linter.
- Partial artifacts are working state only. Do not call Finish until every
  required behavior and ensure contract is implemented and the final
  verification results are green.

# What you produce

Realized code targets auditability, not just correctness:

- Comment densely — explain how you interpreted the requirements and what
  each step does.
- Mark every interpretive leap with an \`ASSUMPTION:\` comment.
- Stay inside the restricted subset: no \`eval\`, no \`any\`, no APIs outside
  the active profile shown in <env>.
- Import human-written code only from \`__prologue__\`. When the prologue
  already provides a type or value your implementation needs, import it from
  \`./__prologue__.ts\` — never re-declare it in realized code, or the copy
  will silently drift from the human-owned original. Never reference
  \`__epilogue__\` symbols — verification reports that as an error.
- Never modify or delete a statement marked \`@chz-realize-override\`; it is
  human-owned.
- Treat every \`ensure\` as a human-owned executable acceptance test. The
  engine emits and runs those tests independently; never modify an
  \`.ensure.ts\` file.
- Develop additional autogen unit tests from the requirements together with
  the implementation in verified increments.
- Write the LLM-authored test suite for each symbol to
  \`tests/test_<symbol-name>.autogen.ts\`; this exact name is required for
  collection and independent verification.

# Working in this harness

- Tool boundaries are enforced in code: reads inside the project root,
  writes inside the output directory. When a tool call fails, the error
  message tells you the next action — follow it.
- Verify as you go with RunTests, RunTypeCheck, and RunLinter. Finish is a
  claim, not a verdict: the engine re-runs verification independently after
  Finish, and failures come back to you.
- Every session ends with exactly one of Finish, Block, or Abort.`;

export const TURN_LIMIT_PROMPT = `CRITICAL - TURN LIMIT REACHED

This session has reached its turn limit. All tools except Finish, Block, and
Abort are now disabled.

End the session now by calling exactly one of:

- Finish — only if the artifact is complete and you have seen verification
  pass in this session.
- Block — if a human action would unblock the work. Put what you
  accomplished and what remains in \`reason\`, and the concrete human action
  in \`todo\`.
- Abort — if the work cannot be completed. Put what you accomplished, what
  remains, and why it cannot proceed in \`reason\`.

Do not attempt any other tool call; it will fail.`;

/** Kickoff user turn appended after the two system parts; canonical text in docs/64. */
export function buildKickoffPrompt(symbol: ChzImagineSymbol, context: ChzRealizeContext): string {
  const members = [symbol, ...symbol.circularDependencies]
    .filter((candidate, index, all) => all.findIndex((item) => item.name === candidate.name) === index)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = members.map((member) => `\`${member.name}\``).join(", ");
  const stem = members.length === 1 ? members[0]!.name : "<symbol-name>";
  if (context.verificationFeedback?.trim()) {
    return `Fix the failed verification of ${names} now. Start from the
verification feedback above and the artifacts already in the output
directory.`;
  }
  return `Realize ${names} now.

Do not open with ReadFile, ReadDir, Glob, or Grep unless realizing ${names} requires a specific fact that the supplied context does not contain.
Save each symbol implementation to
${context.outputDir}/implementations/${stem}.ts and its test suite to
${context.outputDir}/tests/test_${stem}.autogen.ts.`;
}

function absoluteFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function requireReadable(path: string, description: string): string {
  if (!existsSync(path)) {
    throw new Error(`Cannot start realize session: ${description} is missing at ${path}.`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot start realize session: failed to read ${description} at ${path}: ${(error as Error).message}`,
    );
  }
}

function requireProjectFile(root: string, path: string, description: string): string {
  const absoluteRoot = realpathSync.native(resolve(root));
  const absolutePath = absoluteFrom(root, path);
  if (!existsSync(absolutePath)) return requireReadable(absolutePath, description);
  const canonical = realpathSync.native(absolutePath);
  const rel = relative(absoluteRoot, canonical);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(
      `Cannot start realize session: ${description} at ${absolutePath} is outside the project root (${root}).`,
    );
  }
  return requireReadable(canonical, description);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function symbolBlock(symbol: ChzImagineSymbol): string {
  return `<symbol name="${escapeAttribute(symbol.name)}" type="${symbol.type}" file="${escapeAttribute(symbol.file)}" line="${symbol.posLine}">
${symbol.definition}
</symbol>`;
}

function dependencySurface(
  resolution: ChzResolutionResolved,
  implementation: string,
  projectRoot: string,
): string {
  const assumptionLines = implementation
    .split(/\r?\n/)
    .filter((line) => line.includes("ASSUMPTION:"))
    .slice(0, 20);
  const surface = [resolution.symbol.definition.split(/\r?\n/, 1)[0] ?? resolution.symbol.definition];

  if (resolution.assumptionsReport !== undefined) {
    surface.push(
      requireProjectFile(
        projectRoot,
        resolution.assumptionsReport,
        `assumptions report for ${resolution.symbol.name}`,
      ).trim(),
    );
  } else if (assumptionLines.length > 0) {
    surface.push(assumptionLines.join("\n"));
  }
  return surface.filter((part) => part.length > 0).join("\n");
}

/** Build the deterministic, per-session baseline described by docs/64. */
export function buildSessionBaseline(
  symbol: ChzImagineSymbol,
  context: ChzRealizeContext,
  model: string,
): string {
  requireProjectFile(context.projectRoot, symbol.file, `source file for ${symbol.name}`);
  for (const circular of symbol.circularDependencies) {
    requireProjectFile(context.projectRoot, circular.file, `source file for ${circular.name}`);
  }

  const now = context.now ? context.now() : new Date();
  const date = [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const sections: string[] = [
    `Here is information about the session you are running in:
<env>
  Project root (read boundary): ${context.projectRoot}
  Realization output directory (write boundary): ${context.outputDir}
  Active profile: ${context.activeProfile}
  Model: ${model}
  Today's date: ${date}
</env>`,
  ];

  const cycle = [symbol, ...symbol.circularDependencies]
    .filter((candidate, index, all) => all.findIndex((item) => item.name === candidate.name) === index)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (cycle.length > 1) {
    sections.push(
      `# Symbol to realize

The following ${cycle.length} symbols form a dependency cycle and must be realized
together in this session. All of their tests must pass together.

${cycle.map(symbolBlock).join("\n\n")}`,
    );
  } else {
    sections.push(`# Symbol to realize

${symbolBlock(symbol)}`);
  }

  const prologuePath = resolve(
    absoluteFrom(context.projectRoot, context.outputDir),
    "implementations",
    "__prologue__.ts",
  );
  if (existsSync(prologuePath)) {
    const prologue = requireProjectFile(
      context.projectRoot,
      prologuePath,
      "human-written prologue",
    );
    sections.push(`# Human-written prologue

Human-written code your implementation may import. When the prologue already
provides a type or value you need, import it from \`./__prologue__.ts\` —
never re-declare it in your implementation.

<prologue file="implementations/__prologue__.ts">
${prologue.trim()}
</prologue>`);
  }

  if (context.resolvedDependencies.length > 0) {
    const dependencies = [...context.resolvedDependencies]
      .sort((a, b) => a.symbol.name.localeCompare(b.symbol.name))
      .map((dependency) => {
        const path = absoluteFrom(context.projectRoot, dependency.resolvedFile);
        const implementation = requireProjectFile(
          context.projectRoot,
          path,
          `resolved dependency ${dependency.symbol.name}`,
        );
        return `<dependency name="${escapeAttribute(dependency.symbol.name)}" file="${escapeAttribute(dependency.resolvedFile)}">
${dependencySurface(dependency, implementation, context.projectRoot)}
</dependency>`;
      });
    sections.push(`# Resolved dependencies

Your implementation builds on these already-realized symbols. Use the surfaces
below as the default context. Read a dependency file only when a specific
detail missing from its excerpt blocks the next concrete edit.

${dependencies.join("\n\n")}`);
  }

  if (context.baseContexts.trim().length > 0) {
    sections.push(`# Decisions from previous sessions

Instructions from: ${context.outputDir}/CONTEXTS.md
${context.baseContexts}`);
  }

  if (context.verificationFeedback?.trim()) {
    const attempt = context.attempt ?? 2;
    sections.push(`# Verification feedback from the previous attempt

Your previous attempt failed independent verification. The artifacts you
wrote are still in the output directory — read them, fix the failures, and
finish again.

<verification attempt="${attempt}" of="${context.maxRetries}">
${context.verificationFeedback}
</verification>`);
  }

  return sections.join("\n\n");
}

export function buildSystemParts(
  symbol: ChzImagineSymbol,
  context: ChzRealizeContext,
  model: string,
): readonly [string, string] {
  return [CHZ_REALIZER_SYSTEM, buildSessionBaseline(symbol, context, model)];
}
