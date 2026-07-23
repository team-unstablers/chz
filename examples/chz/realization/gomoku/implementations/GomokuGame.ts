/// GomokuGame.ts
/// realization of `imagine class GomokuGame`
/// realized by x-ai/grok-4.5 (via chz-realize) on 2026-07-23T08:50:33.618Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

import type { GomokuPosition, GomokuStone } from "./__prologue__.ts";

/** Board edge length for standard freestyle gomoku. */
const BOARD_SIZE = 15;

/** Stones needed in a straight line to win (overlines also count). */
const WIN_LENGTH = 5;

/**
 * Four ray axes used for win detection.
 * Each entry is one direction; we only start counting from the "head" of a run
 * (no same-stone neighbor in the opposite direction) so each line is scored once.
 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [0, 1], // horizontal
    [1, 0], // vertical
    [1, 1], // descending diagonal (row+ col+)
    [1, -1], // ascending diagonal (row+ col-)
];

/**
 * CLI freestyle gomoku: human (black) vs CPU (white) on a 15×15 board.
 *
 * Board state and win/CPU logic live only in the public testable methods.
 * `start()` drives I/O and delegates placement / judgment to those methods.
 */
export class GomokuGame {
    /**
     * Flat row-major board: index = row * BOARD_SIZE + column.
     * `null` means empty.
     */
    private readonly board: Array<GomokuStone | null>;

    /** Cursor used only during the human's interactive turn. */
    private cursorRow = Math.floor(BOARD_SIZE / 2);
    private cursorColumn = Math.floor(BOARD_SIZE / 2);

    /** Whether the interactive loop should keep accepting input. */
    private running = false;

    /** Guards cleanup so repeated calls are safe. */
    private cleanedUp = false;

    /** True after raw mode / listeners have been installed by start(). */
    private terminalConfigured = false;

    /** Bound handlers so removeListener can match what was registered. */
    private readonly onStdinData: (chunk: string) => void;
    private readonly onSigint: () => void;

    /**
     * Resolves the Promise returned by start() once the game ends
     * (win, draw, SIGINT, or setup failure that still runs cleanup).
     */
    private resolveStart: (() => void) | null = null;

    constructor() {
        // Empty 15×15 grid.
        this.board = new Array<GomokuStone | null>(BOARD_SIZE * BOARD_SIZE).fill(null);

        // Bind once so add/removeListener identity stays stable.
        this.onStdinData = (chunk: string) => {
            this.handleInput(chunk);
        };
        this.onSigint = () => {
            // Spec: print exactly this message, then cleanup.
            process.stdout.write("비겁한 놈!\n");
            void this.finishGame();
        };
    }

    /**
     * Place `stone` at (row, column) if the cell is on-board, integer, and empty.
     * Returns true on success; false leaves the board unchanged.
     */
    placeStone(row: number, column: number, stone: GomokuStone): boolean {
        if (!this.isValidCoordinate(row, column)) {
            return false;
        }
        const index = this.indexOf(row, column);
        if (this.board[index] !== null) {
            return false;
        }
        this.board[index] = stone;
        return true;
    }

    /**
     * Stone at (row, column), or null if empty / out of bounds.
     * Does not mutate the board.
     */
    stoneAt(row: number, column: number): GomokuStone | null {
        if (!this.isValidCoordinate(row, column)) {
            return null;
        }
        return this.board[this.indexOf(row, column)];
    }

