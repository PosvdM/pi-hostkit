import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { assertLocalFilesystem } from "./localfs.js";
import { nativeFn } from "./native.js";
import { comparisonKey, realPathOrPending } from "./paths.js";
import { hasOnlyExplicitSession, rpcSessionFile } from "./piargs.js";
import {
  isSameProcess,
  scopePopulated,
  spawnManaged,
  stopByIdentity,
  type ManagedProcess,
  type ProcessIdentity,
  type SpawnSpec,
  type StopOptions,
  type StopReport,
} from "./process.js";
import { listProcesses, processCommandLine, ProcessTableError, type ProcessRow } from "./proctable.js";
import { ensurePrivateDir } from "./secrets.js";
import { pathExistsStrict } from "./fs-probe.js";

export interface HeldLock {
  release(): Promise<void>;
}

export interface LockHost {
  app: "pi-pane" | "pi-agora";
  /** The host process holding the lock (see `currentProcessIdentity`). */
  identity: ProcessIdentity;
}

/** Shared record next to a session writer lock; pi-pane and pi-agora read and write the same format. */
export interface SessionLockRecord {
  version: 1;
  /** Canonical session file path. */
  sessionFile: string;
  /** Current (or last) lock holder. */
  host: LockHost;
  /** The pi process writing the session file; absent before pi is spawned. */
  writer?: ProcessIdentity;
  state: "starting" | "running" | "stopping" | "released";
  updatedAt: string;
}

export type RecoverResult = "none" | "stopped" | "failed";

export interface RecoverOptions extends StopOptions {
  /**
   * Treat an undeterminable previous writer as absent. Only after the user has
   * confirmed that no earlier pi process still writes this session.
   */
  assumeNoWriter?: boolean;
}

/**
 * Operations on one lock (`recoverPreviousWriter`, `update`, `spawnWriter`,
 * `release`) run one at a time in call order; after `release()` the others
 * throw `EHOSTKIT_LOCK_STATE`.
 */
export interface SessionWriterLock extends HeldLock {
  /** Canonical session file path. */
  readonly sessionFile: string;
  /** Record found when the lock was acquired. */
  readonly previous?: SessionLockRecord;
  /** Stop reports of previous writers stopped by `recoverPreviousWriter`. */
  readonly recoveryReports: readonly StopReport[];
  /** Release only after the writer exits, or after the caller confirms a session switch. */
  release(opts?: { writerSwitchedAway?: boolean }): Promise<void>;
  /**
   * Stops a previous writer that may still run, then writes this host's
   * `starting` record. Must succeed before `update`. On `failed` the lock is
   * released and the previous record is left unchanged.
   */
  recoverPreviousWriter(opts?: RecoverOptions): Promise<RecoverResult>;
  update(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): Promise<void>;
  /**
   * Spawns the writer in the order the protocol requires: held at the start
   * gate, identity recorded as `writer` with state `running`, then released.
   * pi cannot open the session file before its identity is in the record.
   * `spec.argv` must make pi, by its own argument rules, run in RPC mode with
   * `--session` naming this lock's file and no other session option
   * (`--continue`, `--resume`, `--session-id`, `--fork`, `--no-session`, …).
   * Only one writer spawned through the lock may run at a time.
   */
  spawnWriter(spec: Omit<SpawnSpec, "startHeld">): Promise<ManagedProcess>;
}

/** Result when another host holds the session lock. */
export interface SessionLockBusy {
  heldBy?: SessionLockRecord;
}

const PROTOCOL = "v1";
const heldKeys = new Set<string>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface RawLock {
  release(): void;
}

function aggregateFailure(errors: unknown[], message: string): AggregateError {
  const failure = new AggregateError(errors, message);
  const code = (errors[0] as NodeJS.ErrnoException | null | undefined)?.code;
  return code === undefined ? failure : Object.assign(failure, { code });
}

/** 通过已有 Error.cause 交付清理结果，保留原错误及其已有上下文。 */
function withRecoveryCause(error: unknown, result: unknown): unknown {
  if (error instanceof Error) {
    try {
      const cause = error.cause === undefined ? result : new AggregateError([error.cause, result], "恢复查询与清理上下文");
      Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
      return error;
    } catch {
      // 冻结的错误不能附加 cause，保留为聚合错误中的首项。
    }
  }
  const failure = aggregateFailure([error], "恢复查询失败，清理结果见 cause");
  Object.defineProperty(failure, "cause", { value: result, configurable: true });
  return failure;
}

