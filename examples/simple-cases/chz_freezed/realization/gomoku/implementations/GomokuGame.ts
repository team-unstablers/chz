/// GomokuGame.ts
/// realization of `imagine class GomokuGame`
/// realized by google/gemini-3.6-flash (via chz-realize) on 2026-07-23T21:54:25.178Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

import type { GomokuStone, GomokuPosition } from "./__prologue__.ts";

/**
 * CLI Gomoku Game implementation.
 *
 * Requirements:
 * - 15x15 board, Black (human) vs White (CPU).
 * - Human moves first.
 * - Wins when 5 or more stones of the same color are contiguous horizontally,
 *   vertically, or along either diagonal.
 * - Draw if board fills without a winner.
 * - CPU acts as a challenging tactical opponent following priority rules.
 * - Start & Cleanup handle terminal input, rendering, and SIGINT.
 */
export class GomokuGame {
    private board: (GomokuStone | null)[][];
    private cursorRow: number = 7;
    private cursorCol: number = 7;

    private stdinListener: ((data: Buffer) => void) | null = null;
    private sigintListener: (() => void) | null = null;
    private isRawModeSet: boolean = false;

    constructor() {
        // Initialize a 15x15 empty board grid.
        this.board = Array.from({ length: 15 }, () =>
            Array.from({ length: 15 }, () => null)
        );
    }

    /**
     * Places a stone on the board if coordinates are valid and cell is empty.
     * Returns true on success, false on invalid or occupied cell.
     */
    public placeStone(row: number, column: number, stone: GomokuStone): boolean {
        // ASSUMPTION: Coordinates must be integers in range [0, 14].
        if (!Number.isInteger(row) || !Number.isInteger(column)) {
            return false;
        }
        if (row < 0 || row >= 15 || column < 0 || column >= 15) {
            return false;
        }
        if (this.board[row][column] !== null) {
            return false;
        }

        this.board[row][column] = stone;
        return true;
    }

    /**
     * Returns the stone at (row, column) or null if empty or out of bounds.
     */
    public stoneAt(row: number, column: number): GomokuStone | null {
        if (!Number.isInteger(row) || !Number.isInteger(column)) {
            return null;
        }
        if (row < 0 || row >= 15 || column < 0 || column >= 15) {
            return null;
        }
        return this.board[row][column];
    }

