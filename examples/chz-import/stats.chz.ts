/// stats.chz.ts
// The foundation module for the cross-file import example: combat stats and critical hits.
//
// Symbols exported from this file are imported by other files through the shim
// (`stats.ts`) that `chz realize` generates next to the source (doc 20).
// Human-authored types and functions, as well as imagine symbols, are all
// exposed unchanged through the shim.

/** The stats of a character participating in combat. */
export interface CombatStats {
  attack: number;
  defense: number;
  /** Luck ranges from 0 to 100 and affects critical-hit probability. */
  luck: number;
}

/** Return unmodified base stats. This function is written directly by a human. */
export function baseStats(): CombatStats {
  return { attack: 10, defense: 5, luck: 0 };
}

export imagine function isCriticalHit(attacker: CombatStats): boolean {
  requirements(`
    # Determine whether this attack is a critical hit based on the attacker's stats.
    - Critical-hit probability must increase as attacker.luck (0–100) increases.
    - A critical hit never occurs when luck is 0.
    - A critical hit always occurs when luck is 100.
  `);

  ensure(
    typeof isCriticalHit({ attack: 10, defense: 5, luck: 50 }) === "boolean",
    "Critical-hit detection returns a boolean.",
  );

  ensure("Luck 0 never produces a critical hit, while luck 100 always does.", () => {
    assert(isCriticalHit({ attack: 10, defense: 5, luck: 0 }) === false);
    assert(isCriticalHit({ attack: 10, defense: 5, luck: 100 }) === true);
  });
}
