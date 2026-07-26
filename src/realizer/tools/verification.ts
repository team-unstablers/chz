import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";

import {
  SyntaxKind,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  type Checker,
  type Node,
  type Program,
  type SourceFile,
  type TypeScriptDiagnostic,
} from "../../compiler/ts-api.ts";
import {
  API,
  DiagnosticCategory,
} from "../../compiler/ts-api.ts";
import { moduleReferenceForNode } from "../../compiler/index.ts";

import { runRealizationTests } from "../../verify.ts";
import type {
  ChzDiagnostic,
  ChzRealizeContext,
  ChzVerificationResult,
} from "../types.ts";

const INVALID_INPUT_SUFFIX =
  "Please rewrite the input so it satisfies the expected schema.";
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

interface RunTestsInput {
  testFiles: string[];
}

interface VerificationOutput {
  passed: boolean;
  diagnostics: ChzDiagnostic[];
}

function invalidInput(schemaError: string): Error {
  return new Error(`Invalid tool input: ${schemaError}. ${INVALID_INPUT_SUFFIX}`);
}

function requirePlainObject(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput(`${toolName} input must be an object`);
  }
  return input as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw invalidInput(`unexpected field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
  }
}

function parseRunTestsInput(input: unknown): RunTestsInput {
  const object = requirePlainObject(input, "RunTests");
  rejectUnexpectedKeys(object, ["testFiles"]);
  if (!Object.hasOwn(object, "testFiles")) {
    throw invalidInput("testFiles is required and must be an array of strings");
  }
  if (!Array.isArray(object.testFiles) || !object.testFiles.every((item) => typeof item === "string")) {
    throw invalidInput("testFiles must be an array of strings");
  }
  if (object.testFiles.some((item) => item.length === 0)) {
    throw invalidInput("testFiles entries must be non-empty strings");
  }
  return { testFiles: object.testFiles };
}

function parseNoArgumentInput(input: unknown, toolName: string): void {
  const object = requirePlainObject(input, toolName);
  rejectUnexpectedKeys(object, []);
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function collectTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files.sort();
}

// ---------------------------------------------------------------------------
// Verification scope (docs/62: per-symbol sessions must not be judged on other
// symbols' unfinished files, and never on engine- or human-owned layers)
// ---------------------------------------------------------------------------

function scopeImplementationPath(outputDir: string, symbolName: string): string {
  return join(outputDir, "implementations", `${symbolName}.ts`);
}

function scopeAutogenTestPath(outputDir: string, symbolName: string): string {
  return join(outputDir, "tests", `test_${symbolName}.autogen.ts`);
}

function scopeEnsureTestPath(outputDir: string, symbolName: string): string {
  return join(outputDir, "tests", `test_${symbolName}.ensure.ts`);
}

/**
 * The existing files a scoped session is verified on. Dependencies (prologue,
 * previously realized symbols) still enter the type-check program through the
 * scope files' imports; `__epilogue__` may import not-yet-realized symbols and
 * must never be pulled in by a scoped session.
 */
function collectScopeFiles(outputDir: string, symbolNames: readonly string[]): string[] {
  return symbolNames
    .flatMap((name) => [
      scopeImplementationPath(outputDir, name),
      scopeAutogenTestPath(outputDir, name),
      scopeEnsureTestPath(outputDir, name),
    ])
    .filter(existsSync);
}

/** The scope's runnable test files (model autogen + engine ensure), existing only. */
function collectScopeTestFiles(outputDir: string, symbolNames: readonly string[]): string[] {
  return symbolNames
    .flatMap((name) => [
      scopeAutogenTestPath(outputDir, name),
      scopeEnsureTestPath(outputDir, name),
    ])
    .filter(existsSync);
}

/**
 * The restricted subset binds realized (model-authored) code only. Human
 * layers may use full TypeScript, and the engine-owned entry point must import
 * `__epilogue__` — so neither is ever linted.
 */
function isModelAuthoredFile(outputDir: string, file: string): boolean {
  const rel = relative(outputDir, file).split(sep).join("/");
  if (rel === "implementation.ts") return false; // engine-owned entry point
  if (rel === "implementations/__prologue__.ts") return false; // human-owned
  if (rel === "implementations/__epilogue__.ts") return false; // human-owned
  if (/^tests\/[^/]+\.ensure\.ts$/.test(rel)) return false; // engine-owned ensure harness
  return true;
}

function createCompilerConfig(
  configPath: string,
  projectRoot: string,
  rootFiles: readonly string[],
): void {
  const compilerOptions: Record<string, unknown> = {
    allowImportingTsExtensions: true,
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: "ES2022",
  };
  const typeRoots: string[] = [];
  const projectTypeRoots = join(projectRoot, "node_modules", "@types");
  if (existsSync(projectTypeRoots)) typeRoots.push(projectTypeRoots);

  // The realization checker is engine-owned, so Node globals must not depend
  // on whether the user's project happens to install its own @types/node.
  // `console` is part of the console profile and is emitted legitimately in
  // human-owned epilogues.
  const require = createRequire(import.meta.url);
  const engineTypeRoots = dirname(dirname(require.resolve("@types/node/package.json")));
  if (!typeRoots.includes(engineTypeRoots)) typeRoots.push(engineTypeRoots);
  compilerOptions.typeRoots = typeRoots;
  compilerOptions.types = ["node"];
  writeFileSync(configPath, `${JSON.stringify({ compilerOptions, files: rootFiles }, null, 2)}\n`, "utf8");
}

function withTypeScriptProgram<T>(
  projectRoot: string,
  rootFiles: readonly string[],
  action: (program: Program, checker: Checker) => T,
): T {
  const configDir = mkdtempSync(join(tmpdir(), "chz-realizer-ts-"));
  const configPath = join(configDir, "tsconfig.json");
  createCompilerConfig(configPath, projectRoot, rootFiles);

  const api = new API({ cwd: projectRoot });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
    if (project === undefined) {
      throw new Error(
        "TypeScript did not create a project for the realization. Check that the output files are readable and try again.",
      );
    }
    return action(project.program, project.checker);
  } finally {
    snapshot?.dispose();
    api.close();
    rmSync(configDir, { recursive: true, force: true });
  }
}

function diagnosticSeverity(category: DiagnosticCategory): "error" | "warning" {
  return category === DiagnosticCategory.Error ? "error" : "warning";
}

function positionForDiagnostic(
  program: Program,
  diagnostic: TypeScriptDiagnostic,
): { file: string; line: number; col: number } {
  if (diagnostic.fileName === undefined) {
    return { file: "<realization>", line: 1, col: 1 };
  }
  const sourceFile = program.getSourceFile(diagnostic.fileName);
  if (sourceFile === undefined || diagnostic.pos < 0) {
    return { file: diagnostic.fileName, line: 1, col: 1 };
  }
  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.pos);
  return {
    file: diagnostic.fileName,
    line: position.line + 1,
    col: position.character + 1,
  };
}

function flattenDiagnosticMessage(diagnostic: TypeScriptDiagnostic): string {
  const messages: string[] = [diagnostic.text];
  const append = (items: readonly TypeScriptDiagnostic[] | undefined): void => {
    if (items === undefined) return;
    for (const item of items) {
      messages.push(item.text);
      append(item.messageChain);
    }
  };
  append(diagnostic.messageChain);
  return messages.join(" ");
}

function runDefaultTypeCheck(context: ChzRealizeContext): VerificationOutput {
  const files = context.scope === undefined
    ? collectTypeScriptFiles(context.outputDir)
    : collectScopeFiles(context.outputDir, context.scope.symbolNames);
  if (files.length === 0) return { passed: true, diagnostics: [] };

  return withTypeScriptProgram(context.projectRoot, files, (program) => {
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getBindDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    const seen = new Set<string>();
    const rendered: ChzDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const position = positionForDiagnostic(program, diagnostic);
      const item: ChzDiagnostic = {
        ...position,
        code: `TS${diagnostic.code}`,
        message: flattenDiagnosticMessage(diagnostic),
        severity: diagnosticSeverity(diagnostic.category),
      };
      const key = `${item.file}:${item.line}:${item.col}:${item.code}:${item.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        rendered.push(item);
      }
    }
    return {
      passed: !rendered.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics: rendered,
    };
  });
}

