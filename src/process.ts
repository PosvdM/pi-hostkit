import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_RELEASE_LINE } from "./gate-protocol.js";
import { nativeFn } from "./native.js";
import { matches, processInfo, signalProcess } from "./proctable.js";
import { StdioRpcTransport, type RpcTransport } from "./rpc.js";
import { SnapshotRecords, stopSnapshot } from "./snapshots.js";
import { cgroupPopulated, stopCgroup } from "./cgroups.js";
import { pathExistsStrict } from "./fs-probe.js";

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
  /** Processes within coverage still alive or whose exit cannot be confirmed. */
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
  /** Maximum queued RPC input bytes; default 64 MiB, at least one gate release line. */
  maxQueuedBytes?: number;
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
    if (!line || !line.slice(3).startsWith("/")) throw hostkitError("EHOSTKIT_SPAWN", `cannot read unified cgroup for ${pid}`);
    return path.posix.join("/sys/fs/cgroup", line.slice(3));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
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

// ---------- stop reports ----------

class Steps {
  readonly steps: StopReport["steps"] = [];
  add(step: string, ok: boolean, detail?: string): void {
    this.steps.push({ step, at: new Date().toISOString(), ok, ...(detail !== undefined ? { detail } : {}) });
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowsToLeftovers(rows: { pid: number; startTime: string }[]): StopReport["leftovers"] {
  return rows.map((row) => ({ pid: row.pid, startTime: row.startTime }));
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
    if (this.exitInfo) {
      this.released = true;
      return;
    }
    this.rpc.writeRaw(`${GATE_RELEASE_LINE}\n`);
    this.rpc.block(undefined);
    this.released = true;
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
    // SnapshotRecords retains both partial records and failures for the stop report.
    this.snapshots.capture();
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
        steps.add("abort", false, errorDetail(error));
      }
    }

    try {
      this.rpc.closeInput();
      steps.add("closeInput", true);
    } catch (error) {
      steps.add("closeInput", false, errorDetail(error));
    }
    const exitedOnEof = await this.waitExit(opts.graceMs);
    steps.add("grace", exitedOnEof, exitedOnEof ? "exited" : `still running after ${opts.graceMs} ms`);

    if (process.platform !== "win32") {
      if (this.mode.kind === "snapshot") this.capture();
      if (this.exitInfo) {
        steps.add("SIGTERM", true, "not needed: process exited");
      } else {
        // pi's RPC mode terminates the command trees it tracks on SIGTERM.
        // pi is this host's unreaped child here, so its PID cannot be reused.
        try {
          const sent = signalProcess(this.identity, "SIGTERM");
          const exited = sent && (await this.waitExit(opts.termGraceMs));
          steps.add("SIGTERM", sent, exited ? "exited" : sent ? `still running after ${opts.termGraceMs} ms` : "not delivered");
        } catch (error) {
          steps.add("SIGTERM", false, errorDetail(error));
        }
      }
    }

    let leftovers: StopReport["leftovers"];
    if (this.mode.kind === "job") {
      const { job } = this.mode;
      try {
        nativeFn("jobTerminate")(job);
        steps.add("TerminateJobObject", true);
      } catch (error) {
        steps.add("TerminateJobObject", false, errorDetail(error));
      }
      const known = new Map<number, StopReport["leftovers"][number]>();
      const failures = new Set<string>();
      const failed = (step: string, error: unknown) => {
        const detail = errorDetail(error);
        const key = `${step}: ${detail}`;
        if (!failures.has(key)) steps.add(step, false, detail);
        failures.add(key);
      };
      let queried = false;
      const query = (): boolean => {
        let pids: number[];
        try {
          pids = nativeFn("jobProcessIds")(job);
          queried = true;
        } catch (error) {
          queried = false;
          failed("query Job Object", error);
          return false;
        }
        const members = new Set(pids);
        for (const pid of known.keys()) if (!members.has(pid)) known.delete(pid);
        for (const pid of members) {
          try {
            const row = processInfo(pid);
            if (row && !row.zombie) known.set(pid, { pid, startTime: row.startTime });
            else known.delete(pid);
          } catch (error) {
            if (!known.has(pid)) known.set(pid, { pid, startTime: pid === this.identity.pid ? this.identity.startTime : "" });
            failed(`query Job PID ${pid}`, error);
          }
        }
        return pids.length === 0;
      };
      try {
        await poll(query, SETTLE_CHECK_MS);
        // 最后一次 Job 查询失败时，即使已知成员为空也不能报告清理完成。
        const empty = query();
        leftovers = [...known.values()];
        if (!empty && (!queried || !leftovers.length)) {
          leftovers.push({ pid: 0, startTime: "", exe: `Job Object ${job}` });
        }
      } finally {
        try {
          nativeFn("handleClose")(job);
          steps.add("close Job Object", true);
        } catch (error) {
          steps.add("close Job Object", false, errorDetail(error));
        }
      }
    } else if (this.mode.kind === "cgroup") {
      const { dir } = this.mode;
      const report = await stopCgroup(dir, this.identity, (empty) => poll(empty, SETTLE_CHECK_MS));
      steps.steps.push(...report.steps);
      leftovers = report.leftovers;
    } else {
      this.capture();
      const report = await stopSnapshot(this.snapshots, (empty) => poll(empty, SETTLE_CHECK_MS));
      steps.steps.push(...report.steps);
      leftovers = report.leftovers;
    }

