# Cheese Contribution Language

The Cheese Contribution Language is a language for vibe coding. Its goal is to
be a programming language in which LLMs write the implementation and humans
supervise it.

## A Superset of TypeScript

The Cheese Contribution Language is designed as a superset of TypeScript.
Almost all TypeScript code you already know is valid Cheese code as-is. Cheese
adds extension keywords such as `imagine` on top of TypeScript, allowing you to
specify which parts an LLM should implement.

## Example

```typescript chz
/// example.chz.ts
// The Cheese Contribution Language works like ordinary TypeScript!
const a = 1;
const b = 2;

const c = a + b;

function greet(name: string): string {
  return `Hello, ${name}!`;
}

// Cheese has a special keyword called `imagine`.
// During the `realize` step, the LLM implements functions marked with `imagine`!
imagine function greetLikePirate(name: string): string {
  // Use requirements() to describe what the function must do.
  // This is optional, but requirements help the LLM implement the function more accurately.
  requirements(`Write a function that greets someone like a pirate.`);

  // In ensure(), humans provide a concrete input and expected result as an assertion.
  // The engine turns this expression into a model-independent test and always runs it.
  ensure(
    greetLikePirate("Cheese") === "Ahoy, Cheese!",
    "The function must greet the name Cheese like a pirate.",
  );

  // Write contracts with multiple setup or verification steps as executable scenarios.
  // Inside a scenario, you can use the assert() function provided by the engine.
  ensure("The return value starts with Ahoy and includes the name.", () => {
    const greeting = greetLikePirate("Ren");

    assert(greeting.startsWith("Ahoy, "));
    assert(greeting.includes("Ren"));
  });
}

// The `imagine` keyword can be applied to classes as well as functions!
imagine class ShootingGame {
  requirements(`
    # Implement a 2D shooting game similar to Space Invaders.

    ## Game Rules

    - The player must be able to move only left and right.
    - The player must be able to fire bullets.
    - Alien enemies move from right to left and descend one row when they reach the edge of the screen.

    ## Technology Stack

    - Use HTML5 Canvas.
    - Use the Web Audio API to play sound effects.

    ## NOTE

    - The game must start when the player clicks the "Start Game" button inside the HTML5 Canvas.
    - Implement the game loop at 60 FPS.
  `);

  // Inside an imagine class, you can additionally define or require variables and functions.
  // **Define**: Defining a variable or function here gives the LLM an implementation reference.
  static collisionDetection2D(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number): boolean {
    return !(x1 + w1 < x2 || x2 + w2 < x1 || y1 + h1 < y2 || y2 + h2 < y1);
  }

  // **Require**: The imagine keyword creates a contract that says, "This function or variable must exist!"
  imagine score: number {
    requirements(`A variable is needed to store the game score. It must be reset to 0 when the game is over.`);
  }

  imagine initialize(attachToSelector: string): void {
    requirements(`Implement a function that initializes the game and attaches its canvas to the specified CSS selector.`);
  }

  imagine startGame(): void {
    requirements(`Implement a function that starts the game. It must start the game loop and make alien enemies appear on the screen.`);
  }

  imagine playSound(sound: Chz.AudioAsset): void {
    requirements(`Implement a function that plays the given audio asset. It must use the Web Audio API.`);
  }

  // Use `imagine resource` to request an asset from generative AI.
  imagine resource background: Chz.ImageAsset {
    // Resource properties are both generation parameters and verification constraints on the output.
    width = 720;
    height = 1280;

    requirements(`
      Positive prompt: masterpiece, best quality, vertical 2D arcade shooter
      background, deep outer space, colorful nebulae, dense star field,
      subtle parallax layers, dark navy and violet palette, polished game art
      Negative prompt: characters, enemies, spacecraft, projectiles, HUD, UI,
      text, logo, watermark, border, blurry, low quality
    `);
  };

  imagine resource alienSprite: Chz.ImageAsset {
    width = 64;
    height = 64;

    requirements(`
      Positive prompt: masterpiece, best quality, single cute cartoon alien
      enemy, 2D arcade game sprite, front view, full body, centered,
      symmetrical, bold readable silhouette, vibrant colors, transparent background
      Negative prompt: multiple characters, scenery, ground, frame, text,
      logo, watermark, realistic, blurry, cropped, extra limbs
    `);
  };

  imagine resource playerSprite: Chz.ImageAsset {
    width = 64;
    height = 64;

    requirements(`
      Positive prompt: masterpiece, best quality, single player spaceship,
      2D arcade game sprite, front view, centered, symmetrical, compact shape,
      blue engine glow, crisp edges, transparent background
      Negative prompt: multiple spacecraft, pilot, scenery, ground, frame,
      text, logo, watermark, realistic photograph, blurry, cropped
    `);
  };

  imagine resource bulletSprite: Chz.ImageAsset {
    width = 16;
    height = 16;

    requirements(`
      Positive prompt: masterpiece, best quality, single circular energy
      bullet, tiny 2D arcade game projectile sprite, centered, simple round
      shape, bright cyan core, soft glow, crisp edges, transparent background
      Negative prompt: multiple projectiles, weapon, scenery, frame, text,
      logo, watermark, complex shape, blurry
    `);
  };

  imagine resource shootSound: Chz.AudioAsset {
    // Constraint properties such as maxDuration can set upper or lower bounds.
    maxDuration = 1.0;

    requirements(`
      Positive prompt: retro arcade laser shot sound effect, single one-shot,
      short sharp electronic zap, crisp transient, fast decay, punchy, clean,
      dry, under one second
      Negative prompt: music, melody, ambience, speech, echo, reverb,
      distortion, long tail, multiple shots
    `);
  };
}

// An imagine function can be called just like an ordinary function.
console.log(greetLikePirate('Cheese'));
```

