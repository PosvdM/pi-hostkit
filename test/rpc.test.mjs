import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
  });

  test("stdout end rejects pending commands", async () => {
    const t = transport();
    const p = t.rpc.send({ type: "get_state" });
    t.stdout.end();
    await assert.rejects(p, { code: "EHOSTKIT_RPC_CLOSED" });
    await t.rpc.closed;
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
