import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProcessIdentity, StopReport } from "./process.js";
import { matches, processInfo, signalProcess } from "./proctable.js";
import { pathExistsStrict } from "./fs-probe.js";

/** Internal dependency seam; this module is not a package export. */
export interface CgroupOps {
  readFile(file: string): string;
  writeFile(file: string, value: string): void;
  readDirectories(dir: string): string[];
  /** False only for a confirmed missing directory; other query errors throw. */
  exists(dir: string): boolean;
  processInfo: typeof processInfo;
  /** Must verify the supplied identity before delivering the signal. */
  signalProcess: typeof signalProcess;
}

const system: CgroupOps = {
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, value) => writeFileSync(file, value),
  readDirectories: (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  exists: pathExistsStrict,
  processInfo,
  signalProcess,
};

type Identity = Pick<ProcessIdentity, "pid" | "startTime">;
type Leftover = StopReport["leftovers"][number];
type Listing = { pids: number[]; complete: boolean };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENODEV";
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Missing events prove emptiness only when the directory itself is confirmed gone. */
export function cgroupPopulated(dir: string, ops: Pick<CgroupOps, "readFile" | "exists"> = system): boolean {
  let events: string;
  try {
    events = ops.readFile(path.join(dir, "cgroup.events"));
  } catch (error) {
    if (isMissing(error)) {
      try {
        if (!ops.exists(dir)) return false;
      } catch (existsError) {
        throw new AggregateError([error, existsError], `${detail(error)}; cannot confirm scope removal: ${detail(existsError)}`);
      }
    }
    throw error;
  }
  const match = /^populated ([01])$/m.exec(events);
  if (!match) throw new Error(`cannot read populated from ${dir}/cgroup.events`);
  return match[1] === "1";
}

/**
 * Kills an owned scope, then independently kills and verifies pi's identity.
 * The caller supplies a bounded settle wait, as for stopSnapshot. Operational
 * failures become report steps and conservative leftovers, never rejections.
 */
