export type GomokuStone = "black" | "white";

export interface GomokuPosition {
    readonly row: number;
    readonly column: number;
}

imagine class GomokuGame {
    requirements(`
        # CLI Gomoku Game

        - Build a CLI Gomoku game where a human plays against the CPU on a 15×15 board.
        - The human plays black and moves first; the CPU plays white.
        - A player wins when five or more stones of the same color are contiguous
          horizontally, vertically, or along either diagonal. Apply the same rule
          to black and white, with no forbidden-move restrictions such as
          double-three or double-four.
        - The game is a draw if the board fills without a winner.

        - On the human's turn, use the ←↓↑→ keys to move a cursor within the board,
          and Enter to place a black stone on an empty cell. A stone cannot be placed
          on an occupied cell or outside the board.
        - After each move, print the board and current status. Once a win or draw is
          confirmed, print the result and stop processing input.

        - If SIGINT terminates the game, print exactly 'Coward!' and then call cleanup().
        - Use process.stdin and process.stdout directly. Do not use external terminal modules.
        - start() must run the game using placeStone(), stoneAt(), winner(), and
          chooseCpuMove() below. Do not create separate board state or duplicate
          winner-detection logic.
    `);

    imagine placeStone(row: number, column: number, stone: GomokuStone): boolean {
        requirements(`
            If the specified cell is empty and within the board, place the stone and
            return true. Rows and columns are integers from 0 through 14. For an
            out-of-range or non-integer coordinate, or an occupied cell, make no
            changes and return false.
        `);

        ensure("Stones can be placed only on valid, empty cells.", () => {
            const game = new GomokuGame();

            assert(game.placeStone(0, 0, "black") === true);
            assert(game.placeStone(0, 0, "white") === false);
            assert(game.placeStone(-1, 0, "white") === false);
            assert(game.placeStone(15, 0, "white") === false);
            assert(game.placeStone(0, 1.5, "white") === false);
            assert(game.stoneAt(0, 0) === "black");
        });
    }

    imagine stoneAt(row: number, column: number): GomokuStone | null {
        requirements(`
            Return the stone in the specified cell. Return null if the cell is empty
            or the coordinate is outside the board. Do not modify board state.
        `);

        ensure("Empty and occupied cells can be queried.", () => {
            const game = new GomokuGame();

            assert(game.stoneAt(7, 7) === null);
            assert(game.placeStone(7, 7, "white") === true);
            assert(game.stoneAt(7, 7) === "white");
            assert(game.stoneAt(15, 7) === null);
        });
    }

    imagine winner(): GomokuStone | null {
        requirements(`
            Return the color with five or more contiguous stones horizontally,
            vertically, or along either diagonal on the current board. Return null
            if there is no winner. Do not modify board state.
        `);

        ensure("A run of only four stones does not win.", () => {
            const game = new GomokuGame();

            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(4, column, "black"));
            }

            assert(game.winner() === null);
        });

        ensure("Five or more stones win, including horizontal and vertical overlines.", () => {
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
        });

        ensure("Wins along both diagonal directions are detected.", () => {
            const descending = new GomokuGame();
            const ascending = new GomokuGame();

            for (let index = 0; index < 5; index += 1) {
                assert(descending.placeStone(index + 2, index + 3, "black"));
                assert(ascending.placeStone(index + 6, 10 - index, "white"));
            }

            assert(descending.winner() === "black");
            assert(ascending.winner() === "white");
        });
    }

    imagine chooseCpuMove(): GomokuPosition | null {
        requirements(`
            Select a cell for the CPU without modifying the current board. Return null
            if a winner already exists or there are no empty cells.

            If white can win in one move, prioritize one such empty cell. Otherwise,
            if black can win on its next move, block one of those winning cells.
            If neither case applies, select any empty cell within the board.
        `);

        ensure("A regular CPU move is an empty in-bounds cell and does not change the board.", () => {
            const game = new GomokuGame();
            const move = game.chooseCpuMove();

            assert(move !== null);
            assert(Number.isInteger(move.row) && move.row >= 0 && move.row < 15);
            assert(Number.isInteger(move.column) && move.column >= 0 && move.column < 15);
            assert(game.stoneAt(move.row, move.column) === null);
        });

        ensure("The CPU selects a move that wins immediately when one exists.", () => {
            const game = new GomokuGame();
            assert(game.placeStone(7, 2, "black"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(7, column, "white"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 7 && move.column === 7);
            assert(game.stoneAt(7, 7) === null);
        });

        ensure("Without an immediate win, the CPU blocks the human's next-move win.", () => {
            const game = new GomokuGame();
            assert(game.placeStone(8, 2, "white"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(8, column, "black"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 8 && move.column === 7);
            assert(game.stoneAt(8, 7) === null);
        });
    }

    imagine async start(): Promise<void> {
        requirements(`
            Configure the terminal for game mode and start the game loop. Delegate
            human input, CPU moves, and win and draw detection to the class's testable
            methods. When start() ends, call cleanup() regardless of success, error,
            or SIGINT.
        `);
    }

    imagine async cleanup(): Promise<void> {
        requirements(`
            Remove registered stdin and SIGINT event listeners, disable stdin raw mode,
            and restore the original terminal state. It must be safe to call repeatedly.
        `);
    }
}

(async () => {
    const game = new GomokuGame();
    await game.start();
})();
