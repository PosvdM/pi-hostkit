import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import { JsonlSplitter, RpcProtocolError, RpcTimeoutError, StdioRpcTransport } from "../dist/index.js";

function split(chunks, max) {
  const out = [];
  const splitter = new JsonlSplitter((line) => out.push(line), max);
  for (const chunk of chunks) splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  splitter.end();
  return out;
}

describe("JsonlSplitter", () => {
  test("splits on LF only; U+2028 and U+2029 stay inside records", () => {
    const record = JSON.stringify({ text: "a\u2028b\u2029c" });
    assert.deepEqual(split([`${record}\n`]), [record]);
  });

  test("strips one CR before LF", () => {
    assert.deepEqual(split(['{"a":1}\r\n{"b":2}\n']), ['{"a":1}', '{"b":2}']);
  });

  test("joins records across chunks, including a split multi-byte character", () => {
    const bytes = Buffer.from('{"t":"汉字"}\n');
    const parts = [bytes.subarray(0, 8), bytes.subarray(8, 9), bytes.subarray(9)];
    assert.deepEqual(split(parts), ['{"t":"汉字"}']);
  });

  test("rejects a record over the limit", () => {
    assert.throws(() => split(["x".repeat(20)], 10), RpcProtocolError);
    assert.deepEqual(split(["x".repeat(10) + "\n"], 10), ["x".repeat(10)]);
  });

  test("a final record without LF is a protocol error", () => {
    assert.throws(() => split(['{"a":1}']), RpcProtocolError);
  });
});

