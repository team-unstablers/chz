export type GomokuStone = "black" | "white";

export interface GomokuPosition {
    readonly row: number;
    readonly column: number;
}