    /**
     * Checks the board for 5 or more contiguous stones of the same color
     * horizontally, vertically, or diagonally.
     * Returns the winning GomokuStone color, or null if no winner.
     */
    public winner(): GomokuStone | null {
        const directions = [
            [0, 1],  // Horizontal
            [1, 0],  // Vertical
            [1, 1],  // Diagonal descending (\)
            [1, -1]  // Diagonal ascending (/)
        ];

        for (let r = 0; r < 15; r++) {
            for (let c = 0; c < 15; c++) {
                const stone = this.board[r][c];
                if (stone === null) continue;

                for (const [dr, dc] of directions) {
                    // Check if (r, c) is the start of a run in direction (dr, dc)
                    const prevR = r - dr;
                    const prevC = c - dc;
                    const prevInBounds = prevR >= 0 && prevR < 15 && prevC >= 0 && prevC < 15;
                    if (prevInBounds && this.board[prevR][prevC] === stone) {
                        // Skip since this cell is in the middle of an already counted run
                        continue;
                    }

                    // Count contiguous stones matching `stone`
                    let count = 0;
                    let currR = r;
                    let currC = c;
                    while (
                        currR >= 0 && currR < 15 &&
                        currC >= 0 && currC < 15 &&
                        this.board[currR][currC] === stone
                    ) {
                        count++;
                        currR += dr;
                        currC += dc;
                    }

                    if (count >= 5) {
                        return stone;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Chooses a move for the CPU ("white") without modifying the board.
     * Evaluates moves based on tactical priorities:
     * 1. Immediate White win
     * 2. Immediate Black win block
     * 3. White fork creation (2+ immediate win spots)
     * 4. Black fork prevention
     * 5. Line and positional scoring
     */
    public chooseCpuMove(): GomokuPosition | null {
        if (this.winner() !== null) {
            return null;
        }

        const emptyCells: GomokuPosition[] = [];
        let occupiedCount = 0;

        for (let r = 0; r < 15; r++) {
            for (let c = 0; c < 15; c++) {
                if (this.board[r][c] === null) {
                    emptyCells.push({ row: r, column: c });
                } else {
                    occupiedCount++;
                }
            }
        }

        if (emptyCells.length === 0) {
            return null;
        }

        // Helper to count how many immediate wins `stone` gets if placed on remaining empty cells
        const countImmediateWins = (stone: GomokuStone): number => {
            let winCount = 0;
            for (const cell of emptyCells) {
                if (this.board[cell.row][cell.column] !== null) continue;
                this.board[cell.row][cell.column] = stone;
                if (this.winner() === stone) {
                    winCount++;
                }
                this.board[cell.row][cell.column] = null;
            }
            return winCount;
        };

        // Score candidates
        let bestCandidate: GomokuPosition | null = null;
        let bestScore = -Infinity;
        let bestDist = Infinity;

        for (const cell of emptyCells) {
            const r = cell.row;
            const c = cell.column;
            let candidateScore = 0;

            // Priority 1: White immediate win
            this.board[r][c] = "white";
            const whiteWins = this.winner() === "white";
            this.board[r][c] = null;

            if (whiteWins) {
                candidateScore = 1_000_000_000;
            } else {
                // Priority 2: Black immediate win block
                this.board[r][c] = "black";
                const blackWins = this.winner() === "black";
                this.board[r][c] = null;

                if (blackWins) {
                    candidateScore = 500_000_000;
                } else {
                    // Priority 3: White fork creation (creating >= 2 immediate winning cells)
                    this.board[r][c] = "white";
                    const whiteWinSpots = countImmediateWins("white");
                    this.board[r][c] = null;

                    if (whiteWinSpots >= 2) {
                        candidateScore = 100_000_000 + whiteWinSpots * 10_000;
                    } else {
                        // Priority 4: Prevent Black fork (if Black played here, Black would get >= 2 immediate winning cells)
                        this.board[r][c] = "black";
                        const blackWinSpots = countImmediateWins("black");
                        this.board[r][c] = null;

                        if (blackWinSpots >= 2) {
                            candidateScore = 50_000_000 + blackWinSpots * 10_000;
                        } else {
                            // Priority 5: Positional / Line evaluation
                            const blackPattern = this.evaluatePattern(r, c, "black");
                            const whitePattern = this.evaluatePattern(r, c, "white");

                            // ASSUMPTION: Defensive weighting for Black threats is 1.2x vs White progress 1.0x to satisfy requirement that defensive scores are >= offensive scores.
                            candidateScore = 1.2 * blackPattern + 1.0 * whitePattern;

                            // Small bonus for proximity to existing stones
                            const neighbors = this.countNeighborStones(r, c);
                            candidateScore += neighbors * 20;
                        }
                    }
                }
            }

            // Distance from center (7, 7)
            const distToCenter = Math.abs(r - 7) + Math.abs(c - 7);

            // Compare with current best
            let isBetter = false;
            if (candidateScore > bestScore) {
                isBetter = true;
            } else if (candidateScore === bestScore) {
                // Stable tie-break: distance from center (closer is better), then row, then column
                if (distToCenter < bestDist) {
                    isBetter = true;
                } else if (distToCenter === bestDist && bestCandidate !== null) {
                    if (r < bestCandidate.row) {
                        isBetter = true;
                    } else if (r === bestCandidate.row && c < bestCandidate.column) {
                        isBetter = true;
                    }
                }
            }

            if (isBetter || bestCandidate === null) {
                bestScore = candidateScore;
                bestDist = distToCenter;
                bestCandidate = cell;
            }
        }

        return bestCandidate;
    }

    /**
     * Evaluates positional line patterns for `stone` if placed at `(r, c)`.
     */
    private evaluatePattern(r: number, c: number, stone: GomokuStone): number {
        const directions = [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1]
        ];

        let totalPatternScore = 0;

        // Temporarily place stone
        this.board[r][c] = stone;

        for (const [dr, dc] of directions) {
            // Check contiguous line length and open ends
            let forwardSteps = 0;
            while (true) {
                const nextR = r + (forwardSteps + 1) * dr;
                const nextC = c + (forwardSteps + 1) * dc;
                if (nextR >= 0 && nextR < 15 && nextC >= 0 && nextC < 15 && this.board[nextR][nextC] === stone) {
                    forwardSteps++;
                } else {
                    break;
                }
            }

            let backwardSteps = 0;
            while (true) {
                const prevR = r - (backwardSteps + 1) * dr;
                const prevC = c - (backwardSteps + 1) * dc;
                if (prevR >= 0 && prevR < 15 && prevC >= 0 && prevC < 15 && this.board[prevR][prevC] === stone) {
                    backwardSteps++;
                } else {
                    break;
                }
            }

            const length = 1 + forwardSteps + backwardSteps;

            const fEndR = r + (forwardSteps + 1) * dr;
            const fEndC = c + (forwardSteps + 1) * dc;
            const fOpen = fEndR >= 0 && fEndR < 15 && fEndC >= 0 && fEndC < 15 && this.board[fEndR][fEndC] === null;

            const bEndR = r - (backwardSteps + 1) * dr;
            const bEndC = c - (backwardSteps + 1) * dc;
            const bOpen = bEndR >= 0 && bEndR < 15 && bEndC >= 0 && bEndC < 15 && this.board[bEndR][bEndC] === null;

            const openEnds = (fOpen ? 1 : 0) + (bOpen ? 1 : 0);

            if (length >= 5) {
                totalPatternScore += 10_000_000;
            } else if (length === 4) {
                if (openEnds === 2) {
                    totalPatternScore += 5_000_000; // Open 4
                } else if (openEnds === 1) {
                    totalPatternScore += 500_000; // Half-open 4
                }
            } else if (length === 3) {
                if (openEnds === 2) {
                    totalPatternScore += 100_000; // Open 3
                } else if (openEnds === 1) {
                    totalPatternScore += 10_000; // Half-open 3
                }
            } else if (length === 2) {
                if (openEnds === 2) {
                    totalPatternScore += 1_000; // Open 2
                } else if (openEnds === 1) {
                    totalPatternScore += 100;
                }
            }

            // Also check 5-cell window potential for broken patterns
            for (let offset = -4; offset <= 0; offset++) {
                let validWindow = true;
                let stoneCount = 0;
                let opponentCount = 0;

                for (let i = 0; i < 5; i++) {
                    const wr = r + (offset + i) * dr;
                    const wc = c + (offset + i) * dc;
                    if (wr < 0 || wr >= 15 || wc < 0 || wc >= 15) {
                        validWindow = false;
                        break;
                    }
                    const cellStone = this.board[wr][wc];
                    if (cellStone === stone) {
                        stoneCount++;
                    } else if (cellStone !== null) {
                        opponentCount++;
                    }
                }

                if (validWindow && opponentCount === 0) {
                    totalPatternScore += Math.pow(10, stoneCount);
                }
            }
        }

        // Revert temporary placement
        this.board[r][c] = null;

        return totalPatternScore;
    }

    /**
     * Counts how many non-null stones exist within Manhattan distance <= 2.
     */
    private countNeighborStones(r: number, c: number): number {
        let count = 0;
        for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < 15 && nc >= 0 && nc < 15 && this.board[nr][nc] !== null) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Renders current board state and status to process.stdout.
     */
    private printBoard(statusText: string): void {
        let out = "\n=== Gomoku CLI ===\n";
        out += "   " + Array.from({ length: 15 }, (_, i) => (i % 10).toString()).join(" ") + "\n";

        for (let r = 0; r < 15; r++) {
            out += (r < 10 ? " " + r : `${r}`) + " ";
            for (let c = 0; c < 15; c++) {
                const stone = this.board[r][c];
                const isCursor = r === this.cursorRow && c === this.cursorCol;

                let char = ".";
                if (stone === "black") char = "X";
                else if (stone === "white") char = "O";

                if (isCursor) {
                    out += `[${char}]`;
                } else {
                    out += ` ${char} `;
                }
            }
            out += "\n";
        }
        out += `Status: ${statusText}\n`;
        process.stdout.write(out);
    }

    /**
     * Starts the interactive Gomoku CLI game loop.
     */
    public async start(): Promise<void> {
        return new Promise<void>((resolve) => {
            let gameEnded = false;

            const finishGame = async () => {
                if (gameEnded) return;
                gameEnded = true;
                await this.cleanup();
                resolve();
            };

            // Setup SIGINT handler
            this.sigintListener = () => {
                process.stdout.write("Coward!\n");
                void finishGame();
            };
            process.on("SIGINT", this.sigintListener);

            // Configure stdin raw mode
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
                process.stdin.setRawMode(true);
                this.isRawModeSet = true;
            }
            process.stdin.resume();

            this.printBoard("Your turn (Black X). Use ←↓↑→ to move, Enter to place stone.");

            this.stdinListener = (data: Buffer) => {
                if (gameEnded) return;

                const input = data.toString("utf-8");

                // Check for Ctrl+C
                if (input === "\x03") {
                    if (this.sigintListener) {
                        this.sigintListener();
                    }
                    return;
                }

                // Parse arrow keys and Enter
                if (input === "\x1b[A") {
                    // Up
                    this.cursorRow = Math.max(0, this.cursorRow - 1);
                    this.printBoard("Moved UP");
                } else if (input === "\x1b[B") {
                    // Down
                    this.cursorRow = Math.min(14, this.cursorRow + 1);
                    this.printBoard("Moved DOWN");
                } else if (input === "\x1b[C") {
                    // Right
                    this.cursorCol = Math.min(14, this.cursorCol + 1);
                    this.printBoard("Moved RIGHT");
                } else if (input === "\x1b[D") {
                    // Left
                    this.cursorCol = Math.max(0, this.cursorCol - 1);
                    this.printBoard("Moved LEFT");
                } else if (input === "\r" || input === "\n") {
                    // Place Black stone
                    const placed = this.placeStone(this.cursorRow, this.cursorCol, "black");
                    if (!placed) {
                        this.printBoard("Invalid move! Cell is occupied or out of bounds.");
                        return;
                    }

                    // Check human win
                    if (this.winner() === "black") {
                        this.printBoard("Black wins!");
                        void finishGame();
                        return;
                    }

                    // Check draw
                    const isBoardFull = this.board.every((row) => row.every((cell) => cell !== null));
                    if (isBoardFull) {
                        this.printBoard("Game is a Draw!");
                        void finishGame();
                        return;
                    }

                    // CPU turn
                    const cpuMove = this.chooseCpuMove();
                    if (cpuMove !== null) {
                        this.placeStone(cpuMove.row, cpuMove.column, "white");

                        if (this.winner() === "white") {
                            this.printBoard(`CPU played at (${cpuMove.row}, ${cpuMove.column}). White wins!`);
                            void finishGame();
                            return;
                        }

                        const boardFullAfterCpu = this.board.every((row) => row.every((cell) => cell !== null));
                        if (boardFullAfterCpu) {
                            this.printBoard("Game is a Draw!");
                            void finishGame();
                            return;
                        }

                        this.printBoard(`CPU played at (${cpuMove.row}, ${cpuMove.column}). Your turn.`);
                    } else {
                        // CPU could not move
                        if (this.winner() !== null) {
                            this.printBoard(`Winner: ${this.winner()}`);
                        } else {
                            this.printBoard("Draw!");
                        }
                        void finishGame();
                    }
                }
            };

            process.stdin.on("data", this.stdinListener);
        });
    }

    /**
     * Cleans up listeners and restores terminal state.
     */
    public async cleanup(): Promise<void> {
        if (this.stdinListener) {
            process.stdin.removeListener("data", this.stdinListener);
            this.stdinListener = null;
        }

        if (this.sigintListener) {
            process.removeListener("SIGINT", this.sigintListener);
            this.sigintListener = null;
        }

        if (this.isRawModeSet && process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
            try {
                process.stdin.setRawMode(false);
            } catch {
                // Ignore potential stream errors on exit
            }
            this.isRawModeSet = false;
        }

        try {
            process.stdin.pause();
        } catch {
            // Ignore potential errors
        }
    }
}

/// END OF AUTO-GENERATED CODE
