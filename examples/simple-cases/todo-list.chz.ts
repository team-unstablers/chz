/// todo-list.chz.ts
// A basic `imagine class` example: an in-memory todo list.
//
// The human declares the class's public API, state invariants, and executable
// contracts (ensure). During `chz realize`, the LLM implements the entire
// TodoList class, including the internal state shared by its methods.

/** The public, read-only representation of a todo item. */
export interface TodoItem {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

imagine class TodoList {
  requirements(`
    Implement an in-memory todo list.

    - A new list must be empty.
    - Assign each todo a unique, monotonically increasing ID starting at 1.
    - Trim leading and trailing whitespace from titles before storing them.
    - Throw RangeError if the trimmed title is empty.
    - complete(id) is idempotent and returns true even for an already completed item.
    - The caller must not be able to change internal state by modifying the value
      returned by list() or any of its elements.
  `);

  ensure("A new todo list is empty.", () => {
    const todos = new TodoList();

    assert(todos.list().length === 0);
  });

  imagine add(title: string): number {
    requirements(`
      Trim leading and trailing whitespace from the title, add the todo, and return
      its newly assigned ID. Throw RangeError if the trimmed title is empty.
    `);

    ensure("New IDs start at 1 and increase by 1.", () => {
      const todos = new TodoList();

      assert(todos.add("First") === 1);
      assert(todos.add("Second") === 2);
    });

    ensure("Titles are normalized and empty titles are rejected.", () => {
      const todos = new TodoList();
      todos.add("  Read the docs  ");

      assert(todos.list()[0]?.title === "Read the docs");

      let rejected = false;
      try {
        todos.add(" \t ");
      } catch (error) {
        rejected = error instanceof RangeError;
      }
      assert(rejected);
    });
  }

  imagine complete(id: number): boolean {
    requirements(`
      Mark an existing todo as completed and return true. Return true for an
      already completed item, and return false for an ID that does not exist.
    `);

    ensure("Completing an existing ID is idempotent.", () => {
      const todos = new TodoList();
      const id = todos.add("Task to complete");

      assert(todos.complete(id) === true);
      assert(todos.complete(id) === true);
      assert(todos.complete(id + 1) === false);
      assert(todos.list()[0]?.completed === true);
    });
  }

  imagine list(): readonly TodoItem[] {
    requirements(`Return a defensive snapshot of the current todo list in ascending ID order.`);

    ensure("The list is a snapshot that preserves ID order and completion state.", () => {
      const todos = new TodoList();
      const first = todos.add("First");
      const second = todos.add("Second");
      assert(todos.complete(second) === true);

      const snapshot = todos.list();
      assert(Array.isArray(snapshot));
      assert(snapshot.length === 2);
      assert(snapshot[0]?.id === first && snapshot[0].completed === false);
      assert(snapshot[1]?.id === second && snapshot[1].completed === true);
    });

    ensure("Modifying a returned snapshot does not change internal state.", () => {
      const todos = new TodoList();
      todos.add("Original title");
      todos.add("Task that must remain");

      const snapshot = todos.list();
      const mutableSnapshot = snapshot as Array<{
        id: number;
        title: string;
        completed: boolean;
      }>;

      // Also allow exceptions when the implementation freezes the snapshot.
      try {
        mutableSnapshot[0]!.title = "Tampered title";
      } catch {}
      try {
        mutableSnapshot.pop();
      } catch {}

      const freshSnapshot = todos.list();
      assert(freshSnapshot.length === 2);
      assert(freshSnapshot[0]?.title === "Original title");
      assert(freshSnapshot[1]?.title === "Task that must remain");
    });
  }
}

// --- Minimal wiring: print state changes from the realized class. ---

const todos = new TodoList();
todos.add("Read the Cheese language docs");
const firstRealizeId = todos.add("Realize the first class");
todos.complete(firstRealizeId);

console.log("Todo list:", todos.list());