/**
 * POSIX: `flock(LOCK_EX | LOCK_NB)` on `posixFile`, which is never deleted.
 * Windows: named mutex `Global\pi-hostkit-v1-<SID>-<purpose>-<sha256(key)>`; an
 * abandoned mutex counts as acquired. A key already held in this process is
 * busy, matching flock semantics across open file descriptions.
 */
function acquireRaw(purpose: string, key: string, posixFile: string): RawLock | null {
  if (process.platform === "win32" && !isMainThread) {
    // A mutex belongs to the thread that acquired it and is abandoned when that
    // thread exits, which would free the lock while the host still runs.
    throw Object.assign(new Error("pi-hostkit locks must be used from the main thread on Windows"), { code: "EHOSTKIT_THREAD" });
  }
  if (heldKeys.has(key)) return null;
  let release: () => void;
  if (process.platform === "win32") {
    const handle = nativeFn("mutexAcquire")(`Global\\pi-hostkit-${PROTOCOL}-${nativeFn("userSid")()}-${purpose}-${sha256(key)}`);
    if (handle === -1) return null;
    release = () => nativeFn("mutexRelease")(handle);
  } else {
    const fd = nativeFn("flockAcquire")(posixFile);
    if (fd === -1) return null;
    release = () => nativeFn("fdClose")(fd);
  }
  heldKeys.add(key);
  let released = false;
  let failed = false;
  let releaseFailure: unknown;
  return {
    release() {
      if (released) return;
      // close 失败后描述符或句柄可能已经失效，不能重试关闭已复用的编号。
      if (failed) throw releaseFailure;
      try {
        release();
      } catch (error) {
        failed = true;
        releaseFailure = error;
        throw error;
      }
      released = true;
      heldKeys.delete(key);
    },
  };
}

/**
 * Single-instance lock for `name` within `scopeDir` (for example the agora
 * daemon in `AGORA_HOME`). Returns null when already held. The operating system
 * releases the lock when the holder exits. Windows: release on the thread that
 * acquired it (the main thread).
 */
export async function acquireInstanceLock(name: string, scopeDir: string): Promise<HeldLock | null> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw Object.assign(new Error(`invalid lock name: ${name}`), { code: "EINVAL" });
  await mkdir(scopeDir, { recursive: true });
  assertLocalFilesystem(scopeDir);
  const dir = await realpath(scopeDir);
  const raw = acquireRaw("instance", `instance\n${comparisonKey(dir)}\n${name}`, path.join(dir, `${name}.lock`));
  if (!raw) return null;
  return {
    async release() {
      raw.release();
    },
  };
}

/** Shared lock directory: `~/.pi/hostkit/locks` on every platform. */
export function sessionLocksDir(): string {
  return path.join(homedir(), ".pi", "hostkit", "locks");
}

interface SessionPaths {
  canonical: string;
  key: string;
  lock: string;
  record: string;
}

function sessionPaths(sessionFile: string): SessionPaths {
  const canonical = realPathOrPending(path.resolve(sessionFile));
  const key = sha256(comparisonKey(canonical));
  const dir = sessionLocksDir();
  return { canonical, key, lock: path.join(dir, `session-${key}.lock`), record: path.join(dir, `session-${key}.json`) };
}

type ReadRecord = { record?: SessionLockRecord; invalid?: string };

const STATES = new Set(["starting", "running", "stopping", "released"]);
const APPS = new Set(["pi-pane", "pi-agora"]);

function isIdentity(value: unknown): value is ProcessIdentity {
  const v = value as ProcessIdentity;
  return (
    !!v &&
    typeof v === "object" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.startTime === "string" &&
    v.startTime.length > 0 &&
    typeof v.runId === "string" &&
    typeof v.instanceId === "string" &&
    (v.cgroup === undefined || typeof v.cgroup === "string")
  );
}

