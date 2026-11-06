import { mkdir, chmod, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { nativeFn } from "./native.js";

// Owners other than the current user that are acceptable on Windows: they can
// read every file anyway. Administrators own files created by elevated processes.
const WINDOWS_TRUSTED_OWNERS = new Set(["S-1-5-32-544", "S-1-5-18"]);

/** Path problems found by `checkPrivate`; `ok` is false when `problem` is set. */
export interface PrivateCheck {
  ok: boolean;
  problem?: string;
}

function posixProblem(stat: Awaited<ReturnType<typeof lstat>>, directory: boolean): string | undefined {
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (directory && !stat.isDirectory()) return "is not a directory";
  if (!directory && !stat.isFile()) return "is not a regular file";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return `is owned by uid ${stat.uid}, not the current user`;
  }
  const allowed = directory ? 0o700 : 0o600;
  const extra = Number(stat.mode) & 0o777 & ~allowed;
  if (extra) return `mode ${(Number(stat.mode) & 0o777).toString(8)} is wider than ${allowed.toString(8)}`;
  return undefined;
}

/**
 * macOS extended ACLs can grant other users access regardless of the mode
 * bits, and chmod does not remove them. Linux POSIX ACLs need no check: with
 * group bits 0 the ACL mask is 0, so named entries grant nothing.
 */
function macAclProblem(target: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const count = nativeFn("aclEntryCount")(target);
  return count ? `has an extended ACL with ${count} entr${count === 1 ? "y" : "ies"}` : undefined;
}

function windowsProblem(target: string): string | undefined {
  const user = nativeFn("userSid")();
  const acl = nativeFn("readAcl")(target);
  if (acl.nullDacl) return "has no DACL (everyone has access)";
  if (acl.owner !== user && !WINDOWS_TRUSTED_OWNERS.has(acl.owner ?? "")) return `is owned by ${acl.owner}`;
  if (!acl.protected) return "inherits permissions from its parent";
  for (const ace of acl.aces) {
    if (ace.type === "deny") continue;
    if (ace.type !== "allow") return "has an access entry of an unsupported type";
    if (ace.sid !== user) return `grants access to ${ace.sid}`;
  }
  return undefined;
}

/**
 * Checks that `target` is accessible only by the current user. POSIX: owner is
 * the current user, directories at most 0700, files at most 0600, not a
 * symbolic link, and on macOS no extended ACL. Windows: protected DACL whose
 * allow entries name only the current user's SID.
 */
export async function checkPrivate(target: string): Promise<PrivateCheck> {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    return { ok: false, problem: `cannot be read: ${(error as Error).message}` };
  }
  const problem =
    process.platform === "win32"
      ? stat.isSymbolicLink()
        ? "is a symbolic link"
        : windowsProblem(target)
      : (posixProblem(stat, stat.isDirectory()) ?? macAclProblem(target));
  return problem ? { ok: false, problem: `${target} ${problem}` } : { ok: true };
}

function aggregateFailure(errors: unknown[], message: string): AggregateError {
  const failure = new AggregateError(errors, message);
  const code = (errors[0] as NodeJS.ErrnoException | null | undefined)?.code;
  return code === undefined ? failure : Object.assign(failure, { code });
}

function privateError(target: string, problem: string | undefined): Error {
  return Object.assign(new Error(problem ?? `${target} is not private`), { code: "EHOSTKIT_NOT_PRIVATE", path: target });
}

/**
 * Creates `dir` (and missing parents) or tightens an existing one so that only
 * the current user can access it. Throws when that cannot be achieved, for
 * example when the directory belongs to another user.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw privateError(dir, `${dir} is not a directory`);
  if (process.platform === "win32") {
    nativeFn("setPrivateAcl")(dir, true);
  } else {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw privateError(dir, `${dir} is owned by uid ${stat.uid}, not the current user`);
    }
    if (Number(stat.mode) & 0o077) await chmod(dir, 0o700);
    if (process.platform === "darwin" && nativeFn("aclEntryCount")(dir)) nativeFn("aclClear")(dir);
  }
  const check = await checkPrivate(dir);
  if (!check.ok) throw privateError(dir, check.problem);
}

/**
 * Creates `file` exclusively (fails with EEXIST when it exists) so that only
 * the current user can read or write it, then writes `data`. The parent
 * directory must already be private (see `ensurePrivateDir`). On Windows the
 * file is created with its private DACL in one call (`CreateFileW` with a
 * security descriptor), so there is no moment in which another user could open
 * it. On POSIX the file is created with mode 0600 and, on macOS, without
 * inheritable ACL entries because the parent has none.
 */
export async function writePrivateFile(file: string, data: Uint8Array): Promise<void> {
  const parent = await checkPrivate(path.dirname(path.resolve(file)));
  if (!parent.ok) throw privateError(file, `parent directory is not private: ${parent.problem}`);
  let handle;
  if (process.platform === "win32") {
    nativeFn("createPrivateFile")(file);
    try {
      handle = await open(file, "r+");
    } catch (error) {
      try {
        await unlink(file);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") {
          throw aggregateFailure([error, cleanup], `Cannot remove incomplete private file ${file}`);
        }
      }
      throw error;
    }
  } else {
    handle = await open(file, "wx", 0o600);
  }
  try {
    if (process.platform === "darwin" && nativeFn("aclEntryCount")(file)) nativeFn("aclClear")(file);
    await handle.writeFile(data);
    await handle.sync();
    const closing = handle;
    handle = undefined;
    await closing.close();
    const check = await checkPrivate(file);
    if (!check.ok) throw privateError(file, check.problem);
  } catch (error) {
    const failures: unknown[] = [error];
    if (handle) {
      try {
        await handle.close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    try {
      await unlink(file);
    } catch (cleanup) {
      // 文件已消失不构成清理失败；其他失败必须报告。
      if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanup);
    }
    if (failures.length > 1) throw aggregateFailure(failures, `Cannot finish private file ${file}`);
    throw error;
  }
}
