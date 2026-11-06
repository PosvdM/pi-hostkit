import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { nativeFn } from "./native.js";

/** One process in the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Process group (POSIX). */
  pgid?: number;
  /** Creation time as recorded by the OS; format differs per platform, compare only for equality. */
  startTime: string;
  /** Exited but not reaped. A zombie is treated as gone. */
  zombie: boolean;
}

let linuxBootId: string | undefined;
function bootId(): string {
  linuxBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return linuxBootId;
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

/**
 * Linux: `/proc/<pid>/stat` field 22 (start time in clock ticks since boot),
 * prefixed with the boot id. The boot id changes on every reboot, so a
 * recorded identity never matches after a restart. The boot time in
 * `/proc/stat` is not used because it can drift by a second between reads.
 * Returns null only when the process does not exist; other read errors throw.
 */
function linuxRow(pid: number): ProcessRow | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).split(" ");
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const ticks = fields[19];
  if (!ticks) throw Object.assign(new Error(`cannot parse /proc/${pid}/stat`), { code: "EHOSTKIT_PROC" });
  const state = fields[0];
  return {
    pid,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    startTime: `${bootId()}:${ticks}`,
    zombie: state === "Z" || state === "X",
  };
}

/**
 * Reads one process. Null means the process does not exist; a failed query
 * throws, so callers never mistake "cannot tell" for "gone".
 */
export function processInfo(pid: number): ProcessRow | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxRow(pid);
  return nativeFn("processInfo")(pid);
}

/** Lists processes (on Linux, those whose /proc entry is readable). */
export function listProcesses(): ProcessRow[] {
  if (process.platform === "linux") {
    const rows: ProcessRow[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const row = linuxRow(Number(name));
        if (row) rows.push(row);
      } catch {
        // Unreadable entries are skipped; callers that must decide about a
        // specific process use processInfo, which throws instead.
      }
    }
    return rows;
  }
  return nativeFn("listProcesses")();
}

/**
 * Command line arguments of a process, or null when they cannot be read.
 * Windows splits the command line with CommandLineToArgvW.
 */
export function processCommandLine(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!raw) return null;
      return (raw.endsWith("\0") ? raw.slice(0, -1) : raw).split("\0");
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return nativeFn("processCommandLine")(pid);
  return nativeFn("processArgs")(pid);
}

/** Sortable form of `startTime`, used to reject a child that is older than its recorded parent. */
export function startKey(startTime: string): bigint {
  if (process.platform === "linux") return BigInt(startTime.slice(startTime.lastIndexOf(":") + 1));
  if (process.platform === "darwin") {
    const [sec, usec = "0"] = startTime.split(".");
    return BigInt(sec!) * 1_000_000n + BigInt(usec);
  }
  return BigInt(startTime);
}

/** Linux: start times from different boots are not comparable. */
function sameBoot(a: string, b: string): boolean {
  if (process.platform !== "linux") return true;
  return a.slice(0, a.lastIndexOf(":")) === b.slice(0, b.lastIndexOf(":"));
}

/** True when the row exists, matches the start time and is not a zombie. */
export function matches(row: ProcessRow | null | undefined, id: { pid: number; startTime: string }): boolean {
  return !!row && row.pid === id.pid && row.startTime === id.startTime && !row.zombie;
}

/**
 * Descendants of `root` in `table`, following parent links. A child must not
 * be older than its parent; this skips rows whose parent PID was reused.
 */
export function descendants(table: ProcessRow[], root: { pid: number; startTime: string }): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const result: ProcessRow[] = [];
  const queue: { pid: number; startTime: string; key: bigint }[] = [{ ...root, key: startKey(root.startTime) }];
  const seen = new Set<number>([root.pid]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || !sameBoot(child.startTime, parent.startTime)) continue;
      const key = startKey(child.startTime);
      if (key < parent.key) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push({ pid: child.pid, startTime: child.startTime, key });
    }
  }
  return result;
}

/**
 * `descendants`, keeping only rows whose whole chain of parents up to `root`
 * still has the same identity after the table was read. Linux reads `/proc`
 * one process at a time, so a parent could exit and its PID be reused by an
 * unrelated process while the table is being read; that process's children
 * would then look like descendants. Re-reading every parent afterwards drops
 * them (a parent that is still the same process was alive the whole time).
 * Children of a parent that exited during the read are dropped as well.
 */