function transport(opts) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written = [];
  stdin.on("data", (c) => written.push(...c.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  const rpc = new StdioRpcTransport(stdin, stdout, opts);
  const emit = (obj) => stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  return { rpc, stdin, stdout, written, emit, tick: () => new Promise((r) => setImmediate(r)) };
}

class ControlledWritable extends Writable {
  calls = [];
  callbacks = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  write(...args) {
    this.calls.push(String(args[0]));
    return super.write(...args);
  }

  _write(_chunk, _encoding, callback) {
    this.callbacks.push(callback);
  }

  complete(error) {
    assert.ok(this.callbacks.length, "a write is in flight");
    this.callbacks.shift()(error);
  }
}

function backpressuredTransport(opts) {
  const stdin = new ControlledWritable();
  const stdout = new PassThrough();
  const rpc = new StdioRpcTransport(stdin, stdout, opts);
  return { stdin, stdout, rpc, tick: () => new Promise((resolve) => setImmediate(resolve)) };
}

describe("StdioRpcTransport", () => {
  test("assigns wire ids and matches responses by id, out of order", async () => {
    const t = transport();
    const a = t.rpc.send({ type: "get_state" });
    const b = t.rpc.send({ type: "get_messages" });
    await t.tick();
    assert.deepEqual(
      t.written.map((w) => w.type),
      ["get_state", "get_messages"],
    );
    t.emit({ type: "response", id: t.written[1].id, command: "get_messages", success: true });
    t.emit({ type: "response", id: t.written[0].id, command: "get_state", success: true, data: { x: 1 } });
    assert.equal((await a).data.x, 1);
    assert.equal((await b).command, "get_messages");
  });

  test("routes events and extension UI requests; respondUi writes extension_ui_response", async () => {
    const t = transport();
    const events = [];
    const ui = [];
    t.rpc.onEvent((e) => events.push(e.type));
    t.rpc.onUiRequest((r) => ui.push(r));
    t.emit({ type: "agent_start" });
    t.emit({ type: "extension_ui_request", id: "u1", method: "confirm", title: "ok?" });
    await t.tick();
    assert.deepEqual(events, ["agent_start"]);
    assert.equal(ui[0].method, "confirm");
    t.rpc.respondUi({ id: "u1", confirmed: true });
    await t.tick();
    assert.deepEqual(t.written.at(-1), { id: "u1", confirmed: true, type: "extension_ui_response" });
  });

  test("timeout rejects; a late response is reported as a diagnostic", async () => {
    const t = transport();
    const diagnostics = [];
    t.rpc.onDiagnostic((d) => diagnostics.push(d.kind));
    const p = t.rpc.send({ type: "abort" }, { timeoutMs: 20 });
    await assert.rejects(p, RpcTimeoutError);
    t.emit({ type: "response", id: t.written[0].id, command: "abort", success: true });
    t.emit({ type: "response", id: "nobody", command: "x", success: true });
    await t.tick();
    assert.deepEqual(diagnostics, ["late_response", "unmatched_response"]);
  });

  test("a late response never reaches a newer command, even with the same caller id", async () => {
    const t = transport();
    const diagnostics = [];
    t.rpc.onDiagnostic((d) => diagnostics.push(d.kind));
    await assert.rejects(t.rpc.send({ type: "abort", id: "x" }, { timeoutMs: 10 }), RpcTimeoutError);
    // More than the remembered number of timeouts, so the first wire id is forgotten.
    for (let i = 0; i < 1030; i++) await assert.rejects(t.rpc.send({ type: "noop", id: "x" }, { timeoutMs: 0 }), RpcTimeoutError);
    const next = t.rpc.send({ type: "get_state", id: "x" });
    await t.tick();
    const wire = t.written.map((w) => w.id);
    assert.equal(new Set(wire).size, wire.length, "wire ids are unique");
    // The first command's late response arrives first.
    t.emit({ type: "response", id: wire[0], command: "abort", success: true });
    t.emit({ type: "response", id: wire.at(-1), command: "get_state", success: true });
    const res = await next;
    assert.equal(res.command, "get_state");
    assert.equal(res.id, "x", "the caller's id is put back on the response");
    assert.deepEqual(diagnostics, ["unmatched_response"]);
  });

  test("invalid JSON fails the transport and rejects pending commands", async () => {
    const t = transport();
    const errors = [];
    t.rpc.onError((e) => errors.push(e));
    const p = t.rpc.send({ type: "get_state" });
    t.emit("not json");
    await assert.rejects(p, RpcProtocolError);
    assert.equal(errors.length, 1);
    await assert.rejects(t.rpc.send({ type: "get_state" }), RpcProtocolError);
    t.rpc.closeInput();
    assert.equal(t.stdin.writableEnded, true, "shutdown still closes stdin after a protocol failure");
  });

  test("stdout end rejects pending commands", async () => {
    const t = transport();
    const p = t.rpc.send({ type: "get_state" });
    t.stdout.end();
    await assert.rejects(p, { code: "EHOSTKIT_RPC_CLOSED" });
    await t.rpc.closed;
  });

  test("gate, RPC and UI share an ordered queue until drain; closeInput flushes it", async () => {
    const t = backpressuredTransport();
    t.rpc.block("held at gate");
    t.rpc.writeRaw("gate-release\n");
    t.rpc.block(undefined);
    const first = t.rpc.send({ type: "get_state" });
    t.rpc.respondUi({ id: "u1", confirmed: true });
    const last = t.rpc.send({ type: "get_messages" });
    t.rpc.closeInput();
    t.rpc.closeInput();
    await assert.rejects(t.rpc.send({ type: "after_close" }), { code: "EHOSTKIT_RPC_CLOSED" });
    assert.throws(() => t.rpc.respondUi({ id: "after_close" }), { code: "EHOSTKIT_RPC_CLOSED" });
    assert.deepEqual(t.stdin.calls, ["gate-release\n"]);
    assert.equal(t.stdin.writableEnded, false);

    for (let i = 0; i < 3; i++) {
      t.stdin.complete();
      await t.tick();
      assert.equal(t.stdin.calls.length, i + 2, "only one write is passed to the stream per drain");
    }
    assert.deepEqual(t.stdin.calls.slice(1).map((line) => JSON.parse(line).type), [
      "get_state", "extension_ui_response", "get_messages",
    ]);
    assert.equal(t.stdin.writableEnded, true);
    assert.equal(t.stdin.listenerCount("drain"), 0);
    t.stdin.complete();
    await t.tick();
    assert.equal(t.stdin.writableFinished, true);
    for (const line of [t.stdin.calls[1], t.stdin.calls[3]]) {
      const cmd = JSON.parse(line);
      t.stdout.write(`${JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true })}\n`);
    }
    assert.equal((await first).success, true);
    assert.equal((await last).success, true);
    t.stdout.end();
    await t.rpc.closed;
  });

  test("the queue limit counts in-flight UTF-8 bytes and LF; overflow is recoverable", async (ctx) => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] });
    const cleared = ctx.mock.method(globalThis, "clearTimeout");
    const t = backpressuredTransport({ maxQueuedBytes: 128 });
    const errors = [];
    t.rpc.onError((error) => errors.push(error));
    t.rpc.writeRaw(`${"é".repeat(63)}\n`); // 127 bytes remain in flight.
    await assert.rejects(t.rpc.send({ type: "get_state" }, { timeoutMs: 60_000 }), {
      code: "EHOSTKIT_RPC_QUEUE_FULL",
    });
    assert.equal(cleared.mock.callCount(), 1, "a rejected admission clears its RPC timer");
    assert.throws(() => t.rpc.respondUi({ id: "u1" }), { code: "EHOSTKIT_RPC_QUEUE_FULL" });
    assert.throws(() => t.rpc.writeRaw("é"), { code: "EHOSTKIT_RPC_QUEUE_FULL" });
    t.rpc.writeRaw("\n"); // Exactly 128 bytes are admitted.
    assert.throws(() => t.rpc.writeRaw("\n"), { code: "EHOSTKIT_RPC_QUEUE_FULL" });
    assert.equal(t.stdin.calls.length, 1);
    t.stdin.complete();
    await t.tick();
    assert.equal(t.stdin.calls.length, 2);
    t.stdin.complete();
    await t.tick();
    const pending = t.rpc.send({ type: "get_state" });
    const cmd = JSON.parse(t.stdin.calls.at(-1));
    t.stdout.write(`${JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true })}\n`);
    assert.equal((await pending).success, true);
    assert.deepEqual(errors, [], "overflow does not poison the transport");
    t.stdin.complete();
    await t.tick();
    t.rpc.closeInput();
  });

  test("rejects invalid queue limits and bounds the default queue", async () => {
    for (const maxQueuedBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => backpressuredTransport({ maxQueuedBytes }), /maxQueuedBytes/);
    }
    const t = backpressuredTransport();
    assert.throws(() => t.rpc.writeRaw("x".repeat(64 * 1024 * 1024 + 1)), {
      code: "EHOSTKIT_RPC_QUEUE_FULL",
    });
    assert.equal(t.stdin.calls.length, 0);
    t.rpc.closeInput();
  });

  test("serializes commands before pending registration or timers and leaves the transport usable", async (ctx) => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] });
    const timers = ctx.mock.method(globalThis, "setTimeout");
    const t = transport();
    const cyclic = {};
    cyclic.self = cyclic;
    const getterError = new Error("getter failed");
    const jsonError = new Error("toJSON failed");
    const cases = [
      [{ type: "cycle", data: cyclic }, TypeError],
      [{ type: "bigint", data: 1n }, TypeError],
      [{ type: "getter", get data() { throw getterError; } }, getterError],
      [{ type: "to_json", toJSON() { throw jsonError; } }, jsonError],
      [{ type: "undefined", toJSON() {} }, TypeError],
    ];
    const diagnostics = [];
    t.rpc.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.kind));
    for (let i = 0; i < cases.length; i++) {
      const [cmd, error] = cases[i];
      let result;
      assert.doesNotThrow(() => { result = t.rpc.send(cmd, { timeoutMs: 60_000 }); });
      await assert.rejects(result, error);
      t.emit({ type: "response", id: `hk-${i + 1}`, command: cmd.type, success: true });
    }
    assert.equal(timers.mock.callCount(), 0, "failed serialization never creates timers");
    assert.deepEqual(diagnostics, cases.map(() => "unmatched_response"), "failed commands are not pending");
    assert.deepEqual(t.written, []);
    assert.throws(() => t.rpc.respondUi({ id: "u1", data: cyclic }), TypeError);
    assert.throws(() => t.rpc.respondUi({ id: "u1", data: 1n }), TypeError);
    const pending = t.rpc.send({ type: "get_state" });
    t.emit({ type: "response", id: t.written.at(-1).id, command: "get_state", success: true });
    assert.equal((await pending).success, true);
    t.rpc.respondUi({ id: "u1", confirmed: true });
    assert.equal(t.written.at(-1).type, "extension_ui_response");
    t.rpc.closeInput();
  });

  test("a failed write rejects queued RPCs, clears timers, and removes drain listeners", async (ctx) => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] });
    const cleared = ctx.mock.method(globalThis, "clearTimeout");
    const t = backpressuredTransport();
    const failure = new Error("write failed");
    const errors = [];
    t.rpc.onError((error) => errors.push(error));
    const first = t.rpc.send({ type: "first" }, { timeoutMs: 60_000 });
    const second = t.rpc.send({ type: "second" }, { timeoutMs: 60_000 });
    t.rpc.respondUi({ id: "u1" });
    const rejected = Promise.all([assert.rejects(first, failure), assert.rejects(second, failure)]);
    t.stdin.complete(failure);
    await rejected;
    await t.tick();
    assert.equal(cleared.mock.callCount(), 2);
    assert.equal(t.stdin.calls.length, 1);
    assert.equal(t.stdin.listenerCount("drain"), 0);
    assert.deepEqual(errors, [failure]);
    await assert.rejects(t.rpc.send({ type: "later" }), failure);
    assert.throws(() => t.rpc.writeRaw("gate-release\n"), failure);
    assert.throws(() => t.rpc.respondUi({ id: "later" }), failure);
  });

  test("failure during closeInput discards unsent records and finishes stdin", async () => {
    const t = backpressuredTransport();
    const first = t.rpc.send({ type: "first" });
    const second = t.rpc.send({ type: "second" });
    t.rpc.closeInput();
    const rejected = Promise.all([
      assert.rejects(first, RpcProtocolError),
      assert.rejects(second, RpcProtocolError),
    ]);
    t.stdout.write("invalid JSON\n");
    await rejected;
    assert.equal(t.stdin.writableEnded, true);
    assert.equal(t.stdin.calls.length, 1);
    assert.equal(t.stdin.listenerCount("drain"), 0);
    t.stdin.complete();
    await t.tick();
    assert.equal(t.stdin.writableFinished, true);
  });

  test("a synchronous write failure settles the command and clears its timer", async (ctx) => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] });
    const cleared = ctx.mock.method(globalThis, "clearTimeout");
    const t = backpressuredTransport();
    const failure = new Error("synchronous write failure");
    ctx.mock.method(t.stdin, "write", () => { throw failure; });
    await assert.rejects(t.rpc.send({ type: "get_state" }, { timeoutMs: 60_000 }), failure);
    assert.equal(cleared.mock.callCount(), 1);
    assert.equal(t.stdin.listenerCount("drain"), 0);
  });

  test("premature stdin close rejects in-flight and queued commands", async () => {
    const t = backpressuredTransport();
    const first = t.rpc.send({ type: "first" });
    const second = t.rpc.send({ type: "second" });
    const rejected = Promise.all([
      assert.rejects(first, { code: "EHOSTKIT_RPC_CLOSED" }),
      assert.rejects(second, { code: "EHOSTKIT_RPC_CLOSED" }),
    ]);
    t.stdin.destroy();
    await rejected;
    assert.equal(t.stdin.calls.length, 1);
    assert.equal(t.stdin.listenerCount("drain"), 0);
  });

  test("a throwing listener does not break the transport", async () => {
    const t = transport();
    const seen = [];
    t.rpc.onEvent(() => {
      throw new Error("listener bug");
    });
    t.rpc.onEvent((e) => seen.push(e.type));
    const original = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const caught = new Promise((resolve) => process.once("uncaughtException", resolve));
    t.emit({ type: "agent_start" });
    assert.equal((await caught).message, "listener bug");
    for (const l of original) process.on("uncaughtException", l);
    const p = t.rpc.send({ type: "get_state" });
    await t.tick();
    t.emit({ type: "response", id: t.written[0].id, command: "get_state", success: true });
    assert.equal((await p).success, true);
    assert.deepEqual(seen, ["agent_start"]);
  });
});
