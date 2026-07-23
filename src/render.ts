/**
 * Terminal renderers for `chz realize` progress (all on stderr).
 *
 * - Audit (default): the full event stream, one line per event, styled when
 *   colors are available. Auditability outranks looks: every tool call and
 *   every piece of model reasoning stays visible.
 * - Live (`--simplify-output` on a TTY): a buildx-style compact view — one
 *   in-place updating line per running group, completed groups scroll up as
 *   permanent `[ OK ]`/`[FAIL]` lines.
 * - Plain (`--simplify-output` without a TTY): completed-group lines only;
 *   no cursor control, safe for pipes and CI logs.
 */

import pc from "picocolors";

import type { ChzGroupStatus, ChzHarnessEvent } from "./realizer/types.ts";

export interface ChzRenderer {
  event(event: ChzHarnessEvent): void;
  /** Clear the live region before an interactive prompt takes the terminal. */
  suspend(): void;
  /** Redraw the live region after the prompt released the terminal. */
  resume(): void;
  /** Final flush; leaves the cursor on a fresh line below all output. */
  close(): void;
}

export interface ChzRendererOptions {
  /** --simplify-output: compact live view instead of the full audit stream. */
  simplify: boolean;
  /** Line sink for the stream renderers (a newline is appended per call). */
  err: (line: string) => void;
  /** Raw TTY for the live view; absent (non-TTY) falls back to plain lines. */
  tty?: { write: (chunk: string) => unknown; columns?: number };
  /** Enable ANSI colors (the caller detects TTY, NO_COLOR, and TERM). */
  color: boolean;
}

export function createRenderer(options: ChzRendererOptions): ChzRenderer {
  if (options.simplify) {
    return options.tty === undefined
      ? new PlainRenderer(options.err)
      : new LiveRenderer(options.tty, options.color);
  }
  return new AuditRenderer(options.err, options.color);
}

type Colors = ReturnType<typeof pc.createColors>;

const STATUS_BADGE: Record<ChzGroupStatus, string> = {
  resolved: " OK ",
  reused: " OK ",
  failed: "FAIL",
  blocked: "BLCK",
  skipped: "SKIP",
};

function statusColor(c: Colors, status: ChzGroupStatus): (text: string) => string {
  switch (status) {
    case "resolved":
    case "reused":
      return c.green;
    case "failed":
      return c.red;
    case "blocked":
      return c.magenta;
    case "skipped":
      return c.yellow;
  }
}

const ENGINE_PREFIX = "[chz-realize] ";

function styleEngineLine(c: Colors, text: string): string {
  return text.startsWith(ENGINE_PREFIX)
    ? `${c.cyan(ENGINE_PREFIX.trimEnd())} ${text.slice(ENGINE_PREFIX.length)}`
    : c.cyan(text);
}

class AuditRenderer implements ChzRenderer {
  readonly #err: (line: string) => void;
  readonly #c: Colors;

  constructor(err: (line: string) => void, color: boolean) {
    this.#err = err;
    this.#c = pc.createColors(color);
  }

