import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_RELEASE_LINE } from "./gate-protocol.js";
import { nativeFn } from "./native.js";
import { listProcesses, matches, processInfo, signalProcess, verifiedDescendants, type ProcessRow } from "./proctable.js";
import { StdioRpcTransport, type RpcTransport } from "./rpc.js";

export interface ProcessIdentity {
  pid: number;
  /** Creation time recorded by the OS (format differs per platform; compare for equality only). */
  startTime: string;
  runId: string;
  instanceId: string;
  /** Linux with cgroup v2: absolute path of the process's cgroup directory. */
  cgroup?: string;
}

export interface StopOptions {
  /** Wait for the RPC `abort` response; default 10000. */
  abortTimeoutMs?: number;
  /** Wait after closing stdin for pi to exit on its own; default 5000. */
  graceMs?: number;
  /** POSIX: wait after SIGTERM; default 3000. */
  termGraceMs?: number;
}

export type StopCoverage = "job_object" | "cgroup" | "snapshot_visible";

export interface StopReport {
  steps: { step: string; at: string; ok: boolean; detail?: string }[];
  /** What the final kill is guaranteed to reach. `snapshot_visible` covers only processes a snapshot saw. */
  coverage: StopCoverage;
  /** Processes within the coverage still alive after the final check; normally empty. */
  leftovers: { pid: number; startTime: string; exe?: string }[];
}

export type Containment = "auto" | "snapshot";

export interface SpawnSpec {
  /** `[cliEntry, ...pi arguments]`; run with `process.execPath`. */
  argv: string[];
  /** Working directory of pi; passed to spawn, `process.chdir()` is never called. */
  cwd: string;
  env: Record<string, string>;
  runId: string;
  instanceId: string;
  /**
   * Keep pi at the start gate until `release()`. Use this to record the
   * identity (for example as the session lock `writer`) before pi opens any
   * file. Default false: released as soon as the identity is known.
   */
  startHeld?: boolean;
  /**
   * `auto`: cgroup v2 scope on Linux when available, snapshots otherwise.
   * `snapshot`: skip the cgroup scope (Linux). Windows always uses a Job Object.
   */
  containment?: Containment;
  /** Maximum bytes of one RPC record; default 64 MiB. */
  maxRecordBytes?: number;
  /** Snapshot interval while a tool runs (snapshot coverage only); default 5000. */
  snapshotIntervalMs?: number;
}

export interface ManagedProcess {
  readonly identity: ProcessIdentity;
  readonly rpc: RpcTransport;
  /** Coverage `stop` will report. */
  readonly coverage: StopCoverage;
  /** True until `release()`; RPC sends throw while held. */
  readonly held: boolean;
  /** Lets a held process load pi. Idempotent. */
  release(): void;
  /** Stops pi and its process tree. Concurrent and repeated calls share one result. */
  stop(opts?: StopOptions): Promise<StopReport>;
  /** Resolves when the process has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** pi's stderr. The last 64 KiB are kept for `stderrTail()`. */
  onStderr(listener: (chunk: string) => void): () => void;
  stderrTail(): string;
}

const DEFAULT_STOP: Required<StopOptions> = { abortTimeoutMs: 10_000, graceMs: 5_000, termGraceMs: 3_000 };
const MAX_TIMER_MS = 2 ** 31 - 1;
const STDERR_TAIL = 64 * 1024;
const SETTLE_CHECK_MS = 2_000;

const gatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate.js");

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Applies defaults per field (`undefined` keeps the default) and rejects
 * values that would make a wait unbounded or invalid.
 */
export function resolveStopOptions(opts: StopOptions = {}): Required<StopOptions> {
  const out = {} as Required<StopOptions>;
  for (const key of Object.keys(DEFAULT_STOP) as (keyof StopOptions)[]) {
    const value = opts[key] ?? DEFAULT_STOP[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
      throw hostkitError("EINVAL", `${key} must be a finite number of milliseconds between 0 and ${MAX_TIMER_MS}`);
    }
    out[key] = value;
  }
  return out;
}

function hostkitError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