/** Problem with a parsed record, or undefined when it is a valid record for `key`. */
function recordProblem(value: SessionLockRecord, key: string): string | undefined {
  if (!value || typeof value !== "object") return "not an object";
  if (value.version !== 1) return "unsupported record version";
  if (!STATES.has(value.state)) return `unknown state ${String(value.state)}`;
  if (typeof value.sessionFile !== "string" || sha256(comparisonKey(value.sessionFile)) !== key) {
    return "sessionFile does not belong to this lock";
  }
  if (!value.host || !APPS.has(value.host.app) || !isIdentity(value.host.identity)) return "invalid host";
  if (value.writer !== undefined && !isIdentity(value.writer)) return "invalid writer";
  if (typeof value.updatedAt !== "string") return "invalid updatedAt";
  return undefined;
}

function readRecord(file: string, key: string): ReadRecord {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { invalid: (error as Error).message };
  }
  let value: SessionLockRecord;
  try {
    value = JSON.parse(text) as SessionLockRecord;
  } catch (error) {
    return { invalid: (error as Error).message };
  }
  try {
    const problem = recordProblem(value, key);
    return problem ? { invalid: problem } : { record: value };
  } catch (error) {
    // Stored paths are untrusted; probing them may fail before a key exists.
    return { invalid: `cannot validate record: ${(error as Error).message}` };
  }
}

/** 原子提交记录；仅清理由本次调用独占创建的临时文件。 */
function writeRecord(file: string, record: SessionLockRecord): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const data = `${JSON.stringify(record, null, 2)}\n`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(tmp, "wx", 0o600);
    created = true;
    writeFileSync(fd, data);
    const closing = fd;
    fd = undefined;
    closeSync(closing);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (error) {
        // Windows 可能因其他进程短暂打开目标记录而拒绝替换。
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } catch (error) {
    const failures: unknown[] = [error];
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (created) {
      try {
        unlinkSync(tmp);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanup);
      }
    }
    if (failures.length > 1) throw aggregateFailure(failures, `Cannot clean up lock record ${tmp}`);
    throw error;
  }
}

/** Index of a pi-hostkit gate script in `args` (a `gate.js` next to `gate-protocol.js`), or -1. */
function gateIndex(args: string[]): number {
  return args.findIndex(
    (arg, i) =>
      i <= 1 &&
      path.isAbsolute(arg) &&
      path.basename(arg) === "gate.js" &&
      pathExistsStrict(path.join(path.dirname(arg), "gate-protocol.js")),
  );
}

function sameFile(file: string, key: string): boolean {
  return comparisonKey(realPathOrPending(file)) === key;
}

type Candidates = { found: ProcessIdentity[]; uncertain: boolean; failure?: ProcessTableError };

/**
 * pi-hostkit gate processes (held, or a loaded pi whose command line is still
 * readable) that pi would run as the RPC writer of this session file. Used when
 * the previous host died between spawning pi and recording `writer`.
 *
 * The command line is `<node> <gate.js> <cli.js> <pi arguments…>`; the pi
 * arguments are interpreted with pi's own rules (`parsePiArgs`), so a
 * `--session` after `--`, or one that pi ignores, does not count. A
 * `--session` whose meaning depends on that process (relative, `~`, Windows
 * path without a drive) cannot be resolved here and makes the search uncertain. A loaded pi sets `process.title`, which
 * overwrites its command line on macOS and Linux, so it is usually not found
 * there. Not finding one is therefore never taken as proof that no writer exists.
 */
function findWritersByCommandLine(canonical: string): Candidates {
  const key = comparisonKey(canonical);
  const found: ProcessIdentity[] = [];
  let uncertain = false;
  let failure: ProcessTableError | undefined;
  let rows: ProcessRow[];
  try {
    rows = listProcesses();
  } catch (error) {
    if (!(error instanceof ProcessTableError)) throw error;
    // 部分进程表仍包含可确认的候选；清理后再报告枚举失败，不能跳过这些写者。
    rows = error.rows;
    failure = error;
    uncertain = true;
  }
  for (const row of rows) {
    if (row.pid === process.pid || row.zombie) continue;
    let args: string[] | null;
    try {
      args = processCommandLine(row.pid);
    } catch {
      uncertain = true;
      continue;
    }
    if (!args) {
      uncertain = true;
      continue;
    }
    let gate: number;
    try {
      gate = gateIndex(args);
    } catch {
      uncertain = true;
      continue;
    }
    if (gate < 0) continue;
    const target = rpcSessionFile(args.slice(gate + 2));
    if (target.uncertain) {
      uncertain = true;
      continue;
    }
    if (!target.file) continue;
    try {
      if (sameFile(target.file, key)) {
        found.push({ pid: row.pid, startTime: row.startTime, runId: "unknown", instanceId: "unknown" });
      }
    } catch {
      uncertain = true;
    }
  }
  return { found, uncertain, ...(failure ? { failure } : {}) };
}