export async function stopCgroup(
  dir: string,
  root: Identity,
  settle: (empty: () => boolean) => Promise<unknown>,
  ops: CgroupOps = system,
): Promise<StopReport> {
  const steps: StopReport["steps"] = [];
  const failures = new Set<string>();
  const add = (step: string, ok: boolean, message?: string) => {
    // A bounded poll may see the same read failure on every iteration.
    if (!ok) {
      const key = `${step}\n${message ?? ""}`;
      if (failures.has(key)) return;
      failures.add(key);
    }
    steps.push({ step, ok, at: new Date().toISOString(), ...(message !== undefined ? { detail: message } : {}) });
  };
  const failed = (step: string, error: unknown, target: string) => add(step, false, `${target}: ${detail(error)}`);
  const known = new Map<number, Identity>();
  let scopeEmpty = false;
  let population: boolean | undefined;

  const populated = (): boolean | undefined => {
    try {
      population = cgroupPopulated(dir, ops);
    } catch (error) {
      population = undefined;
      failed("check cgroup", error, dir);
    }
    if (population === false) {
      scopeEmpty = true;
      known.clear();
    }
    return population;
  };

  const list = (): Listing => {
    const pids = new Set<number>();
    const pending = [dir];
    const visited = new Set<string>();
    let complete = true;
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      try {
        const procs = ops.readFile(path.join(current, "cgroup.procs"));
        for (const line of procs.split("\n")) {
          if (!line.trim()) continue;
          const pid = Number(line);
          if (/^\d+$/.test(line) && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
          else {
            complete = false;
            add("list cgroup", false, `${current}/cgroup.procs: invalid PID ${line}`);
          }
        }
      } catch (error) {
        // Even an unreadable cgroup.procs must not hide readable child scopes.
        let removed = false;
        if (isMissing(error)) {
          try {
            removed = !ops.exists(current);
          } catch (existsError) {
            failed("list cgroup", existsError, current);
          }
        }
        if (!removed) {
          complete = false;
          failed("list cgroup", error, `${current}/cgroup.procs`);
        }
      }
      try {
        for (const name of ops.readDirectories(current)) pending.push(path.join(current, name));
      } catch (error) {
        let removed = false;
        if (isMissing(error)) {
          try {
            removed = !ops.exists(current);
          } catch (existsError) {
            failed("list cgroup", existsError, current);
          }
        }
        if (!removed) {
          complete = false;
          failed("list cgroup", error, current);
        }
      }
    }
    return { pids: [...pids], complete };
  };

  const rememberUnknown = (pid: number) => {
    if (!known.has(pid)) known.set(pid, { pid, startTime: pid === root.pid ? root.startTime : "" });
  };

  const inspect = (pid: number, listed: boolean): Identity | null => {
    try {
      const row = ops.processInfo(pid);
      if (!row || row.zombie) {
        known.delete(pid);
        return null;
      }
      const recorded = known.get(pid);
      // A successful identity mismatch proves the earlier record is gone.
      // Only a fresh scope listing can introduce the replacement process.
      if (!listed && recorded?.startTime && !matches(row, recorded)) {
        known.delete(pid);
        return null;
      }
      const id = { pid: row.pid, startTime: row.startTime };
      known.set(pid, id);
      return id;
    } catch (error) {
      rememberUnknown(pid);
      failed("query cgroup PID", error, String(pid));
      return null;
    }
  };

  const inScope = (pid: number): boolean => {
    const line = ops.readFile(`/proc/${pid}/cgroup`).split("\n").find((entry) => entry.startsWith("0::"));
    if (!line) throw new Error(`cannot read unified cgroup from /proc/${pid}/cgroup`);
    const current = path.posix.join("/sys/fs/cgroup", line.slice(3));
    return current === dir || current.startsWith(`${dir}/`);
  };

  const killScope = () => {
    try {
      ops.writeFile(path.join(dir, "cgroup.kill"), "1");
      add("kill cgroup", true, "cgroup.kill");
      return;
    } catch (error) {
      failed("cgroup.kill", error, dir);
      if (isMissing(error)) {
        try {
          if (!ops.exists(dir)) {
            scopeEmpty = true;
            population = false;
            add("kill cgroup", true, "scope already removed");
            return;
          }
        } catch (existsError) {
          failed("check cgroup directory", existsError, dir);
        }
      }
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!isMissing(error) && code !== "EINVAL" && code !== "EACCES" && code !== "EPERM") return;
    }
    // Kernels before 5.14 lack cgroup.kill. Each PID has its own error boundary,
    // and population/listing failures do not prevent readable members' cleanup.
    const beforeFallback = failures.size;
    for (let round = 0; round < 5; round++) {
      if (populated() === false) break;
      for (const pid of list().pids) {
        const id = inspect(pid, true);
        if (!id) continue;
        try {
          if (!inScope(pid)) continue;
        } catch (error) {
          failed("query cgroup membership", error, String(pid));
          continue;
        }
        try {
          const sent = ops.signalProcess(id, "SIGKILL");
          if (!sent) add("SIGKILL cgroup PID", false, `${pid}: not delivered (gone or identity changed)`);
        } catch (error) {
          failed("SIGKILL cgroup PID", error, String(pid));
        }
      }
    }
    add("kill cgroup", failures.size === beforeFallback, "SIGKILL members (at most 5 rounds)");
  };

  const rootAlive = (): boolean => {
    try {
      return matches(ops.processInfo(root.pid), root);
    } catch (error) {
      failed("query pi", error, String(root.pid));
      return true;
    }
  };

  killScope();
  // signalProcess verifies root's recorded identity itself. Do not gate this
  // attempt on a separate query, scope membership, or successful enumeration.
  try {
    const sent = ops.signalProcess(root, "SIGKILL");
    add("SIGKILL pi", sent, sent ? "sent" : "not running or identity changed");
  } catch (error) {
    failed("SIGKILL pi", error, String(root.pid));
  }

  try {
    await settle(() => {
      if (!scopeEmpty) populated();
      const piGone = !rootAlive();
      return scopeEmpty && piGone;
    });
  } catch (error) {
    failed("settle cgroup", error, dir);
  }

  let complete = true;
  if (!scopeEmpty) {
    const listing = list();
    complete = listing.complete;
    const listed = new Set(listing.pids);
    for (const pid of listed) inspect(pid, true);
    // A partial enumeration never discards identities read during fallback.
    for (const pid of [...known.keys()]) if (!listed.has(pid)) inspect(pid, false);
    populated();
  }
  const piAlive = rootAlive();
  if (!piAlive && known.get(root.pid)?.startTime === root.startTime) known.delete(root.pid);
  const leftovers: Leftover[] = scopeEmpty ? [] : [...known.values()].map((id) => ({ ...id }));
  if (!scopeEmpty && (!complete || population === undefined || leftovers.length === 0)) {
    leftovers.push({ pid: 0, startTime: "", exe: `cgroup ${dir}` });
  }
  if (piAlive && !leftovers.some((id) => id.pid === root.pid && id.startTime === root.startTime)) {
    leftovers.push({ pid: root.pid, startTime: root.startTime });
  }
  add("verify cgroup", leftovers.length === 0, leftovers.length ? `${leftovers.length} alive or unknown` : undefined);
  return { steps, coverage: "cgroup", leftovers };
}
