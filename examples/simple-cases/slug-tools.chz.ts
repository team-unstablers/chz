/// slug-tools.chz.ts
// An example with a dependency between two imagine symbols. It verifies
// symbol-level realization order and dependency-surface injection.

imagine function slugify(input: string): string {
  requirements(`
    # URL Slug Generator

    - Convert a string into a slug suitable for use in a URL.
    - Convert uppercase English letters to lowercase.
    - Replace whitespace, including consecutive whitespace, with a single hyphen.
    - Remove every character other than lowercase English letters, digits, and hyphens.
    - Remove leading and trailing hyphens, and collapse consecutive hyphens into one.
  `);

  ensure(slugify("Hello World") === "hello-world", "Basic conversion must work.");
  ensure(slugify("  --Hello,   World!--  ") === "hello-world", "Special characters must be removed and hyphens normalized.");
  ensure(slugify("한글 제목") === "", "Input containing only characters that cannot be slugified must produce an empty string.");
}

imagine function buildUniqueSlugs(titles: readonly string[]): string[] {
  requirements(`
    # Unique Slug List Generator

    - Convert each title with slugify() to create a list of slugs.
    - If a slug has already appeared, append numeric suffixes in order, such as
      "-2", "-3", and so on, to make it unique. The first occurrence has no suffix.
    - Replace an empty slug ("") with "untitled", then apply the same duplicate rule.
    - Preserve input order.
  `);

  ensure("Duplicate slugs receive numeric suffixes.", () => {
    const slugs = buildUniqueSlugs(["My Post", "My Post", "My Post"]);
    assert(slugs.length === 3);
    assert(slugs[0] === "my-post");
    assert(slugs[1] === "my-post-2");
    assert(slugs[2] === "my-post-3");
  });

  ensure("Empty slugs are replaced with untitled.", () => {
    const slugs = buildUniqueSlugs(["한글", "한글"]);
    assert(slugs[0] === "untitled");
    assert(slugs[1] === "untitled-2");
  });
}

// --- Minimal wiring ---
console.log(buildUniqueSlugs(["Hello World", "Hello  World", "한글 제목"]));