    if (!(await this.waitExit(SETTLE_CHECK_MS))) {
      // Not reaped yet; the final check covers the pi process itself.
      let gone = false;
      try {
        gone = !matches(processInfo(this.identity.pid), this.identity);
      } catch (error) {
        steps.add("query pi", false, errorDetail(error));
      }
      if (!gone && !leftovers.some((row) => row.pid === this.identity.pid && row.startTime === this.identity.startTime)) {
        leftovers.push({ pid: this.identity.pid, startTime: this.identity.startTime });
      }
    }
    steps.add("verify", leftovers.length === 0, leftovers.length ? `${leftovers.length} alive or unknown` : undefined);
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
  if (spec.maxQueuedBytes !== undefined &&
      (!Number.isSafeInteger(spec.maxQueuedBytes) || spec.maxQueuedBytes < Buffer.byteLength(`${GATE_RELEASE_LINE}\n`))) {
    throw hostkitError("EINVAL", "maxQueuedBytes must be a safe integer large enough for the gate release line");
  }
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
  let exited = false;
  let job: number | undefined;
  let identity: ProcessIdentity | null = null;
  const childErrors: unknown[] = [];
  const onChildError = (error: Error) => { childErrors.push(error); };
  child.on("error", onChildError);
  child.once("exit", () => { exited = true; });
  child.once("close", () => child.removeListener("error", onChildError));
  try {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.removeListener("error", onStartError); resolve(); };
      const onStartError = (error: Error) => { child.removeListener("spawn", onSpawn); reject(error); };
      child.once("spawn", onSpawn);
      child.once("error", onStartError);
    });
  } catch (error) {
    child.removeListener("error", onChildError);
    throw error;
  }
  const pid = child.pid!;

  const abandon = async (primary: unknown, extra: unknown[] = [], closeJob = true): Promise<never> => {
    const failures: unknown[] = [primary, ...extra];
    const added = new Set<string>();
    const add = (error: unknown) => {
      const detail = errorDetail(error);
      if (!added.has(detail)) { added.add(detail); failures.push(error); }
    };
    // end 可能因背压延迟关闭；destroy 同时保证未放行的 gate 收到 EOF。
    const input = child.stdin;
    const onInputError = (error: Error) => add(error);
    if (input) {
      input.on("error", onInputError);
      input.once("close", () => input.removeListener("error", onInputError));
      try { input.end(); } catch (error) { add(error); }
      try { input.destroy(); } catch (error) { add(error); }
    }
    let sent: boolean | undefined;
    if (!exited) {
      try { sent = child.kill("SIGKILL"); } catch (error) { add(error); }
    }
    if (closeJob && job !== undefined) {
      try { nativeFn("handleClose")(job); } catch (error) { add(error); }
    }
    let gone = exited;
    try {
      gone = await poll(() => {
        if (exited) return true;
        try {
          const row = processInfo(pid);
          return identity ? !matches(row, identity) : !row || row.zombie;
        } catch (error) {
          add(error);
          return false;
        }
      }, SETTLE_CHECK_MS);
    } catch (error) { add(error); }
    // kill 返回 false 只有在随后明确确认退出时才可视为无需发送。
    if (sent === false && !gone) add(new Error(`启动回收未发送 SIGKILL：PID ${pid}`));
    if (!gone) {
      add(new Error(`启动回收未能在 ${SETTLE_CHECK_MS} ms 内确认 PID ${pid} 退出`, {
        cause: { pid, ...(identity ? { identity } : {}), errors: childErrors },
      }));
    }
    // 接住 kill/destroy 在下一轮事件循环发出的错误，即使退出已经得到确认。
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const error of childErrors) add(error);
    // 状态仍未知时保留收集器，延后的 error 也能从未确认退出错误的 cause.errors 中取得。
    if (gone) child.removeListener("error", onChildError);
    if (failures.length > 1) {
      throw Object.assign(new AggregateError(failures, failures.map(errorDetail).join("; ")), {
        code: (primary as NodeJS.ErrnoException | null)?.code,
      });
    }
    throw primary;
  };

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
    return abandon(error);
  }

  let managed!: Managed;
  try {
    const rpc = new StdioRpcTransport(child.stdin!, child.stdout!, { maxRecordBytes: spec.maxRecordBytes, maxQueuedBytes: spec.maxQueuedBytes });
    rpc.block("pi is held at the start gate; call release() first");
    managed = new Managed(child, identity!, mode, rpc, spec.snapshotIntervalMs ?? 5_000);
  } catch (error) {
    return abandon(error);
  }
  if (!spec.startHeld) {
    try {
      managed.release();
    } catch (error) {
      let report: StopReport;
      try {
        report = await managed.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
      } catch (stopError) {
        // stop 的 finally 已处理 Job；回收仍由宿主持有的子进程，不重放句柄关闭。
        return abandon(error, [stopError], false);
      }
      // 放行失败时没有 ManagedProcess 可交给调用方，清理报告必须随错误保留。
      const failures = report.steps.filter((step) => !step.ok && step.step !== "grace" &&
        !(step.step === "abort" && ["process held at the start gate", "process already exited"].includes(step.detail ?? "")));
      if (report.leftovers.length || failures.length) {
        const cleanup = new Error(`stop after release failure: ${failures.map((step) => `${step.step}: ${step.detail ?? "failed"}`).join("; ")}; ${report.leftovers.length} leftovers`, { cause: report });
        return abandon(error, [cleanup], false);
      }
      throw error;
    }
  }
  child.removeListener("error", onChildError);
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
  const alive = () => {
    try {
      return matches(processInfo(id.pid), id);
    } catch (error) {
      steps.add("query pi", false, errorDetail(error));
      return true;
    }
  };
  const beforeIdentity = steps.steps.length;
  const same = alive();
  const identityKnown = steps.steps.length === beforeIdentity;
  steps.add("identity", identityKnown, identityKnown ? (same ? "alive" : "gone") : "unknown");

  if (process.platform === "win32") {
    const records = new SnapshotRecords(id);
    records.capture();
    for (const failure of records.captureFailures) steps.add("snapshot", false, failure);
    const tree = [...records.records.values()];
    for (const row of [id, ...tree]) {
      const step = row === id ? "TerminateProcess pi" : "TerminateProcess descendant";
      try {
        const killed = nativeFn("terminateProcess")(row.pid, row.startTime);
        steps.add(step, killed, `${row.pid}: ${killed ? "sent" : "not running or identity changed"}`);
      } catch (error) {
        steps.add(step, false, `${row.pid}: ${errorDetail(error)}`);
      }
    }
    await poll(() => records.remaining().length === 0, SETTLE_CHECK_MS);
    const leftovers = rowsToLeftovers(records.remaining());
    for (const failure of records.failures) steps.add("query recorded process", false, failure);
    steps.add("verify", leftovers.length === 0);
    return { steps: steps.steps, coverage: "snapshot_visible", leftovers };
  }

  let cgroup: string | undefined;
  if (isOwnScope(id.cgroup)) {
    try {
      if (pathExistsStrict(id.cgroup!)) cgroup = id.cgroup;
    } catch (error) {
      // An unreadable recorded scope must not silently become snapshot coverage.
      steps.add("check cgroup directory", false, errorDetail(error));
      cgroup = id.cgroup;
    }
  }
  const records = new SnapshotRecords(id);
  const capture = () => {
    try {
      records.capture();
    } catch (error) {
      steps.add("snapshot", false, errorDetail(error));
    }
  };
  if (!cgroup) capture();
  if (alive()) {
    try {
      const sent = signalProcess(id, "SIGTERM");
      const exited = sent && (await poll(() => !alive(), o.termGraceMs));
      steps.add("SIGTERM", sent, exited ? "exited" : sent ? `still running after ${o.termGraceMs} ms` : "not delivered");
    } catch (error) {
      steps.add("SIGTERM", false, errorDetail(error));
    }
  }

  if (cgroup) {
    const report = await stopCgroup(cgroup, id, (empty) => poll(empty, SETTLE_CHECK_MS));
    steps.steps.push(...report.steps);
    const leftovers = report.leftovers;
    steps.add("verify", leftovers.length === 0);
    return { steps: steps.steps, coverage: "cgroup", leftovers };
  }

  capture();
  const report = await stopSnapshot(records, (empty) => poll(empty, SETTLE_CHECK_MS));
  steps.steps.push(...report.steps);
  const leftovers = report.leftovers;
  steps.add("verify", leftovers.length === 0);
  return { steps: steps.steps, coverage: "snapshot_visible", leftovers: rowsToLeftovers(leftovers) };
}

/** Whether `id` has an own cgroup scope that still contains processes (Linux). */
export function scopePopulated(id: Pick<ProcessIdentity, "cgroup">): boolean {
  return process.platform === "linux" && isOwnScope(id.cgroup) && cgroupPopulated(id.cgroup!);
}
