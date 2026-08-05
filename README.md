# Cheese (`.chz`)

**A TypeScript superset where the LLM writes the implementation and the human
supervises.**

Cheese is a general-purpose programming language for vibe coding. Humans own
the intent: types, signatures, requirements, and executable acceptance
contracts. An LLM produces the implementation. Cheese makes that division of
responsibility part of the language and its tooling instead of leaving it as a
prompting convention.

> **Project status:** Cheese is an early v0 prototype. The first end-to-end
> example works, but the language and generated layout are still evolving. It
> is not ready for production use.

## What Cheese looks like

Most TypeScript is already valid Cheese. The language adds declaration-level
constructs such as `imagine`, `requirements`, and `ensure`:

```typescript chz
/// greeting.chz.ts
export imagine function greetLikePirate(name: string): string {
  requirements(`
    Greet the person like a friendly pirate.
    The greeting must start with "Ahoy, ".
  `);

  ensure(
    greetLikePirate("Cheese") === "Ahoy, Cheese!",
    "The name must appear in the greeting.",
  );

  ensure("Every greeting follows the public contract.", () => {
    const greeting = greetLikePirate("Ren");

    assert(greeting.startsWith("Ahoy, "));
    assert(greeting.includes("Ren"));
  });
}
```

There is deliberately no implementation body for the human to fill in:

- `imagine` marks a symbol that an LLM must implement.
- `requirements` describes intent and constraints in natural language.
- `ensure(condition, message?)` records a concrete executable contract.
- `ensure(message, () => { ... })` records a multi-step synchronous or
  asynchronous scenario.

The contracts are emitted as deterministic `*.ensure.ts` tests. They do not
depend on model-authored tests to choose inputs or invoke the symbol.

## How realization works

Run `chz realize` during development:

```shell
chz realize greeting.chz.ts
```

Cheese then:

1. extracts the human-authored symbol specifications and contracts;
2. builds a symbol-level dependency graph;
3. asks a configured Realizer to implement each symbol in dependency order;
4. runs type checks and tests independently of the Realizer's own completion
   claim; and
5. writes auditable TypeScript, tests, and cache metadata under
   `chz/realization/`.

Human-written code is preserved alongside the generated implementation. Code
that can load before realized symbols is emitted as `__prologue__.ts`; code
that uses realized symbols is emitted as `__epilogue__.ts`.

```text
chz/realization/greeting/
├── realization-cache.json
├── implementation.ts
├── implementations/
│   ├── __prologue__.ts
│   ├── greetLikePirate.ts
│   └── __epilogue__.ts
└── tests/
    ├── test_greetLikePirate.ensure.ts
    └── test_greetLikePirate.autogen.ts
```

Realized artifacts are meant to be reviewed and committed. Builds and CI use
ordinary committed TypeScript and do not call an LLM. The long-term module
design uses a generated sidecar file next to each `.chz.ts` source, allowing
existing tools such as `tsc`, esbuild, Vite, Metro, and webpack to consume the
result without a Cheese-specific build step or plugin.

## Try the prototype

The repository currently runs directly from TypeScript source. Install the
development dependencies and check the project:

```shell
npm install
npm test
npm run typecheck
npm run chz -- --help
```

Without a `chz.config.js`, the built-in OpenAI-compatible Realizer reads:

```shell
export OPENAI_MODEL="<model>"
export OPENAI_API_KEY="<api-key>"
# Optional for another OpenAI-compatible endpoint:
export OPENAI_BASE_URL="https://example.com/v1"

npm run chz -- realize path/to/example.chz.ts
```

You can inspect parsing or prompts without starting a model-backed realization:

```shell
npm run chz -- realize path/to/example.chz.ts --json
npm run chz -- realize path/to/example.chz.ts --dry-run
```

For project-wide runs, configure Realizers and source globs:

```javascript
/// chz.config.js
import { ChzOpenAIRealizer, defineConfig } from "chz";

export default defineConfig({
  include: ["src/**/*.chz.ts"],
  jobs: 4,
  realizers: [
    new ChzOpenAIRealizer({
      model: process.env.OPENAI_MODEL,
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
  ],
});
```

