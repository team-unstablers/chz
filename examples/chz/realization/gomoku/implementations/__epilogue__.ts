import { GomokuStone, GomokuPosition } from "./__prologue__.ts";
import { GomokuGame } from "./GomokuGame.ts";

(async () => {
    const game = new GomokuGame();
    await game.start();
})();
