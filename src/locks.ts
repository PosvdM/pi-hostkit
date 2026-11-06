import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { assertLocalFilesystem } from "./localfs.js";
import { nativeFn } from "./native.js";
import { comparisonKey, realPathOrPending } from "./paths.js";
import {
  isSameProcess,
  spawnManaged,
  stopByIdentity,
  type ManagedProcess,
  type ProcessIdentity,
  type SpawnSpec,
  type StopOptions,
  type StopReport,
} from "./process.js";
import { listProcesses, processCommandLine } from "./proctable.js";
import { ensurePrivateDir } from "./secrets.js";

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

export interface SessionWriterLock extends HeldLock {
  /** Canonical session file path. */
  readonly sessionFile: string;
  /** Record found when the lock was acquired. */
  readonly previous?: SessionLockRecord;
  /** Stop reports of previous writers stopped by `recoverPreviousWriter`. */
  readonly recoveryReports: readonly StopReport[];
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

/**
 * POSIX: `flock(LOCK_EX | LOCK_NB)` on `posixFile`, which is never deleted.
 * Windows: named mutex `Local\pi-hostkit-v1-<purpose>-<sha256(key)>`; an
 * abandoned mutex counts as acquired. A key already held in this process is
 * busy, matching flock semantics across open file descriptions.
 */
function acquireRaw(purpose: string, key: string, posixFile: string): RawLock | null {
  if (heldKeys.has(key)) return null;
  let release: () => void;
  if (process.platform === "win32") {
    const handle = nativeFn("mutexAcquire")(`Local\\pi-hostkit-${PROTOCOL}-${purpose}-${sha256(key)}`);
    if (handle === -1) return null;
    release = () => nativeFn("mutexRelease")(handle);
  } else {
    const fd = nativeFn("flockAcquire")(posixFile);
    if (fd === -1) return null;
    release = () => nativeFn("fdClose")(fd);
  }
  heldKeys.add(key);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      heldKeys.delete(key);
      release();
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

function readRecord(file: string): ReadRecord {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { invalid: (error as Error).message };
  }
  try {
    const value = JSON.parse(text) as SessionLockRecord;
    if (value?.version !== 1 || typeof value.state !== "string") return { invalid: "unsupported record version" };
    return { record: value };
  } catch (error) {
    return { invalid: (error as Error).message };
  }
}

/** Writes the record atomically (temporary file, then rename). */
function writeRecord(file: string, record: SessionLockRecord): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open for a moment.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
        try {
          unlinkSync(tmp);
        } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function hasRpcMode(args: string[]): boolean {
  return args.some((arg, i) => arg === "--mode=rpc" || (arg === "--mode" && args[i + 1] === "rpc"));
}

/**
 * Processes whose command line names this session file and RPC mode. Used when
 * the previous host died between spawning pi and recording `writer`. A process
 * still held at the start gate keeps its original command line; a loaded pi
 * sets `process.title`, which overwrites the command line on macOS and Linux,
 * so a released pi is usually not found there. Not finding one is therefore
 * never taken as proof that no writer exists.
 */
function findWritersByCommandLine(canonical: string): ProcessIdentity[] {
  const key = comparisonKey(canonical);
  const found: ProcessIdentity[] = [];
  for (const row of listProcesses()) {
    if (row.pid === process.pid || row.zombie) continue;
    const cmd = processCommandLine(row.pid);
    if (!cmd) continue;
    let match = false;
    if (typeof cmd === "string") {
      const lower = cmd.toLowerCase();
      match = /--mode(=|\s+)"?rpc\b/.test(lower) && lower.includes(key);
    } else if (hasRpcMode(cmd)) {
      match = cmd.some((arg) => {
        if (!path.isAbsolute(arg)) return false;
        try {
          return comparisonKey(realPathOrPending(arg)) === key;
        } catch {
          return false;
        }
      });
    }
    if (match) found.push({ pid: row.pid, startTime: row.startTime, runId: "unknown", instanceId: "unknown" });
  }
  return found;
}

class WriterLock implements SessionWriterLock {
  readonly recoveryReports: StopReport[] = [];
  private state: "acquired" | "recovered" | "released" = "acquired";
  private current: SessionLockRecord | undefined;

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