function lintDiagnostic(
  sourceFile: SourceFile,
  node: Node,
  code: string,
  message: string,
): ChzDiagnostic {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: sourceFile.fileName,
    line: position.line + 1,
    col: position.character + 1,
    code,
    message,
    severity: "error",
  };
}

function importsEpilogue(moduleName: string): boolean {
  return moduleName.split(/[\\/]/).some((segment) =>
    /^__epilogue__(?:\.[cm]?[jt]sx?)?$/.test(segment),
  );
}

const CONSOLE_FORBIDDEN_MODULES = new Set([
  "dgram",
  "dns",
  "http",
  "http2",
  "https",
  "net",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:net",
  "node:tls",
  "tls",
]);

function isForbiddenConsoleModule(moduleName: string): boolean {
  return [...CONSOLE_FORBIDDEN_MODULES].some(
    (forbidden) => moduleName === forbidden || moduleName.startsWith(`${forbidden}/`),
  );
}

function isGlobalNetworkApi(expression: Node, name: "fetch" | "WebSocket"): boolean {
  if (isIdentifier(expression)) return expression.text === name;
  return (
    isPropertyAccessExpression(expression) &&
    isIdentifier(expression.expression) &&
    ["global", "globalThis", "self", "window"].includes(expression.expression.text) &&
    expression.name.text === name
  );
}

