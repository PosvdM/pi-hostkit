import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { StdioRpcTransport } from "../dist/rpc.js";

for (const event of ["error", "close", "end"]) {
  test(`stdout ${event} 会清除挂起请求、队列、计时器和 drain 监听`, async (t) => {
    const stdin = new Writable({ highWaterMark: 1, write(_c, _e, _cb) {} });
    const stdout = new PassThrough();
    const rpc = new StdioRpcTransport(stdin, stdout);
    const cleared = t.mock.method(globalThis, "clearTimeout");
    const errors = [];
    rpc.onError((e) => errors.push(e));
    const a = rpc.send({ type: "a" }, { timeoutMs: 60_000 });
    const b = rpc.send({ type: "b" }, { timeoutMs: 60_000 });
    const rejected = Promise.all([assert.rejects(a), assert.rejects(b)]);
    stdout.emit(event, event === "error" ? new Error("stdout query failed") : undefined);
    await rejected;
    assert.equal(cleared.mock.callCount(), 2);
    assert.equal(stdin.listenerCount("drain"), 0);
    await assert.rejects(rpc.send({ type: "later" }));
    assert.equal(errors.length, event === "error" ? 1 : 0);
    if (event !== "error") await rpc.closed;
    stdin.destroy();
    stdout.destroy();
  });
}

test("等待队列清理时 end 抛错应连同首个协议错误报告", async () => {
  const stdin = new Writable({ highWaterMark: 1, write(_c, _e, _cb) {} });
  const stdout = new PassThrough();
  const rpc = new StdioRpcTransport(stdin, stdout);
  const cleanup = new Error("end cleanup failed");
  stdin.end = () => { throw cleanup; };
  const errors = [];
  rpc.onError((e) => errors.push(e));
  const a = rpc.send({ type: "a" });
  const b = rpc.send({ type: "b" });
  const rejected = Promise.all([assert.rejects(a), assert.rejects(b)]);
  rpc.closeInput();
  stdout.write("not JSON\n");
  await rejected;
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AggregateError);
  assert.equal(errors[0].errors[0].code, "EHOSTKIT_RPC_PROTOCOL");
  assert.equal(errors[0].errors[1], cleanup);
  assert.equal(stdin.listenerCount("drain"), 0);
  stdin.destroy();
  stdout.destroy();
});

test("失败收尾期间即使 end 同步发出 error 也只报告一次且不丢首错", async () => {
  const stdin = new Writable({ highWaterMark: 1, write(_c, _e, _cb) {} });
  const stdout = new PassThrough();
  const rpc = new StdioRpcTransport(stdin, stdout);
  const errors = [];
  rpc.onError((e) => errors.push(e));
  const a = rpc.send({ type: "a" });
  const b = rpc.send({ type: "b" });
  const rejected = Promise.all([assert.rejects(a), assert.rejects(b)]);
  const cleanup = new Error("secondary end error");
  stdin.end = () => { stdin.emit("error", cleanup); return stdin; };
  rpc.closeInput();
  stdout.write("not JSON\n");
  await rejected;
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AggregateError);
  assert.equal(errors[0].errors[0].code, "EHOSTKIT_RPC_PROTOCOL");
  assert.equal(errors[0].errors[1], cleanup);
  stdin.destroy();
  stdout.destroy();
});

for (const cleanup of ["success", "throw", "error"]) {
  test(`健康 closeInput 首次 end 抛错，后续收尾 ${cleanup} 均清理请求并报告首错`, async (t) => {
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const stdout = new PassThrough();
    const rpc = new StdioRpcTransport(stdin, stdout);
    const cleared = t.mock.method(globalThis, "clearTimeout");
    const errors = [];
    rpc.onError((error) => errors.push(error));
    const a = rpc.send({ type: "a" }, { timeoutMs: 60_000 });
    const b = rpc.send({ type: "b" }, { timeoutMs: 60_000 });
    const primary = Object.assign(new Error("first end failed"), { code: "EIO" });
    const secondary = Object.assign(new Error("cleanup end failed"), { code: "EPERM" });
    const rejected = Promise.all([assert.rejects(a, (e) => e === primary), assert.rejects(b, (e) => e === primary)]);
    const end = stdin.end;
    let ends = 0;
    stdin.end = function (...args) {
      if (++ends === 1) throw primary;
      if (cleanup === "throw") throw secondary;
      if (cleanup === "error") { this.emit("error", secondary); return this; }
      return end.apply(this, args);
    };
    assert.deepEqual(errors, []);
    assert.equal(stdin.writableEnded, false);
    assert.equal(stdin.listenerCount("drain"), 0);
    assert.doesNotThrow(() => rpc.closeInput());
    await rejected;
    assert.equal(cleared.mock.callCount(), 2);
    assert.equal(ends, 2);
    assert.equal(errors.length, 1);
    const reported = errors[0];
    if (cleanup === "success") {
      assert.equal(reported, primary);
      assert.equal(stdin.writableEnded, true);
    } else {
      assert.ok(reported instanceof AggregateError);
      assert.equal(reported.code, primary.code);
      assert.deepEqual(reported.errors, [primary, secondary]);
    }
    assert.equal(stdin.listenerCount("drain"), 0);
    await assert.rejects(rpc.send({ type: "later" }), (e) => e === reported);
    assert.throws(() => rpc.respondUi({ id: "later" }), (e) => e === reported);
    rpc.closeInput();
    assert.equal(ends, 2);
    stdin.destroy();
    stdout.destroy();
  });
}
