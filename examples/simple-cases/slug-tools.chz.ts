/// slug-tools.chz.ts
// 두 개의 imagine 심볼 사이에 의존성이 있는 예제 — 심볼 단위 realize 순서와
// 의존성 표면(dependency surface) 주입을 검증하기 위한 예제입니다.

imagine function slugify(input: string): string {
  requirements(`
    # URL 슬러그 생성기

    - 문자열을 URL에 쓸 수 있는 슬러그로 변환합니다.
    - 영문 대문자는 소문자로 바꿉니다.
    - 공백(연속 포함)은 하이픈 1개로 바꿉니다.
    - 영소문자, 숫자, 하이픈 이외의 문자는 제거합니다.
    - 앞뒤 하이픈은 제거하고, 연속된 하이픈은 1개로 접습니다.
  `);

  ensure(slugify("Hello World") === "hello-world", "기본 변환이 동작해야 합니다.");
  ensure(slugify("  --Hello,   World!--  ") === "hello-world", "특수문자 제거와 하이픈 정리가 동작해야 합니다.");
  ensure(slugify("한글 제목") === "", "슬러그화할 수 없는 문자만 있으면 빈 문자열을 반환합니다.");
}

imagine function buildUniqueSlugs(titles: readonly string[]): string[] {
  requirements(`
    # 중복 없는 슬러그 목록 생성기

    - 각 제목을 slugify()로 변환해 슬러그 목록을 만듭니다.
    - 같은 슬러그가 이미 나왔다면 "-2", "-3" … 순으로 숫자 접미사를 붙여
      유일하게 만듭니다. (첫 등장은 접미사 없음)
    - 빈 슬러그("")는 "untitled"로 대체한 뒤 같은 중복 규칙을 적용합니다.
    - 입력 순서를 보존합니다.
  `);

  ensure("중복 슬러그에 순번이 붙습니다.", () => {
    const slugs = buildUniqueSlugs(["My Post", "My Post", "My Post"]);
    assert(slugs.length === 3);
    assert(slugs[0] === "my-post");
    assert(slugs[1] === "my-post-2");
    assert(slugs[2] === "my-post-3");
  });

  ensure("빈 슬러그는 untitled로 대체됩니다.", () => {
    const slugs = buildUniqueSlugs(["한글", "한글"]);
    assert(slugs[0] === "untitled");
    assert(slugs[1] === "untitled-2");
  });
}

// --- 최소 배선 코드 ---
console.log(buildUniqueSlugs(["Hello World", "Hello  World", "한글 제목"]));
