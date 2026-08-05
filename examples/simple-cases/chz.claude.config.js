// Realize these examples through Claude Code instead of an OpenAI-compatible
// endpoint. Select it with `--config chz.claude.config.js`; the default
// `chz.config.js` next to this file keeps using ChzOpenAIRealizer.
//
// No API key is involved: ClaudeCodeRealizer drives the Claude Code the user is
// already signed in to. A run therefore spends that account's usage.
//
// Requires the optional peer dependencies. Without them the first symbol ends
// as `blocked` and prints the install command to run.

import { ClaudeCodeRealizer, defineConfig } from "chz";

export default defineConfig({
  realizers: [
    new ClaudeCodeRealizer({
      // Alias (`opus`, `sonnet`, `haiku`) or a full model id. Also recorded as
      // the `realized by ...` provenance line on every emitted artifact.
      model: "sonnet",

      // Thinking budget: low | medium | high | xhigh | max.
      effort: "high",

      // Hard ceiling per realize session. Reaching it ends that symbol as
      // `blocked` with a todo rather than failing it, because raising the cap
      // resumes the run without touching the .chz.ts source.
      maxBudgetUsd: 1.5,

      // Drive a specific Claude Code build instead of the one the SDK bundles.
      // claudePath: "/Users/me/.local/bin/claude",

      // Merged over process.env for the Claude Code subprocess.
      // env: { ANTHROPIC_LOG: "debug" },

      // Passed straight through to Claude Code, for flags with no first-class
      // option here.
      // extraArgs: ["--fallback-model", "haiku"],
    }),
  ],

  // Realize sessions to run concurrently. AskUser prompts are serialized FIFO
  // across them, so a question from one session never interleaves with another.
  jobs: 1,

  // Extra globs the harness may neither read nor write, on top of the built-in
  // secrets list (.env*, chz.config.js, .git/, keys). Add-only: a leading '!'
  // is a load error, because re-opening chz.config.js would leak an API key.
  // blockedPaths: ["infra/**", "*.snapshot.json"],
});
