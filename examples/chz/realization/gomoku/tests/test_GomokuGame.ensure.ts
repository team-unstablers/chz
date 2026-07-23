/// test_GomokuGame.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from gomoku.chz.ts.

import { GomokuGame } from "../implementations/GomokuGame.ts";
import type { GomokuPosition, GomokuStone } from "../implementations/__prologue__.ts";

declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

it("유효한 빈 칸에만 돌을 놓을 수 있습니다.", async () => {
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
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:37:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:37:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:37:9: " + detail);
  }
});

it("빈 칸과 착수된 칸의 상태를 조회할 수 있습니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();

            assert(game.stoneAt(7, 7) === null);
            assert(game.placeStone(7, 7, "white") === true);
            assert(game.stoneAt(7, 7) === "white");
            assert(game.stoneAt(15, 7) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:55:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:55:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:55:9: " + detail);
  }
});

it("연속된 돌 네 개만으로는 승리하지 않습니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();

            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(4, column, "black"));
            }

            assert(game.winner() === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:71:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:71:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:71:9: " + detail);
  }
});

it("가로와 세로의 장목을 포함해 다섯 개 이상이면 승리합니다.", async () => {
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
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:81:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:81:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:81:9: " + detail);
  }
});

it("두 방향의 대각선 승리를 모두 판정합니다.", async () => {
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
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:96:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:96:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:96:9: " + detail);
  }
});

it("CPU가 반환한 일반 수는 보드 안의 빈 칸이며 보드를 변경하지 않습니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
            const game = new GomokuGame();
            const move = game.chooseCpuMove();

            assert(move !== null);
            assert(Number.isInteger(move.row) && move.row >= 0 && move.row < 15);
            assert(Number.isInteger(move.column) && move.column >= 0 && move.column < 15);
            assert(game.stoneAt(move.row, move.column) === null);
        };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:120:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:120:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:120:9: " + detail);
  }
});

it("CPU는 한 수로 이길 수 있으면 그 수를 선택합니다.", async () => {
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
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:130:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:130:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:130:9: " + detail);
  }
});

it("즉시 이길 수 없다면 사람의 다음 수 승리를 막습니다.", async () => {
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
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:142:9 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:142:9");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/gomoku.chz.ts:142:9: " + detail);
  }
});
