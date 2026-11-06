import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Path rules mirror pi 1.5.0 so that a path checked here is the file pi opens:
// dist/utils/paths.js (normalizePath, resolvePath, normalizeWindowsShellPath)
// and dist/core/tools/path-utils.js (resolveToCwd, resolveReadPath).
// test/paths.test.mjs pins the behaviour; run it before supporting a new pi version.

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
const MAX_LINK_DEPTH = 40;

export type PathMode = "read" | "write";

/** Git Bash, MSYS, Cygwin and WSL drive paths (`/c/...`, `/mnt/c/...`) to `C:\...`. */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

interface NormalizeOptions {
  normalizeUnicodeSpaces?: boolean;
  stripAtPrefix?: boolean;
}

function normalizeInput(input: string, options: NormalizeOptions): string {
  let normalized = input;
  if (options.normalizeUnicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, " ");
  if (options.stripAtPrefix && normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return path.join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Resolves a tool path argument against `cwd` the way pi's `resolveToCwd` does. Does not touch the file system. */
export function resolveToolPath(input: string, cwd: string): string {
  const normalized = normalizeInput(input, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
  const base = normalizeInput(cwd, {});
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(base, normalized);
}

/**
 * pi's `resolvePath(sessionArg, cwd)` for a `--session` value (no Unicode
 * space or `@` handling, unlike tool paths). Returns undefined for a relative
 * value when `cwd` is unknown.
 */
export function resolveSessionArgPath(input: string, cwd: string | undefined): string | undefined {
  const normalized = normalizeInput(input, {});
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  if (cwd === undefined) return undefined;
  return path.resolve(normalizeInput(cwd, {}), normalized);
}

function exists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** pi's `resolveReadPath`: the first existing variant among macOS screenshot, NFD and curly-quote spellings. */
export function resolveReadToolPath(input: string, cwd: string): string {
  const resolved = resolveToolPath(input, cwd);
  if (exists(resolved)) return resolved;
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  if (amPm !== resolved && exists(amPm)) return amPm;
  const nfd = resolved.normalize("NFD");
  if (nfd !== resolved && exists(nfd)) return nfd;
  const curly = resolved.replace(/'/g, "\u2019");
  if (curly !== resolved && exists(curly)) return curly;
  const nfdCurly = nfd.replace(/'/g, "\u2019");
  if (nfdCurly !== resolved && exists(nfdCurly)) return nfdCurly;
  return resolved;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Real path of `target`, also when it does not exist yet: the deepest existing
 * ancestor is resolved and the missing components are appended. A dangling
 * symbolic link is followed to where a write would create the file.
 */
export function realPathOrPending(target: string, depth = 0): string {
  if (depth > MAX_LINK_DEPTH) {
    throw Object.assign(new Error(`Too many symbolic links: ${target}`), { code: "ELOOP" });
  }
  try {
    return realpathSync.native(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = path.dirname(target);
    if (parent === target) throw Object.assign(new Error(`No existing ancestor: ${target}`), { code: "ENOENT" });
    return path.join(realPathOrPending(parent, depth), path.basename(target));
  }
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(target);
    return realPathOrPending(path.resolve(path.dirname(target), link), depth + 1);
  }
  // Exists but cannot be resolved (for example a component is a regular file).
  throw Object.assign(new Error(`Cannot resolve path: ${target}`), { code: "ENOTDIR" });
}

/**
 * Canonical path of a tool path argument: pi's resolution rules, then real path
 * (symbolic links and Windows junctions resolved). `read` also tries pi's
 * read-path variants. A file that does not exist yet resolves through its
 * deepest existing ancestor.
 */
export function canonicalPathSync(input: string, cwd: string, mode: PathMode): string {
  const resolved = mode === "read" ? resolveReadToolPath(input, cwd) : resolveToolPath(input, cwd);
  return realPathOrPending(resolved);
}

export async function canonicalPath(input: string, cwd: string, mode: PathMode): Promise<string> {
  return canonicalPathSync(input, cwd, mode);
}

/**
 * Key for comparing canonical paths. Windows: `\` separators, no `\\?\`
 * prefix, case folded (NTFS per-directory case sensitivity is ignored, as in
 * pi). macOS: NFC and case folded (the default APFS volume is case- and
 * normalization-insensitive). Linux: unchanged.
 */
export function comparisonKey(canonical: string): string {
  if (process.platform === "win32") {
    let p = canonical.replace(/\//g, "\\");
    if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
    else if (p.startsWith("\\\\?\\")) p = p.slice(4);
    return path.win32.resolve(p).toLowerCase();
  }
  if (process.platform === "darwin") return canonical.normalize("NFC").toLowerCase().normalize("NFC");
  return canonical;
}

/** True when `target` is `root` or inside it. Both arguments must be canonical. */
export function isWithin(root: string, target: string): boolean {
  const rootKey = comparisonKey(root);
  const targetKey = comparisonKey(target);
  if (rootKey === targetKey) return true;
  const sep = process.platform === "win32" ? "\\" : "/";
  return targetKey.startsWith(rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`);
}

/** True when `dir` is an ancestor of `target` or the same path. Both arguments must be canonical. */
export function isAncestorOf(dir: string, target: string): boolean {
  return isWithin(dir, target);
}