  async recoverPreviousWriter(opts: RecoverOptions = {}): Promise<RecoverResult> {
    if (this.state !== "acquired") throw Object.assign(new Error(`lock is ${this.state}`), { code: "EHOSTKIT_LOCK_STATE" });
    const result = await this.recover(opts);
    if (result === "failed") {
      this.state = "released";
      this.raw.release();
      return result;
    }
    this.current = {
      version: 1,
      sessionFile: this.paths.canonical,
      host: this.host,
      state: "starting",
      updatedAt: new Date().toISOString(),
    };
    writeRecord(this.paths.record, this.current);
    this.state = "recovered";
    return result;
  }

  private async stopAll(writers: ProcessIdentity[], opts: StopOptions): Promise<RecoverResult> {
    let stopped = false;
    for (const writer of writers) {
      if ((await isSameProcess(writer)) === "gone") continue;
      this.recoveryReports.push(await stopByIdentity(writer, opts));
      if ((await isSameProcess(writer)) === "alive") return "failed";
      stopped = true;
    }
    return stopped ? "stopped" : "none";
  }

  private async recover(opts: RecoverOptions): Promise<RecoverResult> {
    const { assumeNoWriter, ...stopOpts } = opts;
    if (this.invalidPrevious && !assumeNoWriter) return "failed";
    const previous = this.previous;
    if (!previous || previous.state === "released") return "none";
    if (previous.writer) return this.stopAll([previous.writer], stopOpts);
    // No writer recorded: the previous host may have died between spawn and record.
    const candidates = findWritersByCommandLine(this.paths.canonical);
    if (candidates.length) return this.stopAll(candidates, stopOpts);
    // Not finding one does not prove there is none (truncated or unreadable command lines).
    return assumeNoWriter ? "none" : "failed";
  }

  async update(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): Promise<void> {
    if (this.state !== "recovered" || !this.current) {
      throw Object.assign(new Error("call recoverPreviousWriter() before update()"), { code: "EHOSTKIT_LOCK_STATE" });
    }
    this.current = { ...this.current, ...patch, updatedAt: new Date().toISOString() };
    writeRecord(this.paths.record, this.current);
  }

  async spawnWriter(spec: Omit<SpawnSpec, "startHeld">): Promise<ManagedProcess> {
    if (this.state !== "recovered") {
      throw Object.assign(new Error("call recoverPreviousWriter() before spawnWriter()"), { code: "EHOSTKIT_LOCK_STATE" });
    }
    const proc = await spawnManaged({ ...spec, startHeld: true });
    try {
      await this.update({ writer: proc.identity, state: "running" });
    } catch (error) {
      await proc.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
      throw error;
    }
    proc.release();
    return proc;
  }

  /** Writes `released` (when this host wrote a record) and releases the lock. */
  async release(): Promise<void> {
    if (this.state === "released") return;
    try {
      if (this.state === "recovered" && this.current) {
        this.current = { ...this.current, state: "released", updatedAt: new Date().toISOString() };
        writeRecord(this.paths.record, this.current);
      }
    } finally {
      this.state = "released";
      this.raw.release();
    }
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
  const raw = acquireRaw("session", `session\n${paths.key}`, paths.lock);
  if (!raw) return { heldBy: readRecord(paths.record).record };
  const { record, invalid } = readRecord(paths.record);
  return new WriterLock(raw, paths, host, record, invalid);
}

export function isSessionWriterLock(value: SessionWriterLock | SessionLockBusy): value is SessionWriterLock {
  return typeof (value as SessionWriterLock).release === "function";
}

/** Whether a host holds the session lock, and the shared record. Does not keep the lock. */
export async function probeSessionWriterLock(sessionFile: string): Promise<{ held: boolean; record?: SessionLockRecord }> {
  await prepareLocksDir();
  const paths = sessionPaths(sessionFile);
  const raw = acquireRaw("session", `session\n${paths.key}`, paths.lock);
  const { record } = readRecord(paths.record);
  if (!raw) return { held: true, ...(record ? { record } : {}) };
  raw.release();
  return { held: false, ...(record ? { record } : {}) };
}

