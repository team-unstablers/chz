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

imagine function checkCollision2D(a: Shape, b: Shape): boolean {
  requirements(`
    # Implement a function that determines whether two 2D shapes collide (overlap).

    ## Shape model
    - A shape is either a circle or an axis-aligned rectangle. The two variants
      form a discriminated union identified by the \`kind\` field.
    - A circle has center coordinates and a radius.
    - A rectangle has a top-left origin, a width, and a height.
      You may assume that width and height are positive.

    ## Collision rules
    - Handle all three combinations: circle-circle, rectangle-rectangle, and
      circle-rectangle. Circle-rectangle checks must work in either argument order.
    - Return true if the shapes overlap at all, and false if they share no points.
    - Treat exact boundary contact as overlap and return true. This includes cases
      where the distance between two circle centers equals the sum of their radii,
      or where rectangle edges touch exactly.
  `);

  // Write short contracts directly as boolean expressions, like assertions.
  ensure(
    checkCollision2D(
      { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
      { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
    ) === true,
    "Two identical circles must collide.",
  );

  // Write contracts that need setup or multiple assertions as executable scenarios.
  ensure("Distant shapes must not collide.", () => {
    const circle: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 1 };
    const rectangle: Shape = {
      kind: "rectangle",
      origin: { x: 10, y: 10 },
      width: 2,
      height: 2,
    };

    assert(checkCollision2D(circle, rectangle) === false);
  });

  ensure("Collision detection must be symmetric with respect to argument order.", () => {
    const circle: Shape = { kind: "circle", center: { x: 2, y: 2 }, radius: 2 };
    const rectangle: Shape = {
      kind: "rectangle",
      origin: { x: 3, y: 1 },
      width: 3,
      height: 3,
    };

    assert(checkCollision2D(circle, rectangle) === checkCollision2D(rectangle, circle));
  });

  ensure("A circle and rectangle touching at one point must collide.", () => {
    const circle: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 2 };
    const rectangle: Shape = {
      kind: "rectangle",
      origin: { x: 2, y: -1 },
      width: 2,
      height: 2,
    };

    assert(checkCollision2D(circle, rectangle) === true);
  });
}

// --- Minimal wiring: call the realized function and print the result. ---

const circleA: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
const rectangleB: Shape = { kind: "rectangle", origin: { x: 3, y: 3 }, width: 4, height: 4 };

const collided = checkCollision2D(circleA, rectangleB);
console.log(`Collision: ${collided}`);