/**
 * pi started with `argv` (`[cliEntry, ...pi arguments]`) must open exactly
 * this lock's file as its RPC session, by pi's own argument rules, and nothing
 * may make it pick another session. The `--session` value must be an absolute
 * path that does not depend on pi's environment or working directory (no `~`,
 * no relative path, on Windows a drive letter or UNC path).
 */
function assertSessionArg(argv: string[], canonical: string): void {
  const piArgs = argv.slice(1);
  const target = rpcSessionFile(piArgs);
  let ok = false;
  try {
    ok = !!target.file && hasOnlyExplicitSession(piArgs) && sameFile(target.file, comparisonKey(canonical));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw Object.assign(
      new Error(`spawnWriter argv must start pi in RPC mode with --session ${canonical} and no other session option`),
      { code: "EINVAL" },
    );
  }
}

class WriterLock implements SessionWriterLock {
  readonly recoveryReports: StopReport[] = [];
  private state: "acquired" | "recovered" | "release_unknown" | "released" = "acquired";
  private releaseFailure: unknown;
  private current: SessionLockRecord | undefined;
  /** Operations on one lock run one at a time, in call order. */
  private queue: Promise<unknown> = Promise.resolve();
  private writer: ManagedProcess | undefined;
  private writerExited = true;

  constructor(
    private readonly raw: RawLock,
    private readonly paths: SessionPaths,
    private readonly host: LockHost,
    readonly previous: SessionLockRecord | undefined,
    private readonly invalidPrevious: string | undefined,
  ) {}

