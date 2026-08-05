/// main.ts
// An example of a plain TypeScript file consuming Cheese modules — it contains
// no Cheese syntax at all.
//
// The import paths point at the shims (`./stats`, `./battle`) that realize
// generates and commits, not at the sources (.chz.ts). A shim is an ordinary
// committed .ts file, so this file resolves under standard module-resolution
// rules in any toolchain, with no bundler plugin and no Cheese-specific build
// step (doc 20).
//
// Note that if the project has never been realized, the shims do not exist yet
// and the imports below are type errors. That is a documented gap (see the NOTE
// in doc 20).

import { baseStats, type CombatStats } from "./stats";
import { calculateDamage } from "./battle";

const attacker: CombatStats = { ...baseStats(), attack: 12, luck: 80 };
const defender: CombatStats = baseStats();

const damage = calculateDamage(attacker, defender);
console.log(`Damage dealt by this attack: ${damage}`);
