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
    - 빈 제목이나 공백만 있는 제목은 허용하지 않습니다.
    - list()가 반환하는 값이나 그 요소를 호출자가 수정해도 내부 상태가 바뀌면 안 됩니다.
  `);

  imagine add(title: string): number {
    requirements(`할 일을 추가하고 새로 부여한 ID를 반환합니다.`);
    ensure("새 ID는 1부터 시작해 1씩 증가합니다.", () => {
      const todos = new TodoList();

      assert(todos.add("첫 번째") === 1);
      assert(todos.add("두 번째") === 2);
    });
  }

  imagine complete(id: number): boolean {
    requirements(`존재하는 할 일을 완료 상태로 바꾸고 성공 여부를 반환합니다.`);
    ensure("존재하는 ID만 완료할 수 있습니다.", () => {
      const todos = new TodoList();
      const id = todos.add("완료할 일");

      assert(todos.complete(id) === true);
      assert(todos.complete(id + 1) === false);
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
  }
}
