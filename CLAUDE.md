# CLAUDE.md

## Project: Cheese (`.chz`)

Cheese is a general-purpose programming language designed for vibe coding:
**the LLM writes the implementation, the human supervises.** The human
expresses intent (specs, contracts, oversight); the LLM produces the
implementation. Cheese's core differentiator is that this division of roles is
enforced by the language grammar and the compiler, not left to convention.

**Current status: early v0.** The pipeline runs end-to-end for one example
(`examples/collision.chz.ts`), but the current `src/` implementation is a
one-shot prototype that predates the design docs below — expect large
rewrites. When code and docs disagree, the docs are more current.

Design lives in two places (both Korean, living documents): numbered specs in
`docs/` — `00` intro, `60` realize output & overrides, `61` Realizer harness,
`62` dependency graph, `63` harness rules & tool spec, `64` harness system
prompt — and `docs/idea-sketches/` for open questions, rationale, and
discussion history (`260723-00-init.md` is the latest sketch). If this file
and those docs disagree, the docs are more likely to be current.

Writing conventions for the numbered specs — number-band allocation, target
audience and tone, cross-reference and code-fence rules — are defined in
`docs/WRITING_RULES.md`. `docs/idea-sketches/` is a free-form scratchpad and
exempt from those rules, and docs `63`–`64` are deliberately exempt as well
(they are deep implementation-level references, denser than the other specs).

## Core concepts

- **`imagine`** — the human declares a function/class/module with only a
  signature plus natural-language `requirements`, no implementation.
- **realize** — a development-time step (`chz realize`) where an LLM-based
  code resolver emits the implementation, typedefs, and unit tests for
  `imagine` symbols. Realized artifacts are committed to git; builds and CI
  run only from committed realized code and never call an LLM. Realized code
  targets auditability, not just correctness: it is densely commented, with
  explicit `ASSUMPTION:` notes wherever the requirements left room for
  interpretation.
- **`required`** — "usage creates the contract": referencing a not-yet-existing
  symbol of an `imagine` class/module (e.g. `game.start()`) places a
  compile-time obligation on the LLM to implement it. Can also be declared
  explicitly via `required imagine func/var`.
- **`ensure`** — human-written contracts placed next to `requirements`,
  overloaded by argument type: `ensure((args, retval) => ...)` is a
  machine-checked predicate run as tests against the realized code, and
  `` ensure(`natural language`) `` is a natural-language contract the LLM
  must convert into generated (autogen) tests. Verification thus reflects
  human intent rather than only the LLM's own interpretation of the
  requirements. The `precondition` keyword is reserved for future input
  constraints.
- **`imagine resource`** — generative assets (images, audio, …) requested
  from generative AI. Declarative properties (`width = 64`,
  `maxDuration = 1.0`) act both as generation parameters and as verification
  constraints on the emitted asset. Extends "LLM produces, human supervises"
  beyond code to resources.
- **`@profile`** — declares the program's profile (e.g. `console`), which
  auto-loads the matching IO modules; proposed to also act as a capability
  boundary for realized code (e.g. no sockets under the `console` profile).

## Architecture (decided)

Cheese is an intermediate language whose syntax is a **TypeScript superset**
— "a superset on top of a subset":

- **Extensions are for humans.** Human-written code may use full TypeScript;
  almost all valid TS is valid Cheese. Cheese adds `imagine` / `ensure` /
  `@profile` on top.
- **Restrictions are for the LLM.** Realized code must stay within a
  restricted subset (no `eval`, no `any`, no APIs outside the active
  `@profile`).
- The Cheese extension keywords exist only at declaration level, so the
  compiler is a declaration-level preprocessor plus the TypeScript compiler
  API — no full self-built parser. `chz build` = strip extensions → plain TS
  → esbuild/tsc, with no LLM involvement.
- "Usage creates the contract" is implemented by running tsc on the stripped
  output and converting its diagnostics (e.g. `Property 'start' does not
  exist`) into the LLM's obligation list.
- Precedent: Civet, a small-team TS-superset transpiler, proves this path is
  viable.

## Realize subsystem design (docs 60–64)

