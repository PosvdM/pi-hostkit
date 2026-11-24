import { environmentIndependentPath } from "./paths.js";

// 照搬 pi `parseArgs`（dist/cli/args.js）的规则：哪些参数取下一个值、`--` 结束选项、
// `@file` 参数和未知选项，只保留 hostkit 需要的字段。pi 1.5.0 和 1.6.0 的 args.js 只有
// 帮助文本不同。test/piargs.test.mjs 与所装 pi 的解析器逐项比对，支持新的 pi 版本前先跑它。

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
  /** Number of `@file` arguments (pi refuses them in RPC mode). */
  fileArgs: number;
  /** Parser errors pi would report (pi exits on them). */
  errors: string[];
}

/** pi `getToolListError`（dist/core/settings-manager.js，1.5.0 和 1.6.0 相同）。 */
function toolListError(entries: string[]): string | undefined {
  const modifiers = entries.filter((e) => e.startsWith("+") || e.startsWith("-"));
  if (modifiers.length === 0) return undefined;
  if (modifiers.length < entries.length) return "tool names cannot be mixed with +name or -name entries";
  const pattern = modifiers.find((e) => e.includes("*"));
  return pattern ? `+name and -name entries take exact tool names, not patterns: ${pattern}` : undefined;
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
  const result: PiArgs = { errors: [], fileArgs: 0 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      // everything after is a message or @file
      result.fileArgs += args.slice(i + 1).filter((a) => a.startsWith("@")).length;
      break;
    }
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
      if (arg === "--tools" || arg === "-t") {
        const error = toolListError(value.split(",").map((t) => t.trim()).filter((t) => t.length > 0));
        if (error) result.errors.push(`${arg}: ${error}`);
      } else if (arg === "--session") result.session = value;
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
      result.fileArgs++;
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
 * 按 pi 1.5.0 和 1.6.0 的 `main`、`createSessionManager`，求以 `args` 启动的 pi 在
 * RPC 模式下写入的会话文件。pi 不会以 RPC 模式写入按路径给出的文件时返回 `{}`：
 * 解析出错、`--version`、`--export`、不是 RPC 模式、RPC 模式下有 `@file` 参数、
 * `--fork`、`--session-id` 与 `--session` 同时出现、`--no-session`、`--help`、
 * `--list-models`、没有 `--session`，或 pi 把该值当作会话 id。该值是含义取决于
 * pi 进程的路径（相对路径、`~`、Windows 无盘符路径）时返回 `{ uncertain: true }`。
 */
export function rpcSessionFile(args: readonly string[]): { file?: string; uncertain?: true } {
  const p = parsePiArgs(args);
  if (p.errors.length || p.version || p.export !== undefined || p.mode !== "rpc" || p.fileArgs > 0) return {};
  if (p.fork !== undefined || (p.sessionId !== undefined && p.session !== undefined)) return {};
  if (p.noSession || p.help || p.listModels !== undefined || p.session === undefined) return {};
  // pi treats the value as a path when it contains a separator or ends in .jsonl; otherwise as a session id.
  if (!(p.session.includes("/") || p.session.includes("\\") || p.session.endsWith(".jsonl"))) return {};
  const file = environmentIndependentPath(p.session);
  return file === undefined ? { uncertain: true } : { file };
}

/** True when `args` contain no option that makes pi pick a session other than `--session`. */
export function hasOnlyExplicitSession(args: readonly string[]): boolean {
  const p = parsePiArgs(args);
  return !p.continue && !p.resume && p.sessionId === undefined && !p.print;
}
