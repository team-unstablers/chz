import { Point, Circle, Rectangle, Shape, 원A, 사각형B } from "./__prologue__.ts";
import { 충돌판정_2D } from "./충돌판정_2D.ts";

const 충돌여부 = 충돌판정_2D(원A, 사각형B);
console.log(`충돌 여부: ${충돌여부}`);