function usesConsoleForbiddenNetworkApi(node: Node): boolean {
  if (isCallExpression(node)) {
    return isGlobalNetworkApi(node.expression, "fetch") || isGlobalNetworkApi(node.expression, "WebSocket");
  }
  return isNewExpression(node) && isGlobalNetworkApi(node.expression, "WebSocket");
}

function lintSourceFile(
  sourceFile: SourceFile,
  checker: Checker,
  activeProfile: string,
): ChzDiagnostic[] {
  const diagnostics: ChzDiagnostic[] = [];
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      diagnostics.push(
        lintDiagnostic(
          sourceFile,
          node.expression,
          "no-eval",
          "eval is not allowed in realized code. Replace it with explicit, statically analyzable logic.",
        ),
      );
    }
    if (node.kind === SyntaxKind.AnyKeyword) {
      diagnostics.push(
        lintDiagnostic(
          sourceFile,
          node,
          "no-explicit-any",
          "Explicit any is not allowed in realized code. Use a precise type or unknown with narrowing.",
        ),
      );
    }
    const moduleName = moduleReferenceForNode(node, checker)?.specifier?.text;
    if (moduleName !== undefined && importsEpilogue(moduleName)) {
      diagnostics.push(
        lintDiagnostic(
          sourceFile,
          node,
          "no-epilogue-import",
          "Realized code must not import __epilogue__. Import human-owned dependencies from __prologue__ instead.",
        ),
      );
    }
    if (activeProfile === "console" && moduleName !== undefined && isForbiddenConsoleModule(moduleName)) {
      diagnostics.push(
        lintDiagnostic(
          sourceFile,
          node,
          "profile-console",
          `The console profile does not allow network module '${moduleName}'. Remove the network access or choose a profile that grants it.`,
        ),
      );
    }
    if (
      activeProfile === "console" &&
      usesConsoleForbiddenNetworkApi(node)
    ) {
      diagnostics.push(
        lintDiagnostic(
          sourceFile,
          node,
          "profile-console",
          "The console profile does not allow network APIs. Remove the network access or choose a profile that grants it.",
        ),
      );
    }
    node.forEachChild((child) => visit(child));
  };
  visit(sourceFile);
  return diagnostics;
}

function runDefaultLinter(context: ChzRealizeContext): VerificationOutput {
  const candidates = context.scope === undefined
    ? collectTypeScriptFiles(context.outputDir)
    : collectScopeFiles(context.outputDir, context.scope.symbolNames);
  const files = candidates.filter((file) => isModelAuthoredFile(context.outputDir, file));
  if (files.length === 0) return { passed: true, diagnostics: [] };

  return withTypeScriptProgram(context.projectRoot, files, (program, checker) => {
    const diagnostics = files.flatMap((file) => {
      const sourceFile = program.getSourceFile(file);
      return sourceFile === undefined
        ? []
        : lintSourceFile(sourceFile, checker, context.activeProfile);
    });
    return { passed: diagnostics.length === 0, diagnostics };
  });
}

