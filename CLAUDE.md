# CLAUDE.md

## Project: Cheese (`.chz`)

Cheese is a general-purpose programming language designed for vibe coding:
**the LLM writes the implementation, the human supervises.** The human
expresses intent (specs, contracts, oversight); the LLM produces the
implementation. Cheese's core differentiator is that this division of roles is
enforced by the language grammar and the compiler, not left to convention.

**Current status: concept / design-discussion stage. There is no code yet.**

Detailed design discussion lives in `docs/idea-sketches/` (Korean, living
documents). For anything not covered here — open design questions, rationale,
discussion history — read the latest sketch first:
`docs/idea-sketches/260723-00-init.md`. If this file and a sketch disagree,
the sketch is more likely to be current.

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

## v0 scope

- Syntax: `imagine function/class` + `requirements` + `ensure` + minimal
  wiring statements. Nothing more.
- Pipeline: `.chz` preprocessing (declaration-level) → tsc diagnostics →
  realize (via the claude CLI) → emit TS + vitest tests → on green tests,
  record the hash in a lockfile.
- First milestone: a single function (`충돌판정_2D`, 2D collision check)
  end-to-end — `.chz` → realize → tests green.