Then omit the file argument:

```shell
npm run chz -- realize
```

The first configured Realizer that supports a symbol type is selected.
`chz.config.js` can also set limits for turns, retries, cycle size, and the
active profile.

## Why not just ask an LLM to write the whole program?

Cheese is designed around a durable ownership boundary:

| Human-owned | LLM-owned |
| --- | --- |
| Intent and requirements | Implementations |
| Public types and signatures | Implementation-focused typedefs |
| Executable acceptance contracts | Additional unit tests |
| Review and approval | Explicitly documented assumptions |

The Realizer operates through a fixed tool surface rather than an unrestricted
shell. Filesystem boundaries, read-before-write checks, turn limits, output
limits, and independent verification are enforced by the harness. When the
specification leaves a meaningful product decision open, the Realizer can ask
the human; answers are recorded in `CONTEXTS.md` and become part of subsequent
realization context and cache invalidation.

Standing project rules go in `CHZPROJECT.md`, the Cheese counterpart of a
`CLAUDE.md` — a symlink to one works. Each session picks up the nearest such
file at or above its source directory and quotes it into the prompt inside a
tag whose closing sequence is defused, so file content cannot impersonate the
sections the engine writes around it. It is guidance only: it cannot lift a
harness boundary or widen the active profile. Editing it does not invalidate
symbols that are already realized.

Generated code is optimized for auditability as well as correctness. Ambiguous
decisions must be marked with `ASSUMPTION:` comments so reviewers can find the
places where the implementation interpreted underspecified intent.

## Incremental realization

The current graph engine realizes dependencies before their dependents and
groups manageable cycles into a single session. Independent graph groups can
run concurrently with `chz realize -j N`.

Successful symbols are recorded in `realization-cache.json`. On later runs:

- unchanged green symbols are reused;
- public-surface changes invalidate dependents;
- internal-only changes rerun dependent tests without immediately calling an
  LLM;
- edited or drifted artifacts fall back to realization; and
- changes to human layers or `CONTEXTS.md` trigger the corresponding safety
  checks.

When nothing changed but the result is simply not good enough, `chz realize
--reroll` asks for another attempt at the same contract; `--reroll=<a,b>`
limits it to named symbols. It suppresses cache reuse and nothing else, so
dependents fall under the unchanged-surface rule above and only re-run their
tests. The previous artifact is overwritten — realized code is committed, so
git already holds it.

## Current scope and roadmap

The implemented v0 focuses on:

- `imagine function` and `imagine class`;
- natural-language `requirements`;
- executable `ensure` contracts;
- OpenAI-compatible and custom Realizers;
- a constrained agentic harness with independent verification;
- per-symbol dependency ordering, bounded cycles, caching, and parallel jobs;
  and
- prologue/implementation/epilogue emission.

The broader design also covers usage-created contracts, `required` members,
generative `imagine resource` assets, capability-oriented `@profile`
declarations, sidecar module shims, `chz verify`, override preservation, and a
cross-file dependency graph. These areas are planned or only partially
implemented in the current prototype.

## Documentation

- [Introduction and language tour](docs/00-chz-intro.md)
- [Module resolution and the no-build principle](docs/20-module-resolution.ko.md)
- [Realization output and overrides](docs/60-realize-intro.ko.md)
- [Realizer architecture](docs/61-realize-realizer.ko.md)
- [Symbol dependency graph](docs/62-realize-dependency-graph.ko.md)
- [Harness rules and tool specification](docs/63-realize-harness-rules.ko.md)
- [Canonical harness prompt](docs/64-realize-harness-prompt.ko.md)
- [Design sketches and discussion history](docs/idea-sketches/)

The numbered specifications are living design documents. Korean specifications
are currently canonical; when code and documentation disagree, the
documentation is more likely to reflect the latest design decision.

See [`examples/`](examples/) for the collision-detection milestone, small
self-contained cases, symbol dependencies, and cross-file design examples.
