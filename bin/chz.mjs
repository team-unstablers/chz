#!/usr/bin/env node
// Bin entrypoint: registers tsx so src/cli.ts (TypeScript with non-erasable
// syntax) can run on Node without a build step.
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/cli.ts");
await main();
