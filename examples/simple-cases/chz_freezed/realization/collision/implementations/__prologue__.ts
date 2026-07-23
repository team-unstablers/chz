/// collision.chz.ts
// The first official chz (Cheese) example: 2D collision detection.
//
// Cheese is a superset of TypeScript, so all the type definitions below are
// ordinary TypeScript. The human declares only the shape model and contracts
// (ensure); the LLM implements the collision algorithm during `chz realize`.

/** A point on a 2D plane. */
interface Point {
  x: number;
  y: number;
}

/** A circle defined by its center and radius. */
interface Circle {
  kind: "circle";
  center: Point;
  radius: number;
}

/** An axis-aligned rectangle (AABB) defined by its top-left origin, width, and height. */
interface Rectangle {
  kind: "rectangle";
  origin: Point; // Top-left vertex
  width: number;
  height: number;
}

/** A shape used for collision detection: a discriminated union of a circle or rectangle. */
type Shape = Circle | Rectangle;



// --- Minimal wiring: call the realized function and print the result. ---

const 원A: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
const 사각형B: Shape = { kind: "rectangle", origin: { x: 3, y: 3 }, width: 4, height: 4 };

export { Point, Circle, Rectangle, Shape, 원A, 사각형B };
