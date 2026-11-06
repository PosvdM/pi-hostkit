import type { Readable, Writable } from "node:stream";

/** A pi RPC command. The transport always generates a wire id and restores the caller's id in the response. */
export interface RpcCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** Any stdout record other than a response or an extension UI request. */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** Answer to a dialog request (`select`, `confirm`, `input`, `editor`). */
export interface ExtensionUiResponse {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  [key: string]: unknown;
}

/** Things the transport drops but a host may want to log. */
export type RpcDiagnostic =
  | { kind: "late_response"; response: RpcResponse }
  | { kind: "unmatched_response"; response: RpcResponse };

export interface RpcTransport {
  /**
   * Sends a command and resolves with its response. The transport puts its own
   * unique id on the wire; when `cmd.id` is given, the response carries it.
   */
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>;
  onEvent(listener: (ev: RpcEvent) => void): () => void;
  onUiRequest(listener: (req: ExtensionUiRequest) => void): () => void;
  respondUi(res: ExtensionUiResponse): void;
  /** Closes pi's stdin; pi shuts down when its input ends. */
  closeInput(): void;
  /** Protocol errors (oversized or invalid record) and stream failures. The transport is unusable afterwards. */
  onError(listener: (error: Error) => void): () => void;
  onDiagnostic(listener: (d: RpcDiagnostic) => void): () => void;
  /** Resolves when stdout has ended. */
  readonly closed: Promise<void>;
}

export interface RpcTransportOptions {
  /** Maximum bytes of one record; default 64 MiB. */
  maxRecordBytes?: number;
  /** Maximum UTF-8 bytes awaiting write completion, including LF; default 64 MiB. */
  maxQueuedBytes?: number;
}

export const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_TIMED_OUT_IDS = 1024;

function serializeLine(record: object): string {
  const json = JSON.stringify(record);
  if (json === undefined) throw new TypeError("RPC record did not serialize to JSON");
  return `${json}\n`;
}

export class RpcTimeoutError extends Error {
  readonly code = "EHOSTKIT_RPC_TIMEOUT";
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`RPC ${command} timed out after ${timeoutMs} ms`);
  }
}

export class RpcProtocolError extends Error {
  readonly code = "EHOSTKIT_RPC_PROTOCOL";
}

export class RpcClosedError extends Error {
  readonly code = "EHOSTKIT_RPC_CLOSED";
}

type Listener<T> = (value: T) => void;

class Listeners<T> {
  private set = new Set<Listener<T>>();
  add(listener: Listener<T>): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.set]) {
      try {
        listener(value);
      } catch (error) {
        // A listener bug must not be mistaken for a protocol error; surface it like EventEmitter would.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
  get size(): number {
    return this.set.size;
  }
}

/**
 * Splits a byte stream into records on LF only, removing an optional CR before
 * it. Records are decoded as UTF-8 after splitting; LF (0x0A) never occurs
 * inside a multi-byte UTF-8 sequence. `readline` is not used because it also
 * splits on U+2028 and U+2029, which are valid inside JSON strings.
 */
export class JsonlSplitter {
  private chunks: Buffer[] = [];
  private length = 0;

  constructor(
    private readonly onRecord: (line: string) => void,
    private readonly maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(0x0a, start);
      if (lf < 0) break;
      this.append(chunk.subarray(start, lf));
      let record = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.length);
      this.chunks = [];
      this.length = 0;
      if (record.length && record[record.length - 1] === 0x0d) record = record.subarray(0, record.length - 1);
      start = lf + 1;
      this.onRecord(record.toString("utf8"));
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
  }

  /** Called at end of stream; a trailing record without LF is a protocol error. */
  end(): void {
    if (this.length > 0) {
      this.chunks = [];
      this.length = 0;
      throw new RpcProtocolError("stdout ended inside a record (missing LF)");
    }
  }

  private append(part: Buffer): void {
    if (this.length + part.length > this.maxRecordBytes) {
      this.chunks = [];
      this.length = 0;
      throw new RpcProtocolError(`RPC record exceeds ${this.maxRecordBytes} bytes`);
    }
    if (part.length) {
      // Copy: the stream may reuse its buffer.
      this.chunks.push(Buffer.from(part));
      this.length += part.length;
    }
  }
}