async function poll(fn: () => boolean, ms: number, interval = 25): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= end) return false;
    await delay(interval);
  }
}

/** Identity of a running process, or null when it does not exist. */
export function readIdentity(pid: number, runId: string, instanceId: string): ProcessIdentity | null {
  const row = processInfo(pid);
  if (!row || row.zombie) return null;
  return { pid, startTime: row.startTime, runId, instanceId };
}

/** Identity of the calling process, for `LockHost.identity`. */
export function currentProcessIdentity(instanceId: string, runId = "host"): ProcessIdentity {
  const id = readIdentity(process.pid, runId, instanceId);
  if (!id) throw hostkitError("EHOSTKIT", "cannot read the identity of the current process");
  return id;
}

/**
 * `alive` only when the PID exists and its creation time matches; a reused PID
 * is `gone`. Throws when the process table cannot be queried, so a failed
 * query is never reported as `gone`.
 */
export async function isSameProcess(id: Pick<ProcessIdentity, "pid" | "startTime">): Promise<"alive" | "gone"> {
  return matches(processInfo(id.pid), id) ? "alive" : "gone";
}

// ---------- Linux cgroup v2 ----------

let cgroupSupport: Promise<string | null> | undefined;

function findExecutable(name: string): string | null {
  const dirs = ["/usr/bin", "/bin", ...(process.env.PATH ?? "").split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function userBusEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Path of `systemd-run` when transient user scopes work on this machine, otherwise null. Cached. */
export function linuxCgroupSupport(): Promise<string | null> {
  if (process.platform !== "linux") return Promise.resolve(null);
  cgroupSupport ??= new Promise((resolve) => {
    if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return resolve(null);
    const systemdRun = findExecutable("systemd-run");
    if (!systemdRun) return resolve(null);
    execFile(
      systemdRun,
      ["--user", "--scope", "--quiet", "--collect", "--", "/bin/sh", "-c", "cat /proc/self/cgroup"],
      { timeout: 10_000, env: { ...process.env } },
      (error, stdout) => {
        resolve(!error && /\.scope$/m.test(String(stdout).trim()) ? systemdRun : null);
      },
    );
  });
  return cgroupSupport;
}

function cgroupOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line ? path.posix.join("/sys/fs/cgroup", line.slice(3)) : null;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENODEV";
}

/**
 * Whether any process remains in the scope or its sub-cgroups
 * (`cgroup.events` `populated`). A removed directory counts as empty; other
 * read errors throw, so a failed check is never taken as "empty".
 */
function cgroupPopulated(dir: string): boolean {
  let events: string;
  try {
    events = readFileSync(path.join(dir, "cgroup.events"), "utf8");
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const match = /^populated (\d)$/m.exec(events);
  if (!match) throw hostkitError("EHOSTKIT_CGROUP", `cannot read populated from ${dir}/cgroup.events`);
  return match[1] === "1";
}

/** PIDs in the scope and all its sub-cgroups. */
function cgroupPids(dir: string): number[] {
  const pids: number[] = [];
  const walk = (current: string) => {
    let procs: string;
    try {
      procs = readFileSync(path.join(current, "cgroup.procs"), "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const line of procs.split("\n")) if (line) pids.push(Number(line));
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(current, entry.name));
  };
  walk(dir);
  return pids;
}

function inScope(pid: number, dir: string): boolean {
  const current = cgroupOf(pid);
  return current !== null && (current === dir || current.startsWith(`${dir}/`));
}

function cgroupKill(dir: string): string {
  try {
    writeFileSync(path.join(dir, "cgroup.kill"), "1");
    return "cgroup.kill";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT means either the scope is gone or the kernel has no cgroup.kill.
    if (isMissing(error) && !existsSync(dir)) return "scope already removed";
    if (!isMissing(error) && code !== "EINVAL" && code !== "EACCES" && code !== "EPERM") throw error;
  }
  // Kernels before 5.14 have no cgroup.kill: SIGKILL each member of the
  // subtree. Membership and identity are checked right before each signal.
  for (let round = 0; round < 5 && cgroupPopulated(dir); round++) {
    for (const pid of cgroupPids(dir)) {
      const row = processInfo(pid);
      if (row && inScope(pid, dir)) signalProcess(row, "SIGKILL");
    }
  }
  return "SIGKILL members";
}

/**
 * Only scopes created by spawnManaged are killed as a whole: the unit name
 * carries a random suffix, so the scope belongs to one run. A recorded path
 * outside that pattern (for example a parent slice) is ignored.
 */
function isOwnScope(dir: string | undefined): boolean {
  return !!dir && /^\/sys\/fs\/cgroup\/(?:[^/]+\/)*pi-hostkit-[A-Za-z0-9_.-]+-[0-9a-f]{8}\.scope$/.test(dir) && !dir.includes("/../");
}

function scopeUnit(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return `pi-hostkit-${safe}-${randomBytes(4).toString("hex")}`;
}

// ---------- snapshot coverage ----------

class SnapshotRecords {
  readonly records = new Map<string, ProcessRow>();

  constructor(private readonly root: ProcessIdentity) {}

  remember(row: ProcessRow): void {
    this.records.set(`${row.pid}:${row.startTime}`, row);
  }

  /**
   * Records every live descendant of pi and the members of pi's process group
   * (pgid = pi's pid). Only while pi itself is alive with the recorded
   * identity: after pi has exited its PID, and so the group id, may belong to
   * an unrelated process, and nothing new is added.
   */
  capture(): void {
    const table = listProcesses();
    if (!table.some((row) => matches(row, this.root))) return;
    const tree = verifiedDescendants(table, this.root);
    // pi must still be the same process after the table was read; then its
    // pid is still its process group id and the group members are its own.
    if (!matches(processInfo(this.root.pid), this.root)) return;
    for (const row of tree) this.remember(row);
    for (const row of table) {
      if (row.pgid === this.root.pid && row.pid !== this.root.pid) this.remember(row);
    }
  }

  alive(): ProcessRow[] {
    return [...this.records.values()].filter((row) => matches(processInfo(row.pid), row));
  }

  /**
   * SIGKILL the current process group of every recorded process that still
   * matches its identity (except pi's own group), then each such process. A
   * group is signalled only through a verified member, while that member is
   * in it.
   */
  killDescendants(): number[] {
    const groups = new Set<number>();
    for (const row of this.records.values()) {
      const current = processInfo(row.pid);
      if (!matches(current, row)) continue;
      const pgid = current!.pgid;
      if (pgid !== undefined && pgid !== this.root.pid && pgid > 1 && !groups.has(pgid)) {
        if (signalProcess(row, "SIGKILL", pgid)) groups.add(pgid);
      }
      signalProcess(row, "SIGKILL");
    }
    return [...groups];
  }

  /** SIGKILL pi's process group through pi or a recorded member that is verified to be in it. */
  killRootGroup(): boolean {
    const members = [this.root as { pid: number; startTime: string }, ...this.records.values()];
    for (const member of members) {
      if (signalProcess(member, "SIGKILL", this.root.pid)) return true;
    }
    return false;
  }
}

// ---------- stop reports ----------

class Steps {
  readonly steps: StopReport["steps"] = [];
  add(step: string, ok: boolean, detail?: string): void {
    this.steps.push({ step, at: new Date().toISOString(), ok, ...(detail !== undefined ? { detail } : {}) });
  }
}

function rowsToLeftovers(rows: { pid: number; startTime: string }[]): StopReport["leftovers"] {
  return rows.map((row) => ({ pid: row.pid, startTime: row.startTime }));
}

function liveRows(pids: number[]): ProcessRow[] {
  return pids.map((pid) => processInfo(pid)).filter((row): row is ProcessRow => !!row && !row.zombie);
}

/** Kills a cgroup scope and verifies it is empty, sub-cgroups included. */
async function killScope(dir: string, steps: Steps): Promise<StopReport["leftovers"]> {
  try {
    steps.add("kill cgroup", true, cgroupKill(dir));
  } catch (error) {
    steps.add("kill cgroup", false, (error as Error).message);
  }
  let emptied = false;
  try {
    emptied = await poll(() => !cgroupPopulated(dir), SETTLE_CHECK_MS);
  } catch (error) {
    steps.add("check cgroup", false, (error as Error).message);
  }
  if (emptied) return [];
  const pids = cgroupPids(dir);
  // Populated (or unreadable) with no process left that can be listed: report
  // the scope itself so the stop is not mistaken for a complete one.
  const rows = liveRows(pids);
  return rows.length ? rowsToLeftovers(rows) : [{ pid: 0, startTime: "", exe: `cgroup ${dir}` }];
}

// ---------- spawnManaged ----------

type Mode = { kind: "job"; job: number } | { kind: "cgroup"; dir: string } | { kind: "snapshot" };

class Managed implements ManagedProcess {
  readonly rpc: StdioRpcTransport;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private released = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private stopping: Promise<StopReport> | undefined;
  private stderrBuffer = "";
  private stderrListeners = new Set<(chunk: string) => void>();
  private snapshots: SnapshotRecords;
  private activeTools = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: ChildProcess,
    readonly identity: ProcessIdentity,
    private readonly mode: Mode,
    rpc: StdioRpcTransport,
    private readonly snapshotIntervalMs: number,
  ) {
    this.rpc = rpc;
    this.snapshots = new SnapshotRecords(identity);
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        this.stopTimer();
        resolve(this.exitInfo);
      });
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-STDERR_TAIL);
      for (const listener of [...this.stderrListeners]) listener(chunk);
    });
    if (mode.kind === "snapshot") {
      rpc.onEvent((event) => {
        if (event.type === "tool_execution_start") {
          this.activeTools++;
          this.capture();
          this.timer ??= setInterval(() => this.capture(), this.snapshotIntervalMs);
          this.timer.unref();
        } else if (event.type === "tool_execution_end") {
          this.activeTools = Math.max(0, this.activeTools - 1);
          if (this.activeTools === 0) this.stopTimer();
        }
      });
    }
  }

  get coverage(): StopCoverage {
    return this.mode.kind === "job" ? "job_object" : this.mode.kind === "cgroup" ? "cgroup" : "snapshot_visible";
  }

  get held(): boolean {
    return !this.released;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.exitInfo) return;
    this.rpc.writeRaw(`${GATE_RELEASE_LINE}\n`);
    this.rpc.block(undefined);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  stderrTail(): string {
    return this.stderrBuffer;
  }

  stop(opts: StopOptions = {}): Promise<StopReport> {
    if (!this.stopping) {
      let resolved: Required<StopOptions>;
      try {
        resolved = resolveStopOptions(opts);
      } catch (error) {
        return Promise.reject(error);
      }
      this.stopping = this.runStop(resolved);
    }
    return this.stopping;
  }

  private capture(): void {
    try {
      this.snapshots.capture();
    } catch {
      // A failed snapshot leaves earlier records; the final stop snapshot runs again.
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Waits up to `ms` for exit; the timer is cleared as soon as the process exits. */
  private waitExit(ms: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async runStop(opts: Required<StopOptions>): Promise<StopReport> {
    const steps = new Steps();
    this.stopTimer();
    if (this.mode.kind === "snapshot") this.capture();

    if (this.exitInfo) {
      steps.add("abort", false, "process already exited");
    } else if (!this.released) {
      steps.add("abort", false, "process held at the start gate");
    } else {
      try {
        const res = await this.rpc.send({ type: "abort" }, { timeoutMs: opts.abortTimeoutMs });
        steps.add("abort", res.success, res.success ? undefined : res.error);
      } catch (error) {
        steps.add("abort", false, (error as Error).message);
      }
    }

    this.rpc.closeInput();
    steps.add("closeInput", true);
    const exitedOnEof = await this.waitExit(opts.graceMs);
    steps.add("grace", exitedOnEof, exitedOnEof ? "exited" : `still running after ${opts.graceMs} ms`);

    if (process.platform !== "win32") {
      if (this.mode.kind === "snapshot") this.capture();
      if (this.exitInfo) {
        steps.add("SIGTERM", true, "not needed: process exited");
      } else {
        // pi's RPC mode terminates the command trees it tracks on SIGTERM.
        // pi is this host's unreaped child here, so its PID cannot be reused.
        const sent = signalProcess(this.identity, "SIGTERM");
        const exited = sent && (await this.waitExit(opts.termGraceMs));
        steps.add("SIGTERM", sent, exited ? "exited" : sent ? `still running after ${opts.termGraceMs} ms` : "not delivered");
      }
    }

    let leftovers: StopReport["leftovers"];
    if (this.mode.kind === "job") {
      const { job } = this.mode;
      try {
        nativeFn("jobTerminate")(job);
        steps.add("TerminateJobObject", true);
      } catch (error) {
        steps.add("TerminateJobObject", false, (error as Error).message);
      }
      const jobPids = () => nativeFn("jobProcessIds")(job);
      await poll(() => jobPids().length === 0, SETTLE_CHECK_MS);
      leftovers = rowsToLeftovers(liveRows(jobPids()));
      nativeFn("handleClose")(job);
    } else if (this.mode.kind === "cgroup") {
      const { dir } = this.mode;
      leftovers = await killScope(dir, steps);
    } else {
      this.capture();
      const groups = this.snapshots.killDescendants();
      steps.add("SIGKILL descendants", true, groups.length ? `process groups ${groups.join(",")}` : "none");
      const rootGroup = this.snapshots.killRootGroup();
      steps.add("SIGKILL pi group", true, rootGroup ? "sent" : "no live member");
      await poll(() => this.snapshots.alive().length === 0, SETTLE_CHECK_MS);
      leftovers = rowsToLeftovers(this.snapshots.alive());
    }

    if (!(await this.waitExit(SETTLE_CHECK_MS))) {
      // Not reaped yet; the final check covers the pi process itself.
      if (matches(processInfo(this.identity.pid), this.identity)) {
        leftovers.push({ pid: this.identity.pid, startTime: this.identity.startTime });
      }
    }
    steps.add("verify", leftovers.length === 0, leftovers.length ? `${leftovers.length} still alive` : undefined);
    return { steps: steps.steps, coverage: this.coverage, leftovers };
  }
}

/**
 * Starts pi as `process.execPath gate.js <argv...>` and returns once its
 * identity is recorded (Windows: after the Job Object assignment; Linux with
 * cgroup v2: inside its own systemd scope). The gate keeps pi from loading
 * until `release()`; without `startHeld` it is released before this returns.
 */
export async function spawnManaged(spec: SpawnSpec): Promise<ManagedProcess> {
  if (!spec.argv.length) throw hostkitError("EINVAL", "argv must start with the pi cli entry");
  const containment = spec.containment ?? "auto";
  const systemdRun = containment === "auto" ? await linuxCgroupSupport() : null;
  const unit = systemdRun ? scopeUnit(spec.runId) : undefined;
  const nodeArgs = [gatePath, ...spec.argv];
  const file = systemdRun ?? process.execPath;
  const args = systemdRun
    ? ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", process.execPath, ...nodeArgs]
    : nodeArgs;
  const env = systemdRun ? { ...userBusEnv(), ...spec.env } : spec.env;

  const child = spawn(file, args, {
    cwd: spec.cwd,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  let job: number | undefined;
  const abandon = (error: Error): never => {
    try {
      child.kill("SIGKILL");
    } catch {}
    if (job !== undefined) {
      try {
        nativeFn("handleClose")(job);
      } catch {}
    }
    throw error;
  };

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const pid = child.pid!;
  let identity: ProcessIdentity | null = null;
  let mode: Mode = { kind: "snapshot" };
  try {
    if (unit) {
      // systemd-run moves itself into the scope and then execs node with the same PID.
      let dir: string | null = null;
      const ok = await poll(() => {
        dir = cgroupOf(pid);
        return exited || (dir !== null && dir.endsWith(`/${unit}.scope`));
      }, 10_000, 10);
      if (!ok || exited || !dir) throw hostkitError("EHOSTKIT_SPAWN", `systemd-run did not start ${unit}.scope`);
      mode = { kind: "cgroup", dir };
    }
    identity = readIdentity(pid, spec.runId, spec.instanceId);
    if (!identity || exited) throw hostkitError("EHOSTKIT_SPAWN", "pi exited during start");
    if (mode.kind === "cgroup") identity.cgroup = mode.dir;
    if (process.platform === "win32") {
      job = nativeFn("jobCreate")();
      nativeFn("jobAssign")(job, pid, identity.startTime);
      mode = { kind: "job", job };
    }
  } catch (error) {
    abandon(error as Error);
  }

  const rpc = new StdioRpcTransport(child.stdin!, child.stdout!, { maxRecordBytes: spec.maxRecordBytes });
  rpc.block("pi is held at the start gate; call release() first");
  const managed = new Managed(child, identity!, mode, rpc, spec.snapshotIntervalMs ?? 5_000);
  if (!spec.startHeld) managed.release();
  return managed;
}

// ---------- stopByIdentity ----------

/**
 * Stops a process recorded by an earlier host instance (no RPC connection, not
 * a child of this process). Verifies the identity before every signal. With a
 * recorded cgroup scope of its own, the whole scope is killed even when pi
 * itself has exited: the scope holds only that run's processes. Without one,
 * only pi and the descendants found while pi is alive are reached.
 */
export async function stopByIdentity(id: ProcessIdentity, opts: StopOptions = {}): Promise<StopReport> {
  const o = resolveStopOptions(opts);
  const steps = new Steps();
  steps.add("abort", false, "no RPC connection to a recorded process");
  const alive = () => matches(processInfo(id.pid), id);
  steps.add("identity", true, alive() ? "alive" : "gone");

  if (process.platform === "win32") {
    const table = listProcesses();
    const tree = alive() ? verifiedDescendants(table, id) : [];
    const killed = alive() && nativeFn("terminateProcess")(id.pid, id.startTime);
    steps.add("TerminateProcess pi", killed, killed ? undefined : "not running");
    for (const row of tree) nativeFn("terminateProcess")(row.pid, row.startTime);
    steps.add("TerminateProcess descendants", true, `${tree.length} processes`);
    const watch = [id, ...tree];
    await poll(() => watch.every((row) => !matches(processInfo(row.pid), row)), SETTLE_CHECK_MS);
    const leftovers = watch.filter((row) => matches(processInfo(row.pid), row));
    steps.add("verify", leftovers.length === 0);
    return { steps: steps.steps, coverage: "snapshot_visible", leftovers: rowsToLeftovers(leftovers) };
  }

  const cgroup = isOwnScope(id.cgroup) && existsSync(id.cgroup!) ? id.cgroup : undefined;
  const records = new SnapshotRecords(id);
  if (!cgroup) records.capture();
  if (alive()) {
    const sent = signalProcess(id, "SIGTERM");
    const exited = sent && (await poll(() => !alive(), o.termGraceMs));
    steps.add("SIGTERM", sent, exited ? "exited" : sent ? `still running after ${o.termGraceMs} ms` : "not delivered");
  }

  if (cgroup) {
    const leftovers = await killScope(cgroup, steps);
    steps.add("verify", leftovers.length === 0);
    return { steps: steps.steps, coverage: "cgroup", leftovers };
  }

  records.capture();
  const groups = records.killDescendants();
  steps.add("SIGKILL descendants", true, groups.length ? `process groups ${groups.join(",")}` : "none");
  steps.add("SIGKILL pi group", true, records.killRootGroup() ? "sent" : "no live member");
  const watch = () => [...records.alive(), ...(alive() ? [id] : [])];
  await poll(() => watch().length === 0, SETTLE_CHECK_MS);
  const leftovers = watch();
  steps.add("verify", leftovers.length === 0);
  return { steps: steps.steps, coverage: "snapshot_visible", leftovers: rowsToLeftovers(leftovers) };
}

/** Whether `id` has an own cgroup scope that still contains processes (Linux). */
export function scopePopulated(id: Pick<ProcessIdentity, "cgroup">): boolean {
  return process.platform === "linux" && isOwnScope(id.cgroup) && cgroupPopulated(id.cgroup!);
}
