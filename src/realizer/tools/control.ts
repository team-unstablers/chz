import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ChzAskUserAnswer,
  ChzAskUserQuestion,
  ChzImagineSymbol,
  ChzRealizeContext,
} from "../types.ts";

export type ChzTerminalState =
  | { kind: "finish" }
  | { kind: "blocked"; reason: string; todo: string }
  | { kind: "aborted"; reason: string };

export interface ChzControlToolResult {
  output: string;
  terminal?: ChzTerminalState;
}

type KnownControlTool = "AskUser" | "Finish" | "Block" | "Abort";

const KNOWN_CONTROL_TOOLS = new Set<KnownControlTool>([
  "AskUser",
  "Finish",
  "Block",
  "Abort",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(detail: string): ChzControlToolResult {
  return {
    output: `Invalid tool input: ${detail}. Please rewrite the input so it satisfies the expected schema.`,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateQuestions(input: unknown):
  | { questions: ChzAskUserQuestion[] }
  | { error: ChzControlToolResult } {
  if (!isRecord(input) || !hasOnlyKeys(input, ["questions"])) {
    return { error: invalidInput("AskUser expects an object containing only questions") };
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return { error: invalidInput("questions must be a non-empty array") };
  }

  const questions: ChzAskUserQuestion[] = [];
  for (const [questionIndex, candidate] of input.questions.entries()) {
    const location = `questions[${questionIndex}]`;
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["question", "header", "options", "multiple"])) {
      return { error: invalidInput(`${location} contains an unsupported field`) };
    }
    if (!nonEmptyString(candidate.question)) {
      return { error: invalidInput(`${location}.question must be a non-empty string`) };
    }
    if (!nonEmptyString(candidate.header)) {
      return { error: invalidInput(`${location}.header must be a non-empty string`) };
    }
    if ([...candidate.header].length > 30) {
      return { error: invalidInput(`${location}.header must contain at most 30 characters`) };
    }
    if (!Array.isArray(candidate.options) || candidate.options.length < 2) {
      return { error: invalidInput(`${location}.options must contain at least 2 choices`) };
    }
    if (candidate.multiple !== undefined && typeof candidate.multiple !== "boolean") {
      return { error: invalidInput(`${location}.multiple must be a boolean when provided`) };
    }

    const options: ChzAskUserQuestion["options"] = [];
    for (const [optionIndex, option] of candidate.options.entries()) {
      const optionLocation = `${location}.options[${optionIndex}]`;
      if (!isRecord(option) || !hasOnlyKeys(option, ["label", "description"])) {
        return { error: invalidInput(`${optionLocation} contains an unsupported field`) };
      }
      if (!nonEmptyString(option.label)) {
        return { error: invalidInput(`${optionLocation}.label must be a non-empty string`) };
      }
      if (!nonEmptyString(option.description)) {
        return { error: invalidInput(`${optionLocation}.description must be a non-empty string`) };
      }
      // Labels of one to five words are recommended by the tool description,
      // but docs/63 deliberately makes only header/options lengths schema gates.
      options.push({ label: option.label, description: option.description });
    }

    questions.push({
      question: candidate.question,
      header: candidate.header,
      options,
      multiple: candidate.multiple ?? false,
    });
  }

  return { questions };
}

function validateAnswers(
  questions: readonly ChzAskUserQuestion[],
  answers: unknown,
): asserts answers is ChzAskUserAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new Error(
      `AskUser service returned invalid answers: expected ${questions.length} answer arrays, received ${Array.isArray(answers) ? answers.length : "a non-array value"}.`,
    );
  }

  for (const [index, answer] of answers.entries()) {
    if (!Array.isArray(answer) || !answer.every((value) => typeof value === "string")) {
      throw new Error(`AskUser service returned invalid answers: answer ${index + 1} must be a string array.`);
    }
    if (!questions[index]!.multiple && answer.length > 1) {
      throw new Error(
        `AskUser service returned invalid answers: question ${index + 1} allows only one answer.`,
      );
    }
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderAnswers(
  questions: readonly ChzAskUserQuestion[],
  answers: readonly ChzAskUserAnswer[],
): string {
  const pairs = questions.map((question, index) => {
    const answer = answers[index]!;
    const renderedAnswer = answer.length === 0 ? "Unanswered" : answer.join(", ");
    return `${JSON.stringify(question.question)}=${JSON.stringify(renderedAnswer)}`;
  });
  return `User has answered your questions: ${pairs.join("; ")}. You can now continue with the user's answers in mind.`;
}

function terminalName(terminal: ChzTerminalState): string {
  switch (terminal.kind) {
    case "finish":
      return "Finish";
    case "blocked":
      return "Block";
    case "aborted":
      return "Abort";
  }
}

/** Engine-owned implementation of the conversation and terminal harness tools. */
export class ChzControlToolRuntime {
  readonly #symbol: ChzImagineSymbol;
  readonly #context: ChzRealizeContext;
  #terminal: ChzTerminalState | undefined;

  constructor(symbol: ChzImagineSymbol, context: ChzRealizeContext) {
    this.#symbol = symbol;
    this.#context = context;
  }

  async execute(name: string, input: unknown): Promise<ChzControlToolResult | null> {
    if (!KNOWN_CONTROL_TOOLS.has(name as KnownControlTool)) {
      return null;
    }
    if (this.#terminal !== undefined) {
      return {
        output: `Session has already ended with ${terminalName(this.#terminal)}. Do not call another tool.`,
        terminal: this.#terminal,
      };
    }

    switch (name as KnownControlTool) {
      case "AskUser":
        return this.#askUser(input);
      case "Finish":
        return this.#finish(input);
      case "Block":
        return this.#block(input);
      case "Abort":
        return this.#abort(input);
    }
  }

  async #askUser(input: unknown): Promise<ChzControlToolResult> {
    const parsed = validateQuestions(input);
    if ("error" in parsed) {
      return parsed.error;
    }

    const askUser = this.#context.askUser;
    if (askUser === undefined) {
      return this.#blockForQuestions(parsed.questions);
    }

    let answers: ChzAskUserAnswer[];
    try {
      answers = await askUser(parsed.questions);
    } catch {
      return this.#blockForQuestions(parsed.questions);
    }
    validateAnswers(parsed.questions, answers);
    await this.#recordAnswers(parsed.questions, answers);
    return { output: renderAnswers(parsed.questions, answers) };
  }

  #finish(input: unknown): ChzControlToolResult {
    if (!isRecord(input) || Object.keys(input).length !== 0) {
      return invalidInput("Finish expects an empty object");
    }
    const terminal: ChzTerminalState = { kind: "finish" };
    this.#terminal = terminal;
    return {
      output: "Completion claimed. The engine will now run independent verification.",
      terminal,
    };
  }

  #block(input: unknown): ChzControlToolResult {
    if (!isRecord(input) || !hasOnlyKeys(input, ["reason", "todo"])) {
      return invalidInput("Block expects an object containing only reason and todo");
    }
    if (!nonEmptyString(input.reason)) {
      return invalidInput("Block.reason must be a non-empty string");
    }
    if (!nonEmptyString(input.todo)) {
      return invalidInput("Block.todo must be a non-empty string");
    }
    const terminal: ChzTerminalState = {
      kind: "blocked",
      reason: input.reason,
      todo: input.todo,
    };
    this.#terminal = terminal;
    return {
      output: `Session blocked: ${input.reason}\nTODO: ${input.todo}`,
      terminal,
    };
  }

  #abort(input: unknown): ChzControlToolResult {
    if (!isRecord(input) || !hasOnlyKeys(input, ["reason"])) {
      return invalidInput("Abort expects an object containing only reason");
    }
    if (!nonEmptyString(input.reason)) {
      return invalidInput("Abort.reason must be a non-empty string");
    }
    const terminal: ChzTerminalState = { kind: "aborted", reason: input.reason };
    this.#terminal = terminal;
    return {
      output: `Session aborted: ${input.reason}`,
      terminal,
    };
  }

  #blockForQuestions(questions: readonly ChzAskUserQuestion[]): ChzControlToolResult {
    const summaries = questions
      .map((question) => `[${oneLine(question.header)}] ${oneLine(question.question)}`)
      .join(" | ");
    const terminal: ChzTerminalState = {
      kind: "blocked",
      reason: "User input is required, but this realize session is non-interactive.",
      todo: `Answer these questions and rerun chz realize: ${summaries}`,
    };
    this.#terminal = terminal;
    return {
      output: `AskUser is unavailable in this non-interactive session. ${terminal.todo}`,
      terminal,
    };
  }

  async #recordAnswers(
    questions: readonly ChzAskUserQuestion[],
    answers: readonly ChzAskUserAnswer[],
  ): Promise<void> {
    const recordedAt = (this.#context.now ? this.#context.now() : new Date()).toISOString();
    const entries = questions.flatMap((question, index) => {
      const answer = answers[index]!;
      const renderedAnswer = answer.length === 0 ? "Unanswered" : answer.join(", ");
      return [
        `- **Q**: ${oneLine(question.question)}`,
        `- **A**: ${oneLine(renderedAnswer)} (${recordedAt})`,
      ];
    });
    const contextsPath = join(this.#context.outputDir, "CONTEXTS.md");
    await mkdir(this.#context.outputDir, { recursive: true });
    let separator = "";
    try {
      const existing = await readFile(contextsPath, "utf8");
      if (existing.length > 0) {
        separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const block = `${separator}## ${oneLine(this.#symbol.name)}\n\n${entries.join("\n")}\n`;
    await appendFile(contextsPath, block, "utf8");
  }
}
