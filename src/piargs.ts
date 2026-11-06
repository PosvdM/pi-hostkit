import { resolveSessionArgPath } from "./paths.js";

// Mirror of pi 1.5.0 `parseArgs` (dist/cli/args.js): which arguments consume
// a value, `--` ending options, `@file` arguments and unknown flags. Only the
// fields hostkit needs are kept. test/piargs.test.mjs compares it with pi's
// own parser; run it before supporting a new pi version.

export interface PiArgs {
  mode?: string;
  session?: string;
  sessionId?: string;
  fork?: string;
  continue?: boolean;
  resume?: boolean;
  noSession?: boolean;
  help?: boolean;
  version?: boolean;
  print?: boolean;
  export?: string;
  listModels?: string | true;
  /** Parser errors pi would report (pi exits on them). */
  errors: string[];
}

// Options that take the next argument when one is present (`--x` with `i + 1 < length`).
const VALUE_IF_PRESENT = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

const FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--no-session",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);

export function parsePiArgs(args: readonly string[]): PiArgs {
  const result: PiArgs = { errors: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break; // everything after is a message or @file
    if (arg === "--mode") {
      const mode = args[i + 1];
      if (mode === undefined || mode.startsWith("-")) {
        result.errors.push("--mode requires text, json, or rpc");
        continue;
      }
      i++;
      if (mode !== "text" && mode !== "json" && mode !== "rpc") {
        result.errors.push(`Invalid mode "${mode}"`);
        continue;
      }
      result.mode = mode;
    } else if (arg === "--name" || arg === "-n") {
      if (i + 1 < args.length) i++;
      else result.errors.push("--name requires a value");
    } else if (VALUE_IF_PRESENT.has(arg) && i + 1 < args.length) {
      const value = args[++i]!;
      if (arg === "--session") result.session = value;
      else if (arg === "--session-id") result.sessionId = value;
      else if (arg === "--fork") result.fork = value;
      else if (arg === "--export") result.export = value;
    } else if (FLAGS.has(arg)) {
      if (arg === "--help" || arg === "-h") result.help = true;
      else if (arg === "--version" || arg === "-v") result.version = true;
      else if (arg === "--continue" || arg === "-c") result.continue = true;
      else if (arg === "--resume" || arg === "-r") result.resume = true;
      else if (arg === "--no-session") result.noSession = true;
    } else if (arg === "--print" || arg === "-p") {
      result.print = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) i++;
    } else if (arg === "--use-theme") {
      const name = args[i + 1];
      if (name === undefined || name.startsWith("-")) result.errors.push("--use-theme requires a theme name");
      else i++;
    } else if (arg === "--list-models") {
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-") && !args[i + 1]!.startsWith("@")) result.listModels = args[++i]!;
      else result.listModels = true;
    } else if (arg === "--tui-mode") {
      const mode = args[i + 1];
      if (mode === undefined || mode.startsWith("-")) result.errors.push("--tui-mode requires regular or fullscreen");
      else {
        i++;
        if (mode !== "regular" && mode !== "fullscreen") result.errors.push(`Invalid TUI mode "${mode}"`);
      }
    } else if (arg.startsWith("@")) {
      // file argument
    } else if (arg.startsWith("--")) {
      // Unknown (extension) flag: `--x=value`, or `--x value` when the next
      // argument is not an option or @file.
      if (arg.indexOf("=") === -1) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i++;
      }
    } else if (arg.startsWith("-")) {
      result.errors.push(`Unknown option: ${arg}`);
    }
    // anything else is a message
  }
  return result;
}

/**
 * The session file a pi started with `args` in `cwd` opens for writing in RPC
 * mode, following pi 1.5.0 `createSessionManager`. Returns undefined when pi
 * would not run as an RPC writer of a file given by path: not RPC mode, parser
 * errors, `--no-session`, `--help`, `--version`, `--export`, `--list-models`,
 * `--fork`, no `--session`, or a `--session` value that pi treats as a
 * session id instead of a path. `cwd` may be undefined when unknown; a
 * relative path then yields `{ relative: true }`.
 */
export function rpcSessionFile(args: readonly string[], cwd: string | undefined): { file?: string; relative?: true } {
  const p = parsePiArgs(args);
  if (p.errors.length || p.mode !== "rpc") return {};
  if (p.noSession || p.help || p.version || p.export !== undefined || p.listModels !== undefined || p.fork !== undefined) return {};
  if (p.session === undefined) return {};
  // pi treats the value as a path when it contains a separator or ends in .jsonl; otherwise as a session id.
  if (!(p.session.includes("/") || p.session.includes("\\") || p.session.endsWith(".jsonl"))) return {};
  const resolved = resolveSessionArgPath(p.session, cwd);
  return resolved === undefined ? { relative: true } : { file: resolved };
}

/** True when `args` contain no option that makes pi pick a session other than `--session`. */
export function hasOnlyExplicitSession(args: readonly string[]): boolean {
  const p = parsePiArgs(args);
  return !p.continue && !p.resume && p.sessionId === undefined && !p.print;
}