export async function runSelectedTests(
  outputDir: string,
  selectedTestFiles: readonly string[],
): Promise<ChzVerificationResult & { testFiles: string[]; testCount: number | null; timedOut: boolean }> {
  if (selectedTestFiles.length === 0) {
    const outcome = await runRealizationTests(outputDir);
    return {
      passed: outcome.passed,
      output: outcome.output,
      testFiles: outcome.testFiles,
      testCount: outcome.testCount,
      timedOut: outcome.timedOut,
    };
  }

  for (const file of selectedTestFiles) {
    if (!existsSync(file)) {
      throw new Error(`Test file not found: ${file}. Check the path and call RunTests again.`);
    }
    if (!statSync(file).isFile()) {
      throw new Error(`Test path is not a file: ${file}. Choose a test file and call RunTests again.`);
    }
  }

  const wrapperRoot = mkdtempSync(join(tmpdir(), "chz-realizer-tests-"));
  const wrapperTests = join(wrapperRoot, "tests");
  mkdirSync(wrapperTests, { recursive: true });
  try {
    selectedTestFiles.forEach((testFile, index) => {
      let modulePath = relative(wrapperTests, testFile).split(sep).join("/");
      if (!modulePath.startsWith(".")) modulePath = `./${modulePath}`;
      writeFileSync(
        join(wrapperTests, `test_selected_${index + 1}.autogen.ts`),
        `import ${JSON.stringify(modulePath)};\n`,
        "utf8",
      );
    });
    const outcome = await runRealizationTests(wrapperRoot);
    return {
      passed: outcome.passed,
      output: `Target test files:\n${selectedTestFiles.join("\n")}\n\n${outcome.output}`,
      testFiles: [...selectedTestFiles],
      testCount: outcome.testCount,
      timedOut: outcome.timedOut,
    };
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true });
  }
}

/** Runtime for the three fixed verification tools from docs/63. */
export class ChzVerificationToolRuntime {
  constructor(
    private readonly context: ChzRealizeContext,
    private readonly resolveOutputPath: (path: string) => string,
  ) {}

  async execute(name: string, input: unknown): Promise<string | null> {
    if (name === "RunTests") {
      const parsed = parseRunTestsInput(input);
      let testFiles = parsed.testFiles.map((path) => this.resolveOutputPath(path));
      // An empty selection means "the whole verification scope": in a scoped
      // session that is the session's own test files, so a symbol is never
      // judged red on another symbol's unfinished suite.
      if (testFiles.length === 0 && this.context.scope !== undefined) {
        const { outputDir, scope } = this.context;
        const missingAutogen = scope.symbolNames.filter(
          (symbolName) => !existsSync(scopeAutogenTestPath(outputDir, symbolName)),
        );
        if (missingAutogen.length > 0) {
          return render({
            passed: false,
            output: missingAutogen
              .map((symbolName) =>
                `no autogen test file (tests/test_${symbolName}.autogen.ts) found under ${outputDir}. Write the symbol's unit tests, then run the tests again.`,
              )
              .join("\n"),
          });
        }
        testFiles = collectScopeTestFiles(outputDir, scope.symbolNames);
      }
      const injected = this.context.harness?.runTests;
      if (injected !== undefined) return render(await injected(testFiles));
      return render(await runSelectedTests(this.context.outputDir, testFiles));
    }

    if (name === "RunTypeCheck") {
      parseNoArgumentInput(input, name);
      const injected = this.context.harness?.runTypeCheck;
      if (injected !== undefined) return render(await injected());
      return render(runDefaultTypeCheck(this.context));
    }

    if (name === "RunLinter") {
      parseNoArgumentInput(input, name);
      const injected = this.context.harness?.runLinter;
      if (injected !== undefined) return render(await injected());
      return render(runDefaultLinter(this.context));
    }

    return null;
  }
}
