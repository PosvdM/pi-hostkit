import { accessSync, constants, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
 * A `--session` value whose meaning does not depend on the environment or the
 * working directory of the pi process: a POSIX path starting with `/`, or on
 * Windows a path with a drive letter (`C:\...` or `C:/...`) or a UNC path.
 * Values starting with `~` (pi's home), `\x` without a drive (the current
 * drive), Git Bash forms such as `/c/...` and relative
 * paths depend on the target process and return undefined. The result is the
 * path pi opens (`path.resolve` of the value).
 */
export function environmentIndependentPath(value: string): string | undefined {
  return environmentIndependentPathFor(value, process.platform);
}

/** `environmentIndependentPath` for a given platform (exported for tests). */
export function environmentIndependentPathFor(value: string, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    if (/^[A-Za-z]:[\\/]/.test(value)) return path.win32.resolve(value);
    // UNC needs a non-empty server and share (`\\server\share...`), as in
    // Node's win32 path rules; `\\x` alone resolves against the current drive.
    // Device paths (`\\?\`, `\\.\`) are not accepted.
    if (/^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(value)) return path.win32.resolve(value);
    return undefined;
  }
  return value.startsWith("/") ? path.posix.resolve(value) : undefined;
}

function exists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  return code === "ENOENT";
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
  // 目标可能在首次解析与 lstat 之间创建；仅重试一次，失败时原样传播错误。
  return realpathSync.native(target);
}

/** Read-only probe on the nearest existing directory's device; no native addon or probe files. */
function detectCaseSensitivity(canonical: string): boolean | undefined {
  try {
    let existing = canonical;
    let info;
    for (;;) {
      try {
        info = statSync(existing, { bigint: true });
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(existing);
        if (parent === existing) return undefined;
        existing = parent;
      }
    }
    existing = realpathSync.native(existing);
    let dir = info.isDirectory() ? existing : path.dirname(existing);
    const device = statSync(dir, { bigint: true }).dev;
    // A file-level mount cannot inherit the parent directory's case rules.
    if (info.dev !== device) return undefined;
    for (;;) {
      const entries = new Set(readdirSync(dir));
      for (const name of entries) {
        const alternate = name.replace(/[a-z]/i, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
        // Two recorded spellings can be hard links to the same inode on a sensitive volume.
        if (alternate === name || entries.has(alternate)) continue;
        const original = lstatSync(path.join(dir, name), { bigint: true });
        // A mounted child belongs to another device and cannot describe this directory.
        if (original.dev !== device) continue;
        if (original.ino === 0n) return undefined;
        try {
          const alias = lstatSync(path.join(dir, alternate), { bigint: true });
          return alias.dev !== original.dev || alias.ino !== original.ino;
        } catch (error) {
          if (isMissing(error)) return true;
          throw error;
        }
      }
      const parent = path.dirname(dir);
      // Never infer a mounted volume's rules from the parent volume.
      if (parent === dir || statSync(parent, { bigint: true }).dev !== device) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function assertCaseInsensitiveFilesystem(canonical: string): void {
  if (process.platform !== "darwin") return;
  try {
    if (detectCaseSensitivity(canonical) === false) return;
  } catch {
    // A failed probe cannot justify folding two distinct paths into one key.
  }
  throw Object.assign(
    new Error(`Cannot establish a case-insensitive filesystem for ${canonical}; use a case-insensitive macOS volume`),
    { code: "EHOSTKIT_CASE_SENSITIVE_FS" },
  );
}

/**
 * Canonical path of a tool path argument: pi's resolution rules, then real path
 * (symbolic links and Windows junctions resolved). `read` also tries pi's
 * read-path variants. A file that does not exist yet resolves through its
 * deepest existing ancestor.
 */
export function canonicalPathSync(input: string, cwd: string, mode: PathMode): string {
  const resolved = mode === "read" ? resolveReadToolPath(input, cwd) : resolveToolPath(input, cwd);
  const canonical = realPathOrPending(resolved);
  assertCaseInsensitiveFilesystem(canonical);
  return canonical;
}

export async function canonicalPath(input: string, cwd: string, mode: PathMode): Promise<string> {
  return canonicalPathSync(input, cwd, mode);
}

/**
 * Key for comparing canonical paths. Windows: `\` separators, no `\\?\`
 * prefix, case folded (NTFS per-directory case sensitivity is ignored, as in
 * pi). macOS: NFC and case folded, after establishing that the containing
 * filesystem is case-insensitive; sensitive or indeterminate volumes are refused.
 * Linux: unchanged.
 */
export function comparisonKey(canonical: string): string {
  if (process.platform === "win32") {
    let p = canonical.replace(/\//g, "\\");
    if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
    else if (p.startsWith("\\\\?\\")) p = p.slice(4);
    return path.win32.resolve(p).toLowerCase();
  }
  if (process.platform === "darwin") {
    assertCaseInsensitiveFilesystem(canonical);
    return canonical.normalize("NFC").toLowerCase().normalize("NFC");
  }
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