  get sessionFile(): string {
    return this.paths.canonical;
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  private requireState(state: "acquired" | "recovered", action: string): void {
    if (this.state !== state) {
      throw Object.assign(new Error(`${action}: lock is ${this.state}`), { code: "EHOSTKIT_LOCK_STATE" });
    }
  }

  /** 原生释放开始后立即终止可写状态；报错时不能假定内核锁仍然持有。 */
  private abandon(): void {
    if (this.state === "release_unknown") throw this.releaseFailure;
    this.state = "release_unknown";
    try {
      this.raw.release();
    } catch (error) {
      this.releaseFailure = error;
      throw error;
    }
    this.state = "released";
  }

  private abandonAfter(error: unknown): never {
    try {
      this.abandon();
    } catch (cleanup) {
      throw aggregateFailure([error, cleanup], "Cannot release failed session lock");
    }
    throw error;
  }

  recoverPreviousWriter(opts: RecoverOptions = {}): Promise<RecoverResult> {
    return this.serial(async () => {
      this.requireState("acquired", "recoverPreviousWriter");
      let result: RecoverResult;
      try {
        result = await this.recover(opts);
      } catch (error) {
        this.abandonAfter(error);
      }
      if (result === "failed") {
        this.abandon();
        return result;
      }
      const record: SessionLockRecord = {
        version: 1,
        sessionFile: this.paths.canonical,
        host: this.host,
        state: "starting",
        updatedAt: new Date().toISOString(),
      };
      try {
        writeRecord(this.paths.record, record);
      } catch (error) {
        this.abandonAfter(error);
      }
      this.current = record;
      this.state = "recovered";
      return result;
    });
  }

  /**
   * Stops one recorded or found writer. Succeeds only when the stop report
   * shows nothing left within its coverage and the writer is gone.
   */
  private async stopWriter(writer: ProcessIdentity, opts: StopOptions): Promise<RecoverResult> {
    let queryFailed = false;
    let queryError: unknown;
    let alive: boolean | undefined;
    try {
      alive = (await isSameProcess(writer)) === "alive";
      if (!alive && !scopePopulated(writer)) return "none";
    } catch (error) {
      queryFailed = true;
      queryError = error;
    }
    let report: StopReport;
    try {
      report = await stopByIdentity(writer, opts);
    } catch (error) {
      // 前置查询未知不能跳过独立清理，清理拒绝也不能覆盖原查询错误。
      throw queryFailed ? withRecoveryCause(queryError, error) : error;
    }
    if (queryFailed) {
      report = { ...report, steps: [{
        step: "query writer before recovery", ok: false, at: new Date().toISOString(),
        detail: queryError instanceof Error ? queryError.message : String(queryError),
      }, ...report.steps] };
    }
    this.recoveryReports.push(report);
    if (queryFailed) throw withRecoveryCause(queryError, report);
    if (report.leftovers.length) return "failed";
    try {
      if ((await isSameProcess(writer)) === "alive" || scopePopulated(writer)) return "failed";
    } catch (error) {
      throw withRecoveryCause(error, report);
    }
    return "stopped";
  }

  private async recover(opts: RecoverOptions): Promise<RecoverResult> {
    const { assumeNoWriter, ...stopOpts } = opts;
    if (this.invalidPrevious && !assumeNoWriter) return "failed";
    const previous = this.previous;
    if (!previous || previous.state === "released") return "none";
    if (previous.writer) return this.stopWriter(previous.writer, stopOpts);
    // No writer recorded: the previous host may have died between spawn and record.
    const { found, uncertain, failure } = findWritersByCommandLine(this.paths.canonical);
    let stopped = false;
    let failed = false;
    const failures: unknown[] = failure ? [failure] : [];
    for (const candidate of found) {
      try {
        const result = await this.stopWriter(candidate, stopOpts);
        if (result === "failed") failed = true;
        if (result === "stopped") stopped = true;
      } catch (error) {
        // 一个候选的停止失败不能阻断其他已知候选的清理。
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateFailure(failures, "Cannot recover session writers");
    if (failed) return "failed";
    if (stopped && !uncertain) return "stopped";
    // Not finding one does not prove there is none (overwritten, truncated or
    // unreadable command lines, relative --session values).
    return assumeNoWriter ? (stopped ? "stopped" : "none") : "failed";
  }

  update(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): Promise<void> {
    return this.serial(async () => this.writeUpdate(patch));
  }

  private writeUpdate(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): void {
    this.requireState("recovered", "update");
    if (patch.state !== undefined && (!STATES.has(patch.state) || patch.state === "released")) {
      throw Object.assign(new Error(`invalid state ${patch.state}; use release()`), { code: "EINVAL" });
    }
    if (patch.writer !== undefined && !isIdentity(patch.writer)) {
      throw Object.assign(new Error("invalid writer identity"), { code: "EINVAL" });
    }
    // Fields given as undefined are left unchanged, so the record stays complete.
    const next: SessionLockRecord = { ...this.current!, updatedAt: new Date().toISOString() };
    if (patch.state !== undefined) next.state = patch.state;
    if (patch.writer !== undefined) next.writer = patch.writer;
    writeRecord(this.paths.record, next);
    this.current = next;
  }

  spawnWriter(spec: Omit<SpawnSpec, "startHeld">): Promise<ManagedProcess> {
    return this.serial(async () => {
      this.requireState("recovered", "spawnWriter");
      if (!this.writerExited) {
        throw Object.assign(new Error("a writer spawned through this lock is still running"), { code: "EHOSTKIT_LOCK_STATE" });
      }
      assertSessionArg(spec.argv, this.paths.canonical);
      const proc = await spawnManaged({ ...spec, startHeld: true });
      // 记录提交失败时仍须记住活写者，防止普通 release 或后续 spawn 绕过身份核对。
      this.writer = proc;
      this.writerExited = false;
      void proc.exited.then(() => {
        if (this.writer === proc) this.writerExited = true;
      });
      try {
        this.writeUpdate({ writer: proc.identity, state: "running" });
        proc.release();
      } catch (error) {
        await this.stopFailedWriter(proc, error);
      }
      return proc;
    });
  }

  private async stopFailedWriter(proc: ManagedProcess, error: unknown): Promise<never> {
    let report: StopReport;
    try {
      report = await proc.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
    } catch (cleanup) {
      throw aggregateFailure([error, cleanup], "Cannot stop failed session writer");
    }
    const failed = report.steps.filter((step) => !step.ok && step.step !== "grace" &&
      !(step.step === "abort" && ["process held at the start gate", "process already exited"].includes(step.detail ?? "")) &&
      !(step.step === "SIGKILL pi" && step.detail === "not running or identity changed"));
    if (report.leftovers.length || failed.length) {
      // 调用方拿不到失败的 ManagedProcess，停止报告必须随抛出的错误保留。
      const cleanup = new Error(`Cannot stop failed session writer: ${failed.length} failed steps; ${report.leftovers.length} leftovers`, { cause: report });
      throw aggregateFailure([error, cleanup], "Cannot stop failed session writer");
    }
    throw error;
  }

  /** Commit the released record before changing ownership or in-memory state. */
  release(opts: { writerSwitchedAway?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (this.state === "released") return;
      if (this.state === "release_unknown") throw this.releaseFailure;
      const record = this.current ?? (this.previous?.state !== "released" ? this.previous : undefined);
      if (!opts.writerSwitchedAway) {
        const writers = [record?.writer];
        if (this.writer && !this.writerExited && !writers.includes(this.writer.identity)) writers.push(this.writer.identity);
        try {
          for (const writer of writers) {
            if (writer && (await isSameProcess(writer)) !== "gone") {
              throw new Error("the session writer is still running");
            }
          }
        } catch (cause) {
          throw Object.assign(new Error("release: writer exit cannot be confirmed", { cause }), { code: "EHOSTKIT_LOCK_STATE" });
        }
      }
      if (this.state === "recovered" && this.current) {
        const next: SessionLockRecord = { ...this.current, state: "released", updatedAt: new Date().toISOString() };
        writeRecord(this.paths.record, next);
        this.current = next;
      }
      this.abandon();
    });
  }
}

async function prepareLocksDir(): Promise<void> {
  const dir = sessionLocksDir();
  mkdirSync(path.dirname(dir), { recursive: true });
  await ensurePrivateDir(dir);
  assertLocalFilesystem(dir);
}

/**
 * Session writer lock: at most one managed writer per session file across
 * pi-pane and pi-agora. Acquire before pi can open the file. Returns a
 * `SessionWriterLock`, or `{ heldBy }` when another host holds it.
 */
export async function acquireSessionWriterLock(
  sessionFile: string,
  host: LockHost,
): Promise<SessionWriterLock | SessionLockBusy> {
  await prepareLocksDir();
  const paths = sessionPaths(sessionFile);
  // The lock only excludes hosts on this machine; a session on a network
  // file system could be opened from another machine with its own lock directory.
  assertLocalFilesystem(paths.canonical);
  const raw = acquireRaw("session", `session\n${paths.key}`, paths.lock);
  if (!raw) return { heldBy: readRecord(paths.record, paths.key).record };
  try {
    const { record, invalid } = readRecord(paths.record, paths.key);
    return new WriterLock(raw, paths, host, record, invalid);
  } catch (error) {
    try {
      raw.release();
    } catch (cleanup) {
      throw aggregateFailure([error, cleanup], "Cannot release failed session acquisition");
    }
    throw error;
  }
}

export function isSessionWriterLock(value: SessionWriterLock | SessionLockBusy): value is SessionWriterLock {
  return typeof (value as SessionWriterLock).release === "function";
}

/** Whether a host holds the session lock, and the shared record. Does not keep the lock. */
export async function probeSessionWriterLock(sessionFile: string): Promise<{ held: boolean; record?: SessionLockRecord }> {
  await prepareLocksDir();
  const paths = sessionPaths(sessionFile);
  const raw = acquireRaw("session", `session\n${paths.key}`, paths.lock);
  const failures: unknown[] = [];
  try {
    const { record } = readRecord(paths.record, paths.key);
    return { held: !raw, ...(record ? { record } : {}) };
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    try {
      raw?.release();
    } catch (cleanup) {
      if (failures.length) throw aggregateFailure([...failures, cleanup], "Cannot release failed session probe");
      throw cleanup;
    }
  }
}

