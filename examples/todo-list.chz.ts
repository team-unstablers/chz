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
    ensure((args, retval) => typeof retval === "number" && Number.isInteger(retval) && retval > 0);
    ensure(`연속해서 할 일을 추가하면 반환되는 ID가 항상 1씩 증가해야 합니다.`);
  }

  imagine complete(id: number): boolean {
    requirements(`존재하는 할 일을 완료 상태로 바꾸고 성공 여부를 반환합니다.`);
    ensure((args, retval) => typeof retval === "boolean");
    ensure(`존재하지 않는 ID를 완료하려 하면 false를 반환해야 합니다.`);
  }

  imagine list(): readonly TodoItem[] {
    requirements(`현재 할 일 목록의 방어적 스냅샷을 ID 오름차순으로 반환합니다.`);
    ensure((args, retval) => Array.isArray(retval));
    ensure(`반환된 항목은 ID 오름차순이어야 하며 완료 상태를 정확히 반영해야 합니다.`);
  }
}
