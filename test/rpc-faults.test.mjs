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
