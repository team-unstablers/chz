/** Public contracts shared by the realize engine, harness, and transports. */

export type ChzImagineSymbolType = "variable" | "function" | "class" | "resource" | "module";

export interface ChzImagineSymbol {
  name: string;
  type: ChzImagineSymbolType;
  definition: string;
  file: string;
  posLine: number;
  posCol: number;
  dependencies: ChzImagineSymbol[];
  circularDependencies: ChzImagineSymbol[];
}

export interface ChzAskUserOption {
  label: string;
  description: string;
}

export interface ChzAskUserQuestion {
  question: string;
  header: string;
  options: ChzAskUserOption[];
  multiple?: boolean;
}

export type ChzAskUserAnswer = string[];

export interface ChzDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ChzVerificationResult {
  passed: boolean;
  output: string;
  testCount?: number | null;
  timedOut?: boolean;
}

export type ChzHarnessEventKind =
  | "engine"
  | "group-start"
  | "group-end"
  | "turn"
  | "tool"
  | "diff"
  | "reasoning";

export type ChzGroupStatus = "resolved" | "reused" | "failed" | "blocked" | "skipped";

/**
 * One observability event from the realize engine or a harness session.
 * `text` is always a complete plain-text rendering, so a consumer may ignore
 * every structured field and still produce a faithful audit log; the fields
 * exist for renderers that style or aggregate (e.g. the CLI live view).
 */
export interface ChzHarnessEvent {
  kind: ChzHarnessEventKind;
  /** Canonical plain-text rendering; multi-line for diff/reasoning payloads. */
  text: string;
  /** Representative symbol of the emitting realize group, when one exists. */
  group?: string;
  /** group-start/group-end: display label and 1-based launch order. */
  label?: string;
  index?: number;
  total?: number;
  /** group-end: how the group settled, with an optional one-line detail. */
  status?: ChzGroupStatus;
  detail?: string;
  /** turn/tool/reasoning: the emitting Realizer and its turn counters. */
  realizer?: string;
  turn?: number;
  maxTurns?: number;
  /** tool: executed tool name, input summary, outcome, and duration. */
  tool?: string;
  toolDetail?: string;
  outcome?: string;
  durationMs?: number;
  errored?: boolean;
}

/**
 * Engine-owned operations exposed to the fixed verification tools. These
 * callbacks never accept a shell command from the model.
 */
export interface ChzHarnessServices {
  runTests?: (testFiles: string[]) => Promise<ChzVerificationResult>;
  runTypeCheck?: () => Promise<ChzVerificationResult>;
  runLinter?: () => Promise<ChzVerificationResult>;
  diagnoseFile?: (file: string) => Promise<ChzDiagnostic[]>;
  /** Receives every observability event, including model reasoning. */
  onEvent?: (event: ChzHarnessEvent) => void;
}

/**
 * The realization files one session owns. Verification tools narrow to this
 * scope so a session is never judged on other symbols' unfinished files; an
 * SCC group realized together lists every member symbol.
 */
export interface ChzRealizationScope {
  symbolNames: readonly string[];
}

export interface ChzRealizeContext {
  projectRoot: string;
  outputDir: string;
  activeProfile: string;
  /**
   * Project-configured globs the harness must never read or write, applied on
   * top of the built-in secrets list rather than replacing it (docs/63).
   */
  blockedPaths?: readonly string[];
  /** Verification scope of this session; absent = the whole realization. */
  scope?: ChzRealizationScope;
  resolvedDependencies: ChzResolutionResolved[];
  maxTurns: number;
  maxRetries: number;
  baseContexts: string;
  askUser?: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;
  /** One-based independent-verification attempt number. */
  attempt?: number;
  /** Independent verification output from the previous attempt. */
  verificationFeedback?: string;
  /** Injectable clock for deterministic prompts, provenance, and tests. */
  now?: () => Date;
  harness?: ChzHarnessServices;
}

export interface ChzResolutionResolved {
  outcome: "resolved";
  symbol: ChzImagineSymbol;
  resolvedFile: string;
  resolvedTestFiles: string[];
  assumptionsReport?: string;
  resolvedLine?: [number, number];
  resolvedAt: Date;
  resolvedBy: string;
}

export interface ChzResolutionBlocked {
  outcome: "blocked";
  symbol: ChzImagineSymbol;
  reason: string;
  todo: string;
}

export interface ChzResolutionFailed {
  outcome: "failed";
  symbol: ChzImagineSymbol;
  reason: string;
}

export type ChzImagineSymbolResolution =
  | ChzResolutionResolved
  | ChzResolutionBlocked
  | ChzResolutionFailed;

export interface ChzRealizer {
  readonly name: string;
  readonly supportedSymbolTypes: readonly ChzImagineSymbolType[];

  realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution>;
}

export interface ChzToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChzToolCall {
  id: string;
  name: string;
  /** A parsed value or the provider's raw JSON argument string. */
  arguments: unknown;
}

export interface ChzSystemChatMessage {
  role: "system";
  content: string;
}

export interface ChzUserChatMessage {
  role: "user";
  content: string;
}

export interface ChzAssistantChatMessage {
  role: "assistant";
  content: string;
  toolCalls: ChzToolCall[];
}

export interface ChzToolChatMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type ChzChatMessage =
  | ChzSystemChatMessage
  | ChzUserChatMessage
  | ChzAssistantChatMessage
  | ChzToolChatMessage;

export interface ChzChatResponse {
  message: ChzAssistantChatMessage;
  /** Optional reasoning summary/content supplied separately by the provider. */
  reasoning?: string;
}

export interface ChzProjectConfig {
  realizers: ChzRealizer[];
  maxTurns?: number;
  maxRetries?: number;
  profile?: string;
  /** Maximum symbols one dependency cycle may contain (docs/62). */
  maxCycleSize?: number;
  /** Source globs realized by the file-less `chz realize`, project-relative. */
  include?: string[];
  /** Concurrent realize sessions (`-j`); the CLI flag overrides this. */
  jobs?: number;
  /**
   * Extra project-relative globs the harness may neither read nor write, added
   * to the built-in secrets list (docs/63). Add-only: the built-in entries
   * cannot be lifted, so `!` negation is rejected.
   */
  blockedPaths?: string[];
}
