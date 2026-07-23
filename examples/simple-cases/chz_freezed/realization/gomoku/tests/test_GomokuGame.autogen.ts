/// test_GomokuGame.autogen.ts
/// AUTO-GENERATED tests for `imagine class GomokuGame`, authored by google/gemini-3.6-flash
/// (via chz-realize) on 2026-07-23T21:54:25.178Z.

import { describe, it, expect } from "vitest";
import { GomokuGame } from "../implementations/GomokuGame.ts";

describe("GomokuGame Autogen Tests", () => {
    it("initializes an empty board", () => {
        const game = new GomokuGame();
        for (let r = 0; r < 15; r++) {
            for (let c = 0; c < 15; c++) {
                expect(game.stoneAt(r, c)).toBeNull();
            }
        }
        expect(game.winner()).toBeNull();
    });

    it("handles invalid stone placements", () => {
        const game = new GomokuGame();
        expect(game.placeStone(-1, 0, "black")).toBe(false);
        expect(game.placeStone(0, 15, "white")).toBe(false);
        expect(game.placeStone(1.2, 3, "black")).toBe(false);
        expect(game.placeStone(3, 3.5, "white")).toBe(false);

        expect(game.placeStone(7, 7, "black")).toBe(true);
        expect(game.placeStone(7, 7, "white")).toBe(false); // Already occupied
    });

    it("detects wins correctly", () => {
        const game = new GomokuGame();
        expect(game.winner()).toBeNull();

        // Place 5 black stones horizontally
        for (let c = 0; c < 5; c++) {
            game.placeStone(0, c, "black");
        }
        expect(game.winner()).toBe("black");
    });

    it("selects center or near-center for empty board CPU move", () => {
        const game = new GomokuGame();
        const move = game.chooseCpuMove();
        expect(move).not.toBeNull();
        expect(move?.row).toBe(7);
        expect(move?.column).toBe(7);
    });

    it("blocks immediate opponent win", () => {
        const game = new GomokuGame();
        // Place 4 black stones in a row
        for (let c = 0; c < 4; c++) {
            game.placeStone(5, c, "black");
        }
        const move = game.chooseCpuMove();
        expect(move).toEqual({ row: 5, column: 4 });
    });

    it("takes immediate win when available", () => {
        const game = new GomokuGame();
        // Place 4 white stones in a row
        for (let c = 0; c < 4; c++) {
            game.placeStone(3, c, "white");
        }
        const move = game.chooseCpuMove();
        expect(move).toEqual({ row: 3, column: 4 });
    });

    it("allows clean cleanup and multiple cleanups", async () => {
        const game = new GomokuGame();
        await expect(game.cleanup()).resolves.not.toThrow();
        await expect(game.cleanup()).resolves.not.toThrow();
    });
});