interface Pending {
  resolve(res: RpcResponse): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
  command: string;
  /** `cmd.id` given by the caller; the response carries it instead of the wire id. */
  callerId?: string;
}

/** JSONL transport over a pi process's stdin and stdout. */
export class StdioRpcTransport implements RpcTransport {
  private pending = new Map<string, Pending>();
  private timedOut = new Set<string>();
  private nextId = 0;
  private failure: Error | undefined;
  private blockedReason: string | undefined;
  private readonly maxQueuedBytes: number;
  private readonly writes: { line: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private waitingDrain = false;
  private pumping = false;
  private inputClosing = false;
  private readonly onDrain = () => {
    this.waitingDrain = false;
    this.flushWrites();
  };
  private readonly events = new Listeners<RpcEvent>();
  private readonly uiRequests = new Listeners<ExtensionUiRequest>();
  private readonly errors = new Listeners<Error>();
  private readonly diagnostics = new Listeners<RpcDiagnostic>();
  readonly closed: Promise<void>;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    opts: RpcTransportOptions = {},
  ) {
    this.maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (!Number.isSafeInteger(this.maxQueuedBytes) || this.maxQueuedBytes <= 0) {
      throw new RangeError("maxQueuedBytes must be a positive safe integer");
    }
    const splitter = new JsonlSplitter((line) => this.handleLine(line), opts.maxRecordBytes);
    stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      try {
        splitter.push(chunk);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.closed = new Promise((resolve) => {
      const finish = () => {
        try {
          splitter.end();
        } catch (error) {
          this.fail(error as Error);
        }
        this.fail(new RpcClosedError("pi stdout closed"), false);
        resolve();
      };
      stdout.once("end", finish);
      stdout.once("close", finish);
    });
    stdout.on("error", (error) => this.fail(error));
    stdin.on("error", (error) => this.fail(error));
    stdin.on("close", () => {
      if (!stdin.writableFinished) this.fail(new RpcClosedError("pi stdin closed before writes completed"));
    });
  }

  /** While blocked, `send` and `respondUi` throw; used while a process is held at the gate. */
  block(reason: string | undefined): void {
    this.blockedReason = reason;
  }

  /** Enqueues a raw line without the blocked check; the gate release uses it. */
  writeRaw(line: string): void {
    this.enqueueWrite(line);
  }

  send(cmd: RpcCommand, opts: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.blockedReason) return Promise.reject(new RpcClosedError(this.blockedReason));
    // The id on the wire is always generated here and never repeats, so a late
    // response to a timed-out command can never be matched to a newer one,
    // even when the caller reuses its own id. The caller's id is put back on
    // the response.
    const id = `hk-${++this.nextId}`;
    let line: string;
    let command: string;
    let callerId: string | undefined;
    try {
      const record = { ...cmd };
      command = record.type;
      callerId = record.id;
      line = serializeLine({ ...record, id });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const entry: Pending = { resolve, reject, command, ...(callerId !== undefined ? { callerId } : {}) };
      if (opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.timedOut.add(id);
          // Bound the set; a forgotten id's late response is reported as unmatched.
          // Wire ids are never reused, so forgetting one cannot misroute a response.
          if (this.timedOut.size > MAX_TIMED_OUT_IDS) this.timedOut.delete(this.timedOut.values().next().value!);
          reject(new RpcTimeoutError(command, opts.timeoutMs!));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.enqueueWrite(line);
      } catch (error) {
        this.settle(id, undefined, error as Error);
      }
    });
  }

  onEvent(listener: (ev: RpcEvent) => void): () => void {
    return this.events.add(listener);
  }

  onUiRequest(listener: (req: ExtensionUiRequest) => void): () => void {
    return this.uiRequests.add(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return this.errors.add(listener);
  }

  onDiagnostic(listener: (d: RpcDiagnostic) => void): () => void {
    return this.diagnostics.add(listener);
  }

  respondUi(res: ExtensionUiResponse): void {
    if (this.failure) throw this.failure;
    if (this.blockedReason) throw new RpcClosedError(this.blockedReason);
    this.enqueueWrite(serializeLine({ ...res, type: "extension_ui_response" }));
  }

  closeInput(): void {
    if (this.inputClosing) return;
    this.inputClosing = true;
    if (this.failure) {
      if (!this.stdin.writableEnded) this.stdin.end();
      return;
    }
    this.flushWrites();
  }

  private enqueueWrite(line: string): void {
    if (this.failure) throw this.failure;
    if (this.inputClosing || this.stdin.writableEnded || this.stdin.destroyed) {
      throw new RpcClosedError("pi stdin is closed");
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxQueuedBytes - this.queuedBytes) {
      throw Object.assign(new Error(`RPC write queue exceeds ${this.maxQueuedBytes} bytes`), {
        code: "EHOSTKIT_RPC_QUEUE_FULL",
      });
    }
    this.writes.push({ line, bytes });
    this.queuedBytes += bytes;
    this.flushWrites();
    if (this.failure) throw this.failure;
  }

  private flushWrites(): void {
    if (this.pumping || this.failure) return;
    this.pumping = true;
    try {
      while (!this.waitingDrain && this.writes.length && !this.failure) {
        const entry = this.writes.shift()!;
        const writable = this.stdin.write(entry.line, (error) => {
          if (this.failure) return;
          this.queuedBytes -= entry.bytes;
          if (error) this.fail(error);
        });
        if (!writable && !this.failure) {
          this.waitingDrain = true;
          this.stdin.once("drain", this.onDrain);
        }
      }
      if (this.inputClosing && !this.writes.length && !this.stdin.writableEnded && !this.failure) {
        this.waitingDrain = false;
        this.stdin.removeListener("drain", this.onDrain);
        this.stdin.end();
      }
    } catch (error) {
      this.fail(error as Error);
    } finally {
      this.pumping = false;
    }
  }

  private settle(id: string, res: RpcResponse | undefined, error?: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(entry.callerId !== undefined ? { ...res!, id: entry.callerId } : res!);
  }

  private handleLine(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new RpcProtocolError(`invalid JSON record from pi: ${line.slice(0, 200)}`);
    }
    if (!record || typeof record !== "object" || typeof (record as RpcEvent).type !== "string") {
      throw new RpcProtocolError(`RPC record without type: ${line.slice(0, 200)}`);
    }
    const typed = record as RpcEvent;
    if (typed.type === "response") {
      const res = typed as RpcResponse;
      if (res.id !== undefined && this.pending.has(res.id)) this.settle(res.id, res);
      else if (res.id !== undefined && this.timedOut.delete(res.id)) this.diagnostics.emit({ kind: "late_response", response: res });
      else this.diagnostics.emit({ kind: "unmatched_response", response: res });
    } else if (typed.type === "extension_ui_request") {
      this.uiRequests.emit(typed as ExtensionUiRequest);
    } else {
      this.events.emit(typed);
    }
  }

  private fail(error: Error, report = true): void {
    if (this.failure) return;
    this.failure = error;
    this.writes.length = 0;
    this.queuedBytes = 0;
    this.waitingDrain = false;
    this.stdin.removeListener("drain", this.onDrain);
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, error);
    if (this.inputClosing && !this.stdin.writableEnded) {
      try {
        this.stdin.end();
      } catch {
        // Preserve the first failure if ending a broken stream also throws.
      }
    }
    if (report) this.errors.emit(error);
  }
}