    /**
     * Winning color if any line has WIN_LENGTH or more consecutive stones;
     * otherwise null. Does not mutate the board.
     */
    winner(): GomokuStone | null {
        for (let row = 0; row < BOARD_SIZE; row += 1) {
            for (let column = 0; column < BOARD_SIZE; column += 1) {
                const stone = this.stoneAt(row, column);
                if (stone === null) {
                    continue;
                }
                // Only start a run at a cell that has no same-stone neighbor
                // in the opposite direction — avoids recounting mid-line.
                for (const [dRow, dCol] of DIRECTIONS) {
                    const prev = this.stoneAt(row - dRow, column - dCol);
                    if (prev === stone) {
                        continue;
                    }
                    let length = 1;
                    let r = row + dRow;
                    let c = column + dCol;
                    while (this.stoneAt(r, c) === stone) {
                        length += 1;
                        r += dRow;
                        c += dCol;
                    }
                    if (length >= WIN_LENGTH) {
                        return stone;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Choose a CPU (white) move without changing the board.
     * Priority: immediate white win → block black's immediate win → any empty cell.
     * Returns null if someone already won or the board is full.
     */
    chooseCpuMove(): GomokuPosition | null {
        if (this.winner() !== null) {
            return null;
        }

        const empties = this.emptyCells();
        if (empties.length === 0) {
            return null;
        }

        // 1) Winning move for white.
        const winning = this.findImmediateWin(empties, "white");
        if (winning !== null) {
            return winning;
        }

        // 2) Block black's winning reply.
        const blocking = this.findImmediateWin(empties, "black");
        if (blocking !== null) {
            return blocking;
        }

        // 3) Fallback: any empty cell.
        // ASSUMPTION: prefer the center-most empty cell for slightly better play
        // and deterministic behavior; any empty cell satisfies the ensure contracts.
        return this.pickCenterMost(empties);
    }

    /**
     * Configure the terminal, run the human-vs-CPU loop, and always cleanup.
     */
    async start(): Promise<void> {
        // Reset per-run flags so a fresh start() after cleanup can work.
        this.cleanedUp = false;
        this.running = true;

        return new Promise<void>((resolve) => {
            this.resolveStart = resolve;

            try {
                this.configureTerminal();
                // Initial board render before the first human move.
                this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
            } catch (error) {
                // Ensure cleanup + resolve even if setup fails.
                const detail = error instanceof Error ? error.message : String(error);
                process.stderr.write(`GomokuGame.start failed: ${detail}\n`);
                void this.finishGame();
            }
        });
    }

    /**
     * Remove listeners and restore stdin/terminal state. Idempotent.
     */
    async cleanup(): Promise<void> {
        if (this.cleanedUp) {
            return;
        }
        this.cleanedUp = true;
        this.running = false;

        if (this.terminalConfigured) {
            process.stdin.removeListener("data", this.onStdinData);
            process.removeListener("SIGINT", this.onSigint);

            // Restore cooked mode when the TTY supports it.
            if (typeof process.stdin.setRawMode === "function") {
                try {
                    process.stdin.setRawMode(false);
                } catch {
                    // ASSUMPTION: non-TTY or already closed stdin — ignore.
                }
            }

            try {
                process.stdin.pause();
            } catch {
                // Ignore pause failures on already-closed streams.
            }

            this.terminalConfigured = false;
        }
    }

    // ---------------------------------------------------------------------------
    // Internal helpers — board geometry
    // ---------------------------------------------------------------------------

    private indexOf(row: number, column: number): number {
        return row * BOARD_SIZE + column;
    }

    /** Integer coordinates strictly inside [0, BOARD_SIZE). */
    private isValidCoordinate(row: number, column: number): boolean {
        return (
            Number.isInteger(row) &&
            Number.isInteger(column) &&
            row >= 0 &&
            row < BOARD_SIZE &&
            column >= 0 &&
            column < BOARD_SIZE
        );
    }

    /** All currently empty cells, row-major order. */
    private emptyCells(): GomokuPosition[] {
        const result: GomokuPosition[] = [];
        for (let row = 0; row < BOARD_SIZE; row += 1) {
            for (let column = 0; column < BOARD_SIZE; column += 1) {
                if (this.board[this.indexOf(row, column)] === null) {
                    result.push({ row, column });
                }
            }
        }
        return result;
    }

    /**
     * Among `candidates`, return a cell where placing `stone` would make that
     * stone the winner. Temporarily mutates then restores the cell so the
     * public board is unchanged after the call.
     */
    private findImmediateWin(
        candidates: readonly GomokuPosition[],
        stone: GomokuStone,
    ): GomokuPosition | null {
        for (const pos of candidates) {
            // Direct board write: candidates are known empty on-board cells.
            const index = this.indexOf(pos.row, pos.column);
            this.board[index] = stone;
            const won = this.winner() === stone;
            this.board[index] = null;
            if (won) {
                return pos;
            }
        }
        return null;
    }

    /** Prefer cells closer to the board center (stable, mild heuristic). */
    private pickCenterMost(empties: readonly GomokuPosition[]): GomokuPosition {
        const center = (BOARD_SIZE - 1) / 2;
        // empties is non-empty when called from chooseCpuMove.
        let best = empties[0];
        let bestDist = Number.POSITIVE_INFINITY;
        for (const pos of empties) {
            const dist = Math.abs(pos.row - center) + Math.abs(pos.column - center);
            if (dist < bestDist) {
                bestDist = dist;
                best = pos;
            }
        }
        return best;
    }

    // ---------------------------------------------------------------------------
    // Terminal / game loop
    // ---------------------------------------------------------------------------

    private configureTerminal(): void {
        if (typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        // Emit strings so handleInput always receives text.
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", this.onStdinData);
        process.on("SIGINT", this.onSigint);
        this.terminalConfigured = true;
    }

    /**
     * End the interactive session: cleanup listeners, then resolve start().
     */
    private async finishGame(): Promise<void> {
        this.running = false;
        await this.cleanup();
        const resolve = this.resolveStart;
        this.resolveStart = null;
        if (resolve !== null) {
            resolve();
        }
    }

    /**
     * Decode raw stdin chars for arrow keys, Enter, and Ctrl+C.
     * In raw mode Ctrl+C arrives as \x03 rather than SIGINT on some platforms;
     * handle both paths so the required message is always printed.
     */
    private handleInput(chunk: string): void {
        if (!this.running) {
            return;
        }

        // Ctrl+C in raw mode.
        if (chunk === "\u0003") {
            process.stdout.write("비겁한 놈!\n");
            void this.finishGame();
            return;
        }

        // ESC [ A/B/C/D — arrow keys (cursor stays inside the board).
        if (chunk === "\u001b[A") {
            this.cursorRow = Math.max(0, this.cursorRow - 1);
            this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
            return;
        }
        if (chunk === "\u001b[B") {
            this.cursorRow = Math.min(BOARD_SIZE - 1, this.cursorRow + 1);
            this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
            return;
        }
        if (chunk === "\u001b[C") {
            this.cursorColumn = Math.min(BOARD_SIZE - 1, this.cursorColumn + 1);
            this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
            return;
        }
        if (chunk === "\u001b[D") {
            this.cursorColumn = Math.max(0, this.cursorColumn - 1);
            this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
            return;
        }

        // Enter (CR or LF depending on terminal).
        if (chunk === "\r" || chunk === "\n" || chunk === "\r\n") {
            this.tryHumanMove();
            return;
        }

        // Ignore other keys (including unused escape sequences).
    }

    /**
     * Attempt to place black at the cursor; on success run CPU reply and
     * check terminal conditions.
     */
    private tryHumanMove(): void {
        const placed = this.placeStone(this.cursorRow, this.cursorColumn, "black");
        if (!placed) {
            this.render("이미 돌이 있는 칸입니다. 다른 칸을 선택하세요.");
            return;
        }

        // After every successful move, show board + status.
        if (this.checkAndAnnounceTerminal("흑돌이 승리했습니다!")) {
            return;
        }

        this.render("CPU 생각 중…");
        this.playCpuTurn();
    }

    /** CPU places white via chooseCpuMove + placeStone, then checks end state. */
    private playCpuTurn(): void {
        const move = this.chooseCpuMove();
        if (move === null) {
            // No legal CPU move: board full without a winner → draw.
            if (this.winner() === null) {
                this.render("무승부입니다.");
                void this.finishGame();
            }
            return;
        }

        this.placeStone(move.row, move.column, "white");

        if (this.checkAndAnnounceTerminal("백돌(CPU)이 승리했습니다!")) {
            return;
        }

        this.render("흑돌 차례입니다. 방향키로 이동, Enter로 착수.");
    }

    /**
     * If there is a winner or a full board, print the result and stop input.
     * `winMessage` is used when the side that just moved won.
     * Returns true when the game ended.
     */
    private checkAndAnnounceTerminal(winMessage: string): boolean {
        const w = this.winner();
        if (w !== null) {
            this.render(winMessage);
            void this.finishGame();
            return true;
        }
        if (this.emptyCells().length === 0) {
            this.render("무승부입니다.");
            void this.finishGame();
            return true;
        }
        return false;
    }

    /**
     * Clear the screen and print the board, cursor, and a status line.
     * Uses only process.stdout (no external terminal libraries).
     *
     * ASSUMPTION: visual layout is not contract-tested; glyphs and spacing
     * are chosen for readability in a typical monospaced terminal.
     */
    private render(status: string): void {
        // ANSI: clear screen + home cursor.
        process.stdout.write("\u001b[2J\u001b[H");

        const pretty: string[] = [];
        pretty.push("=== 오목 (Gomoku) 15×15 — 흑: 사람 / 백: CPU ===");

        let header = "   ";
        for (let column = 0; column < BOARD_SIZE; column += 1) {
            header += (column % 10).toString() + " ";
        }
        pretty.push(header);

        for (let row = 0; row < BOARD_SIZE; row += 1) {
            let line = row.toString().padStart(2, " ") + " ";
            for (let column = 0; column < BOARD_SIZE; column += 1) {
                const stone = this.stoneAt(row, column);
                let glyph: string;
                if (stone === "black") {
                    glyph = "●";
                } else if (stone === "white") {
                    glyph = "○";
                } else {
                    glyph = "·";
                }
                const atCursor =
                    this.running &&
                    row === this.cursorRow &&
                    column === this.cursorColumn;
                // Cursor brackets highlight the active cell during human turns.
                if (atCursor) {
                    line += "[" + glyph + "]";
                } else {
                    line += " " + glyph + " ";
                }
            }
            pretty.push(line);
        }

        pretty.push("");
        pretty.push(status);
        pretty.push("종료: Ctrl+C");

        process.stdout.write(pretty.join("\n") + "\n");
    }
}

/// END OF AUTO-GENERATED CODE