  event(event: ChzHarnessEvent): void {
    const c = this.#c;
    switch (event.kind) {
      case "reasoning": {
        const turns = event.turn === undefined ? "" : ` turn ${event.turn}/${event.maxTurns ?? "?"}`;
        const header = `[${event.realizer ?? "model"}] reasoning${turns}`;
        this.#err(c.gray(header));
        for (const line of event.text.split("\n")) this.#err(c.gray(c.italic(`    ${line}`)));
        break;
      }
      case "turn":
        this.#err(c.dim(event.text));
        break;
      case "tool":
        this.#err(this.#toolLine(event));
        break;
      case "diff":
        for (const line of event.text.split("\n")) this.#err(c.dim(line));
        break;
      case "group-start":
        this.#err(c.bold(styleEngineLine(c, event.text)));
        break;
      case "group-end":
        this.#err(
          event.status === undefined ? event.text : statusColor(c, event.status)(event.text),
        );
        break;
      case "engine":
        this.#err(styleEngineLine(c, event.text));
        break;
      default:
        this.#err(event.text);
    }
  }

  #toolLine(event: ChzHarnessEvent): string {
    const c = this.#c;
    if (event.tool === undefined || event.outcome === undefined) return event.text;
    const outcome = event.errored || /^(error|failed)/.test(event.outcome)
      ? c.red(event.outcome)
      : /^(ok|passed|finished|answered)/.test(event.outcome)
        ? c.green(event.outcome)
        : c.yellow(event.outcome);
    const prefix = event.realizer === undefined ? "" : `${c.dim(`[${event.realizer}]`)} `;
    const detail = event.toolDetail === undefined ? "" : c.dim(`(${event.toolDetail})`);
    const duration = event.durationMs === undefined ? "" : ` ${c.dim(`· ${event.durationMs}ms`)}`;
    return `${prefix}${c.bold(event.tool)}${detail} → ${outcome}${duration}`;
  }

  suspend(): void {}
  resume(): void {}
  close(): void {}
}

/** --simplify-output without a TTY: group results only, no cursor control. */
class PlainRenderer implements ChzRenderer {
  readonly #err: (line: string) => void;

  constructor(err: (line: string) => void) {
    this.#err = err;
  }

  event(event: ChzHarnessEvent): void {
    if (event.kind === "group-end") this.#err(event.text);
    // Group-scoped noise is the point of -s; keep only global engine notes
    // (dependency-cycle warnings and the like).
    else if (event.kind === "engine" && event.group === undefined) this.#err(event.text);
  }

  suspend(): void {}
  resume(): void {}
  close(): void {}
}

interface LiveEntry {
  index?: number;
  total?: number;
  label: string;
  note: string;
  /** Session turn counter, shown as a prefix so it never evicts the note. */
  turn?: number;
  maxTurns?: number;
}

class LiveRenderer implements ChzRenderer {
  readonly #tty: { write: (chunk: string) => unknown; columns?: number };
  readonly #c: Colors;
  /** Insertion order is display order: one line per running group. */
  readonly #active = new Map<string, LiveEntry>();
  #drawn = 0;
  #suspended = false;
  /** Permanent lines produced while an interactive prompt owned the TTY. */
  readonly #queued: string[] = [];

  constructor(tty: { write: (chunk: string) => unknown; columns?: number }, color: boolean) {
    this.#tty = tty;
    this.#c = pc.createColors(color);
  }