- **Realization layout (60, 00)** — `chz realize` emits into
  `chz/realization/{name}/`. Human-written code is copied in alongside the
  realized per-symbol files: code that does not reference imagine symbols
  goes to `implementations/__prologue__.ts`, code that does goes to
  `__epilogue__.ts`. One-way ES-module layering (prologue ← realized code ←
  epilogue) means realized code may only reference prologue symbols;
  referencing epilogue is an error. Build/CI compile this directory alone,
  with no LLM. `.chz.ts` stays the source of truth; realized code is edited
  only via `@chz-realize-override` markers, and unauthorized drift is caught
  by hashes in `realization-cache.json`. Preserving top-level side-effect
  order across the split is an open design issue.
- **Realizer (61)** — the LLM adapter/harness:
  `realize(symbol, context) → resolution`. `ChzRealizerBase` owns the agentic
  loop, tool dispatch, boundary checks (reads inside project root, writes
  only to the realization output dir), turn caps, and retries; subclasses
  implement only the transport (`chat()`). `ClaudeCodeRealizer` is the
  exception: it delegates the whole loop to Claude Code and injects the
  harness rules instead. The tool set is fixed (ReadFile, ReadDir, Glob,
  Grep, WriteFile, FindAndReplace, RunTests, RunTypeCheck, RunLinter,
  AskUser, Finish, Block, Abort — full spec in doc 63) — deliberately no
  shell tool. `Finish` is only a claim: the engine re-runs verification
  independently, feeds red results back as bounded retries, and on final
  failure halts realize for dependent symbols.
- **Harness rules & tool spec (63)** — decision boundaries plus the detailed
  tool contract. Escalation ladder for decisions the LLM must not make alone:
  `ASSUMPTION:` comment → `AskUser` (structured multi-question schema;
  engine records answers into `CONTEXTS.md`, which is injected into later
  sessions and included in the invalidation hash) → `Block` (human must act;
  outcome `blocked`, nothing cached) → `Abort` (outcome `failed`). Session
  outcomes are a discriminated union resolved/blocked/failed. Tool-spec
  principles: boundaries enforced in the dispatcher (realpath+contains;
  read = projectRoot minus a secrets blocklist, write = outputDir, hard-fail
  instead of asking); every error message is a recovery hint; descriptions
  must match implementation; one output-bounding boundary (2000 lines/50KB,
  overflow saved under `.chz/tool-output/`); write tools return inline
  diagnostics. ReadFile/ReadDir are paged (offset/limit, line-number
  prefixes); FindAndReplace is exact-match only (fuzzy is a future note);
  read-before-write and stale checks are enforced via a per-session
  read-file hash set; Glob/Grep delegate to a pinned ripgrep.
- **Harness system prompt (64)** — the canonical prompt `ChzRealizerBase`
  injects (English canonical text lives in the doc itself; edit the doc to
  edit the prompt). Layered: prose carries only what code cannot enforce —
  role division, triage-first, ASSUMPTION vs escalation, auditability style
  (dense comments, restricted subset, prologue-only imports, override
  markers untouchable), explicit session endings. Structure: system =
  [fixed role part (byte-identical across sessions, cache-friendly),
  per-session baseline]. Baseline is deterministic and frozen per session:
  `<env>` block (read/write roots, @profile, model, date) → symbol spec
  (verbatim) → resolved dependency surfaces (name-sorted excerpts) →
  CONTEXTS.md → verification feedback (retries only); absent sources are
  omitted, unreadable ones fail the session start. At the turn cap only
  Finish/Block/Abort stay materialized and a closing prompt forces an
  explicit ending with a handover summary; no ending → `failed`. Whether
  prompt revisions join the invalidation hash is an open question.
- **Dependency graph (62)** — a symbol-level DAG drives realize order
  (topological, leaves first). Edges are discovered in three stages:
  signature type refs → requirements/ensure mentions → actual usage extracted
  from realized artifacts (authoritative from then on). Cycles (SCCs) are
  realized together as one session — warned, and an error past a size cap;
  extracting a human-owned interface is the recommended fix. Invalidation
  propagates to dependents only when a symbol's public surface (signature +
  ensure contracts) changed; otherwise dependents merely re-run their tests
  and are invalidated only if those go red.

## v0 scope

- Syntax: `imagine function/class` + `requirements` + `ensure` + minimal
  wiring statements. Nothing more.
- Pipeline: `.chz` preprocessing (declaration-level) → tsc diagnostics →
  realize (via the claude CLI) → emit TS + vitest tests → on green tests,
  record the hash in a lockfile.
- First milestone — a single function (`충돌판정_2D`, 2D collision check)
  end-to-end, `.chz` → realize → tests green — is **done**
  (`examples/collision.chz.ts`).