export function verifiedDescendants(
  table: ProcessRow[],
  root: { pid: number; startTime: string },
  check: (id: { pid: number; startTime: string }) => boolean = (id) => matches(processInfo(id.pid), id),
): ProcessRow[] {
  const found = descendants(table, root);
  const byPid = new Map(found.map((row) => [row.pid, row]));
  const verdict = new Map<number, boolean>();
  const stillSame = (pid: number): boolean => {
    let ok = verdict.get(pid);
    if (ok === undefined) {
      const recorded = pid === root.pid ? root : byPid.get(pid);
      ok = !!recorded && check(recorded);
      verdict.set(pid, ok);
    }
    return ok;
  };
  return found.filter((row) => {
    for (let parent = row.ppid; ; ) {
      if (!stillSame(parent)) return false;
      if (parent === root.pid) return true;
      parent = byPid.get(parent)!.ppid;
    }
  });
}

let pidfdUsable = process.platform === "linux";
let pidfdGroupUsable = process.platform === "linux";

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * POSIX: sends `signal` to the process `id`, or with `group` to the process
 * group `group`, only if `id` still matches its identity (and, with `group`,
 * is currently in that group). Returns false when it is gone or no longer
 * matches.
 *
 * Linux opens a pidfd before the identity check, so a single-process signal
 * cannot reach a process that reused the PID afterwards. A process group is
 * signalled through a pidfd of its leader (`PIDFD_SIGNAL_PROCESS_GROUP`
 * addresses the group whose id is the pidfd's PID, Linux 6.9+); when the
 * leader has exited or the kernel is older, `kill(-group)` is used. The group
 * id cannot be reused while the verified member is in the group. macOS has no
 * pidfd: a PID reused between the check and kill() remains a documented
 * residual risk.
 */
export function signalProcess(id: { pid: number; startTime: string }, signal: NodeJS.Signals, group?: number): boolean {
  if (pidfdUsable) {
    let fd: number;
    try {
      fd = nativeFn("pidfdOpen")(id.pid);
    } catch (error) {
      if (errnoCode(error) !== "ENOSYS") throw error;
      pidfdUsable = false;
      return signalProcess(id, signal, group);
    }
    if (fd < 0) return false;
    try {
      const row = processInfo(id.pid);
      if (!matches(row, id)) return false;
      const signo = constants.signals[signal];
      if (group === undefined) return nativeFn("pidfdSignal")(fd, signo, false);
      if (row!.pgid !== group) return false;
      return signalGroupLinux(id, group, signal);
    } finally {
      nativeFn("fdClose")(fd);
    }
  }
  const row = processInfo(id.pid);
  if (!matches(row, id)) return false;
  if (group !== undefined && row!.pgid !== group) return false;
  return killQuietly(group !== undefined ? -group : id.pid, signal);
}

/**
 * Linux: signal a process group through its leader's pidfd when possible.
 * `member` is a process already verified to be in `group`; it is re-checked
 * after the leader's pidfd is open, so the pinned leader is the leader of the
 * group the member is in (the group id cannot change hands while the member
 * stays in it).
 */
function signalGroupLinux(member: { pid: number; startTime: string }, group: number, signal: NodeJS.Signals): boolean {
  const memberStill = () => {
    const row = processInfo(member.pid);
    return matches(row, member) && row!.pgid === group;
  };
  if (pidfdGroupUsable) {
    const leaderFd = nativeFn("pidfdOpen")(group);
    if (leaderFd >= 0) {
      try {
        const leader = processInfo(group);
        if (leader?.pgid === group && memberStill()) {
          try {
            if (nativeFn("pidfdSignal")(leaderFd, constants.signals[signal], true)) return true;
          } catch (error) {
            if (errnoCode(error) !== "EINVAL") throw error;
            pidfdGroupUsable = false; // kernels before 6.9
          }
        }
      } finally {
        nativeFn("fdClose")(leaderFd);
      }
    }
  }
  // Leader gone or kernel without group pidfd signals: kill(-group) after a
  // fresh check that the member is still in the group. Between this check and
  // kill() the member could exit and the group id be reused (residual risk).
  return memberStill() && killQuietly(-group, signal);
}

function killQuietly(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    throw error;
  }
}
