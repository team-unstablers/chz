/// todo-list.chz.ts
// `imagine class`의 기본 예제 — 메모리 기반 할 일 목록.
//
// 사람은 클래스의 공개 API와 상태 불변식, 실행 가능한 계약(ensure)을
// 선언합니다. `chz realize` 단계에서는 LLM이 여러 메서드가 공유하는
// 내부 상태를 포함해 TodoList 클래스 전체를 구현합니다.

/** 외부에 공개되는 할 일 항목의 읽기 전용 표현. */
export interface TodoItem {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

imagine class TodoList {
  requirements(`
    메모리 안에서 동작하는 할 일 목록을 구현합니다.

    - 새 목록은 비어 있어야 합니다.
    - 각 할 일에는 1부터 시작해 계속 증가하는 고유 ID를 부여합니다.
    - 제목은 앞뒤 공백을 제거하여 저장합니다.
    - 공백을 제거한 제목이 빈 문자열이면 RangeError를 던집니다.
    - complete(id)는 이미 완료된 항목에도 true를 반환하는 멱등 연산입니다.
    - list()가 반환하는 값이나 그 요소를 호출자가 수정해도 내부 상태가 바뀌면 안 됩니다.
  `);

  ensure("새 할 일 목록은 비어 있습니다.", () => {
    const todos = new TodoList();

    assert(todos.list().length === 0);
  });

  imagine add(title: string): number {
    requirements(`
      제목의 앞뒤 공백을 제거한 뒤 할 일을 추가하고 새로 부여한 ID를 반환합니다.
      공백을 제거한 제목이 빈 문자열이면 RangeError를 던집니다.
    `);

    ensure("새 ID는 1부터 시작해 1씩 증가합니다.", () => {
      const todos = new TodoList();

      assert(todos.add("첫 번째") === 1);
      assert(todos.add("두 번째") === 2);
    });

    ensure("제목을 정규화하고 빈 제목을 거부합니다.", () => {
      const todos = new TodoList();
      todos.add("  문서 읽기  ");

      assert(todos.list()[0]?.title === "문서 읽기");

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
      존재하는 할 일을 완료 상태로 바꾸고 true를 반환합니다.
      이미 완료된 항목에도 true를 반환하며, 존재하지 않는 ID에는 false를 반환합니다.
    `);

    ensure("완료 처리는 존재하는 ID에 대해 멱등적으로 동작합니다.", () => {
      const todos = new TodoList();
      const id = todos.add("완료할 일");

      assert(todos.complete(id) === true);
      assert(todos.complete(id) === true);
      assert(todos.complete(id + 1) === false);
      assert(todos.list()[0]?.completed === true);
    });
  }

  imagine list(): readonly TodoItem[] {
    requirements(`현재 할 일 목록의 방어적 스냅샷을 ID 오름차순으로 반환합니다.`);

    ensure("목록은 ID 순서와 완료 상태를 보존한 스냅샷입니다.", () => {
      const todos = new TodoList();
      const first = todos.add("첫 번째");
      const second = todos.add("두 번째");
      assert(todos.complete(second) === true);

      const snapshot = todos.list();
      assert(Array.isArray(snapshot));
      assert(snapshot.length === 2);
      assert(snapshot[0]?.id === first && snapshot[0].completed === false);
      assert(snapshot[1]?.id === second && snapshot[1].completed === true);
    });

    ensure("반환된 스냅샷을 수정해도 내부 상태는 바뀌지 않습니다.", () => {
      const todos = new TodoList();
      todos.add("원래 제목");
      todos.add("남아 있을 일");

      const snapshot = todos.list();
      const mutableSnapshot = snapshot as Array<{
        id: number;
        title: string;
        completed: boolean;
      }>;

      // 구현이 스냅샷을 동결하는 경우의 예외도 허용합니다.
      try {
        mutableSnapshot[0]!.title = "변조된 제목";
      } catch {}
      try {
        mutableSnapshot.pop();
      } catch {}

      const freshSnapshot = todos.list();
      assert(freshSnapshot.length === 2);
      assert(freshSnapshot[0]?.title === "원래 제목");
      assert(freshSnapshot[1]?.title === "남아 있을 일");
    });
  }
}

// --- 최소 배선 코드: realize된 클래스의 상태 변화를 콘솔에 출력합니다. ---

const todos = new TodoList();
todos.add("치즈 언어 문서 읽기");
const firstRealizeId = todos.add("첫 클래스 realize 해보기");
todos.complete(firstRealizeId);

console.log("할 일 목록:", todos.list());
