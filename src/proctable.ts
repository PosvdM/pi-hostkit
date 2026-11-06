import { readdirSync, readFileSync } from "node:fs";
import { nativeFn } from "./native.js";

/** One process in the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Process group (POSIX). */
  pgid?: number;
  /** Creation time as recorded by the OS; format differs per platform, compare only for equality. */
  startTime: string;
  /** Exited but not reaped (POSIX). A zombie is treated as gone. */
  zombie: boolean;
}

let linuxBootId: string | undefined;
function bootId(): string {
  linuxBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return linuxBootId;
}

/**
 * Linux: `/proc/<pid>/stat` field 22 (start time in clock ticks since boot),
 * prefixed with the boot id. The boot id changes on every reboot, so a
 * recorded identity never matches after a restart. The boot time in
 * `/proc/stat` is not used because it can drift by a second between reads.
 */
function linuxRow(pid: number): ProcessRow | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  // fields[0] is field 3 (state); field N is fields[N - 3].
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const ticks = fields[19];
  if (!ticks) return null;
  return { pid, ppid, pgid, startTime: `${bootId()}:${ticks}`, zombie: state === "Z" || state === "X" };
}

/** Reads one process, or null when it does not exist or is not visible. */
export function processInfo(pid: number): ProcessRow | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxRow(pid);
  return nativeFn("processInfo")(pid);
}

/** Lists processes visible to the current user. */
export function listProcesses(): ProcessRow[] {
  if (process.platform === "linux") {
    const rows: ProcessRow[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const row = linuxRow(Number(name));
      if (row) rows.push(row);
    }
    return rows;
  }
  return nativeFn("listProcesses")();
}

/** Command line arguments of a process; Windows returns the raw command line as one string. */
export function processCommandLine(pid: number): string[] | string | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter((part, index, all) => part !== "" || index < all.length - 1);
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
    return BigInt(sec) * 1_000_000n + BigInt(usec);
  }
  return BigInt(startTime);
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
  const queue: { pid: number; key: bigint }[] = [{ pid: root.pid, key: startKey(root.startTime) }];
  const seen = new Set<number>([root.pid]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      const key = startKey(child.startTime);
      if (key < parent.key) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push({ pid: child.pid, key });
    }
  }
  return result;
}
