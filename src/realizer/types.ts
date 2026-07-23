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

/**
 * Engine-owned operations exposed to the fixed verification tools. These
 * callbacks never accept a shell command from the model.
 */
export interface ChzHarnessServices {
  runTests?: (testFiles: string[]) => Promise<ChzVerificationResult>;
  runTypeCheck?: () => Promise<ChzVerificationResult>;
  runLinter?: () => Promise<ChzVerificationResult>;
  diagnoseFile?: (file: string) => Promise<ChzDiagnostic[]>;
  onEvent?: (message: string) => void;
  /** Receives provider-supplied reasoning text for human-only diagnostics. */
  onModelReasoning?: (message: string) => void;
}

export interface ChzRealizeContext {
  projectRoot: string;
  outputDir: string;
  activeProfile: string;
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
}
