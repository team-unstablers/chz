/// test_GomokuGame.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from gomoku.chz.ts.

import { GomokuGame } from "../implementations/GomokuGame.ts";
import type { GomokuPosition, GomokuStone } from "../implementations/__prologue__.ts";

declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

it("Stones can be placed only on valid, empty cells.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();

            assert(game.placeStone(0, 0, "black") === true);
            assert(game.placeStone(0, 0, "white") === false);
            assert(game.placeStone(-1, 0, "white") === false);
            assert(game.placeStone(15, 0, "white") === false);
            assert(game.placeStone(0, 1.5, "white") === false);
            assert(game.stoneAt(0, 0) === "black");
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.placeStone › ensure #1) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.placeStone › ensure #1)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.placeStone › ensure #1): " + detail);
  }
});

it("Empty and occupied cells can be queried.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();

            assert(game.stoneAt(7, 7) === null);
            assert(game.placeStone(7, 7, "white") === true);
            assert(game.stoneAt(7, 7) === "white");
            assert(game.stoneAt(15, 7) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.stoneAt › ensure #2) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.stoneAt › ensure #2)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.stoneAt › ensure #2): " + detail);
  }
});

it("A run of only four stones does not win.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();

            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(4, column, "black"));
            }

            assert(game.winner() === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.winner › ensure #3) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.winner › ensure #3)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.winner › ensure #3): " + detail);
  }
});

it("Five or more stones win, including horizontal and vertical overlines.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const horizontal = new GomokuGame();
            const vertical = new GomokuGame();

            for (let index = 0; index < 5; index += 1) {
                assert(horizontal.placeStone(5, index + 2, "black"));
            }
            for (let index = 0; index < 6; index += 1) {
                assert(vertical.placeStone(index + 4, 9, "white"));
            }

            assert(horizontal.winner() === "black");
            assert(vertical.winner() === "white");
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.winner › ensure #4) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.winner › ensure #4)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.winner › ensure #4): " + detail);
  }
});

it("Wins along both diagonal directions are detected.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const descending = new GomokuGame();
            const ascending = new GomokuGame();

            for (let index = 0; index < 5; index += 1) {
                assert(descending.placeStone(index + 2, index + 3, "black"));
                assert(ascending.placeStone(index + 6, 10 - index, "white"));
            }

            assert(descending.winner() === "black");
            assert(ascending.winner() === "white");
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.winner › ensure #5) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.winner › ensure #5)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.winner › ensure #5): " + detail);
  }
});

it("A regular CPU move is an empty in-bounds cell and does not change the board.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            const move = game.chooseCpuMove();

            assert(move !== null);
            assert(Number.isInteger(move.row) && move.row >= 0 && move.row < 15);
            assert(Number.isInteger(move.column) && move.column >= 0 && move.column < 15);
            assert(game.stoneAt(move.row, move.column) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #6) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #6)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #6): " + detail);
  }
});

it("The CPU selects a move that wins immediately when one exists.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            assert(game.placeStone(7, 2, "black"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(7, column, "white"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 7 && move.column === 7);
            assert(game.stoneAt(7, 7) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #7) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #7)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #7): " + detail);
  }
});

it("Without an immediate win, the CPU blocks the human's next-move win.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            assert(game.placeStone(8, 2, "white"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(8, column, "black"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 8 && move.column === 7);
            assert(game.stoneAt(8, 7) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #8) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #8)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #8): " + detail);
  }
});

it("The CPU proactively interrupts an open three before it becomes an immediate win.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            for (let column = 6; column <= 8; column += 1) {
                assert(game.placeStone(7, column, "black"));
            }

            const move = game.chooseCpuMove();
            const blocksLeftEnd = move?.row === 7 && move.column === 5;
            const blocksRightEnd = move?.row === 7 && move.column === 9;

            assert(blocksLeftEnd || blocksRightEnd);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #9) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #9)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #9): " + detail);
  }
});

it("The CPU prevents a move that would create intersecting open-three threats.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            assert(game.placeStone(7, 5, "black"));
            assert(game.placeStone(7, 6, "black"));
            assert(game.placeStone(5, 7, "black"));
            assert(game.placeStone(6, 7, "black"));

            const move = game.chooseCpuMove();

            assert(move?.row === 7 && move.column === 7);
            assert(game.stoneAt(7, 7) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #10) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #10)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #10): " + detail);
  }
});

it("With no urgent defense, the CPU extends its own open three.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            for (let column = 6; column <= 8; column += 1) {
                assert(game.placeStone(6, column, "white"));
            }

            const move = game.chooseCpuMove();
            const extendsLeftEnd = move?.row === 6 && move.column === 5;
            const extendsRightEnd = move?.row === 6 && move.column === 9;

            assert(extendsLeftEnd || extendsRightEnd);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #11) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #11)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (gomoku.chz.ts › GomokuGame.chooseCpuMove › ensure #11): " + detail);
  }
});