### How Do I Run This Code?

Although the Cheese Contribution Language is a superset of TypeScript, this
code cannot be run directly. Functions and classes marked with `imagine` exist
only as human-authored requirements, so an LLM must first make them real in a
process called `realize`.

```shell
# This command runs the realize step. The LLM implements functions and classes marked with imagine.
$ chz realize example.chz.ts

# After realize finishes, it creates a directory structure like this:
|- example.chz.ts
|- chz/realization
    |- example/
        |- realization-cache.json                # Cache for incremental realize runs
        |- implementation.ts                     # Entry point—connects prologue → implementation → epilogue
        |- implementations/                      # Directory containing the actual implementations
            |- __prologue__.ts                   # Human-authored code that does not reference imagine symbols (a, b, c, greet)
            |- greetLikePirate.ts                # The realized greetLikePirate function
            |- ShootingGame.ts                   # The realized ShootingGame class
            |- __epilogue__.ts                   # Human-authored code that references imagine symbols (the final console.log)
        |- tests/                                # Test code
            |- test_greetLikePirate.ensure.ts    # Human-authored ensure() contract test
            |- test_greetLikePirate.autogen.ts   # Test written by the LLM during implementation
            |- test_ShootingGame.autogen.ts      # Test written by the LLM during implementation
        |- resources/
            |- ShootingGame/
                |- background.png
                |- alienSprite.png
                |- playerSprite.png
                |- bulletSprite.png
                |- shootSound.ogg
```

Notice that human-authored code is also copied into the realization directory.
This is because Cheese has no separate build step: this committed directory is
— without any LLM calls — the final code that runs and gets bundled as-is.
Code that does not reference imagine symbols is stored in
`__prologue__.ts`, while code that does is stored in `__epilogue__.ts`. This
separates code that must load before the implementation from code that must
load afterward. See [specification 60](60-realize-intro.ko.md) for the detailed
rules.

You can find the detailed specification for realize in specification 60.

### How Do I Import Realized Code?

Import the `example.ts` shim that is generated next to the source file, using
an ordinary relative path:

```typescript
/// game.ts
import { greetLikePirate, ShootingGame } from './example';

console.log(greetLikePirate('Cheese'));
```

Cheese has no separate build step and no bundler plugin — a realized project
is a plain TypeScript project that tools unaware of Cheese can handle as-is,
and the shim is a committed file that reaches the realized artifacts through
standard resolution rules alone. The same rule applies when Cheese files
import each other, and those import statements become the clues for the
cross-file dependency graph (see
[specification 62](62-realize-dependency-graph.ko.md)).
