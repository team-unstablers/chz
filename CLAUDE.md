# CLAUDE.md

## Project: Cheese (`.chz`)

Cheese is a general-purpose programming language designed for vibe coding:
**the LLM writes the implementation, the human supervises.** The human
expresses intent (specs, contracts, oversight); the LLM produces the
implementation. Cheese's core differentiator is that this division of roles is
enforced by the language grammar and the compiler, not left to convention.

**Current status: early v0.** The pipeline runs end-to-end for one example
(`examples/collision.chz.ts`). The shared Realizer harness, fixed tool surface,
OpenAI-compatible transport, `chz.config.js` injection, independent
verification loop (symbol-scoped, plus a final whole-realization pass), the
prologue/epilogue emission, and the symbol-level dependency graph
(`src/graph.ts`: SCC cycles realized as one session, configurable cycle size
cap, confirmed-edge + public-surface recording into `realization-cache.json`,
failures skipping only dependents) are implemented. Incremental re-runs work
per docs/62: unchanged green symbols are reused straight from the cache,
invalidation propagates per-hop on public-surface changes, internal-only
changes trigger the dependents' no-LLM test-re-run safety net, a drifted
artifact falls back to re-realization, an edited CONTEXTS.md discards the
cache, and a changed human layer (prologue/epilogue) routes every reused
symbol through the retest net. `chz realize -j N` runs independent graph
groups concurrently (AskUser batches are serialized FIFO), and the file-less
form realizes the `include` globs from chz.config.js file by file. Broader
syntax, override (`@chz-realize-override`) preservation, and the cross-file
graph implementation remain future work; the module-resolution / sidecar-shim
spec that cross-file imports build on is settled in doc 20. When code and
docs disagree, the docs are more current.

**In progress: the AST-backed parser migration.** The v0 preprocessor is a
brace-depth scanner, not a parser, and several modules re-read source
structure with their own regexes. `docs/idea-sketches/260726-00-ast-backed-cheese-parser.md`
settles the replacement — a thin Cheese extension parser plus a TypeScript
projection and an AST overlay — and drives it in phases (see
"AST-backed parser migration" below for where the work currently stands).

Design lives in two places (both Korean, living documents): numbered specs in
`docs/` — `00` intro, `10` imagine declaration grammar, `20` module
resolution & the no-build principle, `21` projection, preflight ordering &
obligation promotion, `60`
realize output & overrides, `61` Realizer harness,
`62` dependency graph, `63` harness rules & tool spec, `64` harness system
prompt — and `docs/idea-sketches/` for open questions, rationale, and
discussion history (`260726-01-projection-spike-findings.md` is the latest
sketch). If this file and those docs disagree, the docs are more likely to be
current.

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
- **`ensure`** — human-written executable acceptance tests placed next to
  `requirements`. `ensure(condition, message?)` is an assertion over concrete
  calls, while `ensure(message, () => { assert(...) })` is a self-contained
  synchronous or asynchronous scenario. The engine deterministically emits
  and runs these as `*.ensure.ts`; they never depend on model-authored tests
  to supply inputs or invoke a contract. Natural-language intent belongs in
  `requirements`. The `precondition` keyword is reserved for future input
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
  API — no full self-built parser. There is deliberately **no `chz build`
  step** (doc 20): realize commits plain TS — including a per-module sidecar
  shim (`example.ts` next to `example.chz.ts`) that consumers import as
  `./example` — so the user's existing toolchain (tsc/esbuild/Vite/Metro/
  webpack) consumes the project with zero Cheese plugins; `chz verify`
  re-checks drift hashes, unrealized symbols, and tests without an LLM.
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
  referencing epilogue is an error. CI and the user's own build tooling
  consume this committed directory alone, with no LLM and no bundler plugin;
  outside code reaches it through the sidecar shim (doc 20), never by
  importing `.chz.ts` or realization paths directly. `.chz.ts` stays the
  source of truth; realized code is edited
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
  The current v0 implementation ships `ChzOpenAIRealizer` and accepts custom
  `ChzRealizer` instances through `chz.config.js`; the documented
  `ClaudeCodeRealizer` exception remains planned rather than implemented.
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

## AST-backed parser migration (sketches 260726-00, 260726-01)

The Cheese parser owns only the extension shell — `@profile`, top-level
`imagine function/class`, imagined class members, and the `requirements` /
`ensure` statement boundaries inside a contract body. Everything else
(signatures, type expressions, contract expressions, imports, symbol
resolution) belongs to the TypeScript AST and Checker. Source text is
projected into valid TypeScript with UTF-16 length and line breaks
preserved; the two constructs that would lose their contract AST in that
projection — class-body contract statements and imagined property bodies —
keep an origin-mapped island source alongside it. Stripping `imagine`
declarations becomes an emit step that runs only after every diagnostic is
green, so a syntax error costs zero directory creations and zero LLM calls.

Settled grammar rules: `imagine` stays a contextual keyword, but a
declaration-position `imagine` commits unless the next token can continue an
expression (or a line terminator intervenes) — a blacklist, with no `null`
fallback after commit. A contract body admits only `requirements(...)` and
`ensure(...)` at its top level; scenario callbacks admit ordinary
TypeScript. `requirements` takes exactly one static string.
`export imagine` is valid, `export default` / `declare` / `abstract` are
not. Entrypoint exposure follows the source's own exports, for human symbols
as well as imagine ones, and human relative specifiers are rewritten against
the realization directory. Obligation promotion is decided by the owner of
the symbol a diagnostic points at, never by the diagnostic code alone.

Status: phases 0–1 are done. `src/compiler/` holds the core —
`ts-api.ts` (the only file importing `typescript/unstable/*`), `syntax.ts`,
`parser.ts`, `projection.ts`, `typescript.ts`, `diagnostics.ts`, and
`analyze.ts` behind a single `analyzeChzSource()` entry — with the grammar
fixture corpus in `src/compiler/__fixtures__/` and the spike's findings in
sketch `260726-01`. `extractImagineSpecs()` is now an adapter that rebuilds
the old `ImagineSpec` strings by slicing AST node spans, so consumers still
see the v0 shape while the brace-depth scanner is gone from the parse path.
Still ahead: preflight ordering (nothing written before diagnostics are
green), owner-based obligation promotion, the consumer migration off the
remaining regexes, deleting the legacy preprocessor, and the docs.

## v0 scope

- Syntax: `imagine function/class` + `requirements` + `ensure` + minimal
  wiring statements. Nothing more.
- Pipeline: `.chz` preprocessing (declaration-level) → tsc diagnostics →
  realize (through the configured Realizer; OpenAI-compatible by default) →
  emit TS + vitest tests → on green tests, record the hash in a lockfile.
- First milestone — a single function (`충돌판정_2D`, 2D collision check)
  end-to-end, `.chz` → realize → tests green — is **done**
  (`examples/collision.chz.ts`).