  event(event: ChzHarnessEvent): void {
    switch (event.kind) {
      case "group-start":
        if (event.group !== undefined) {
          this.#active.set(event.group, {
            ...(event.index === undefined ? {} : { index: event.index }),
            ...(event.total === undefined ? {} : { total: event.total }),
            label: event.label ?? event.group,
            note: "starting…",
          });
          this.#repaint();
        }
        break;
      case "group-end":
        if (event.group !== undefined) this.#active.delete(event.group);
        this.#permanent(this.#endLine(event));
        break;
      case "turn":
        // The turn counter has its own slot in the line prefix; overwriting
        // the note here would wipe the last reasoning/tool glimpse instantly.
        this.#turn(event);
        break;
      case "tool":
        this.#note(
          event,
          `⚒ ${event.tool ?? "tool"}${event.toolDetail === undefined ? "" : `(${event.toolDetail})`}`,
        );
        break;
      case "reasoning":
        this.#note(event, `💭 ${event.text.split("\n", 1)[0] ?? ""}`);
        break;
      case "diff":
        // The FindAndReplace tool event already updated this group's note.
        break;
      case "engine":
        if (event.group !== undefined && this.#active.has(event.group)) {
          const text = event.text.startsWith(ENGINE_PREFIX)
            ? event.text.slice(ENGINE_PREFIX.length)
            : event.text;
          this.#note(event, text);
        } else {
          this.#permanent(styleEngineLine(this.#c, event.text));
        }
        break;
    }
  }

  suspend(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    if (this.#drawn > 0) {
      this.#tty.write(`\x1b[${this.#drawn}A\r\x1b[0J`);
      this.#drawn = 0;
    }
  }

  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.#repaint(this.#queued.splice(0));
  }

  close(): void {
    // On an abnormal end (exception path) running-group lines would go stale;
    // clear them so error output starts on a clean line.
    this.#suspended = false;
    this.#active.clear();
    this.#repaint(this.#queued.splice(0));
  }

  #note(event: ChzHarnessEvent, note: string): void {
    if (event.group === undefined) return;
    const entry = this.#active.get(event.group);
    if (entry === undefined) return;
    entry.note = note.replace(/\s+/g, " ").trim();
    if (event.turn !== undefined) {
      entry.turn = event.turn;
      if (event.maxTurns !== undefined) entry.maxTurns = event.maxTurns;
    }
    this.#repaint();
  }

  #turn(event: ChzHarnessEvent): void {
    if (event.group === undefined || event.turn === undefined) return;
    const entry = this.#active.get(event.group);
    if (entry === undefined) return;
    entry.turn = event.turn;
    if (event.maxTurns !== undefined) entry.maxTurns = event.maxTurns;
    this.#repaint();
  }

  #permanent(line: string): void {
    if (this.#suspended) {
      this.#queued.push(line);
      return;
    }
    this.#repaint([line]);
  }

  #endLine(event: ChzHarnessEvent): string {
    const c = this.#c;
    if (event.status === undefined) return event.text;
    const badge = statusColor(c, event.status)(`[${STATUS_BADGE[event.status]}]`);
    const counter = event.index === undefined ? "" : `[${event.index}/${event.total ?? "?"}] `;
    const detail = event.detail === undefined ? "" : c.dim(` — ${event.detail}`);
    return `${counter}${badge} ${event.label ?? event.group ?? ""}${detail}`;
  }

  #repaint(permanent: readonly string[] = []): void {
    if (this.#suspended) {
      this.#queued.push(...permanent);
      return;
    }
    let out = "";
    if (this.#drawn > 0) out += `\x1b[${this.#drawn}A\r\x1b[0J`;
    for (const line of permanent) out += `${line}\n`;
    // A pty may report 0 columns; treat missing/zero as a standard 80.
    const width = Math.max(20, this.#tty.columns || 80);
    const lines = [...this.#active.values()].map((entry) => this.#liveLine(entry, width));
    if (lines.length > 0) out += `${lines.join("\n")}\n`;
    this.#drawn = lines.length;
    if (out !== "") this.#tty.write(out);
  }

  #liveLine(entry: LiveEntry, width: number): string {
    const c = this.#c;
    const counter = entry.index === undefined ? "" : `[${entry.index}/${entry.total ?? "?"}] `;
    const turns = entry.turn === undefined ? "" : `[${entry.turn}/${entry.maxTurns ?? "?"}] `;
    const label = truncateToWidth(entry.label, 40);
    const plainPrefix = `${counter}[ .. ] ${turns}${label}: `;
    const note = truncateToWidth(entry.note, Math.max(0, width - 1 - displayWidth(plainPrefix)));
    return `${counter}${c.cyan("[ .. ]")} ${turns === "" ? "" : c.dim(turns)}${c.bold(label)}: ${c.dim(note)}`;
  }
}

/**
 * Rough wcwidth for line-budget math: CJK, Hangul, fullwidth forms, and
 * emoji occupy two terminal columns; zero-width joiners/selectors none.
 */
function charWidth(codePoint: number): number {
  if (codePoint === 0xfe0f || codePoint === 0x200d || (codePoint >= 0x200b && codePoint <= 0x200f)) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0)!);
  return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return maxWidth === 1 ? "…" : "";
  let width = 0;
  let out = "";
  for (const character of text) {
    const characterWidth = charWidth(character.codePointAt(0)!);
    if (width + characterWidth > maxWidth - 1) break;
    out += character;
    width += characterWidth;
  }
  return `${out}…`;
}
