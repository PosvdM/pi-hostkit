// 独立子进程中的模块替身，不向生产代码开放测试开关。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import { mock, test } from "node:test";
import * as table from "../../dist/proctable.js";

Object.defineProperty(process, "platform", { value: "win32" });
const root = { pid: 100, startTime: "1", runId: "r", instanceId: "i" };
const row = (pid, ppid = 100) => ({ pid, ppid, startTime: String(pid), zombie: false });
const fault = (message) => Object.assign(new Error(message), { code: "EIO" });
let state;
function reset() {
  state = {
    live: new Map([[100, { ...root, ppid: 1, zombie: false }]]),
    pids: [], calls: [], closeCount: 0,
  };
}
const query = (pid) => state.query ? state.query(pid) : state.live.get(pid) ?? null;
mock.module("node:fs", { namedExports: {
  // 只提供依赖需要的导出，避免重定义 constants 等不可配置属性。
  readdirSync: fs.readdirSync,
  writeFileSync: fs.writeFileSync,
  statSync: fs.statSync,
  existsSync: (file) => state?.exists ? state.exists(file) : state?.support ? true : fs.existsSync(file),
  readFileSync: (file, ...args) => state?.readFile ? state.readFile(file) : fs.readFileSync(file, ...args),
} });
mock.module(new URL("../../dist/proctable.js", import.meta.url), { namedExports: {
  ...table,
  processInfo: query,
  listProcesses: () => state.list ? state.list() : [...state.live.values()],
  signalProcess: (id, signal, group) => {
    state.calls.push(["signal", id.pid, signal, group]);
    if (state.signal) return state.signal(id, signal, group);
    state.live.delete(id.pid);
    return true;
  },
} });
mock.module(new URL("../../dist/native.js", import.meta.url), { namedExports: {
  nativeFn: (name) => (...args) => {
    state.calls.push([name, ...args]);
    switch (name) {
      case "jobCreate": if (state.createJob) return state.createJob(); return 42;
      case "jobAssign": if (state.assign) return state.assign(); return;
      case "jobTerminate":
        if (state.terminateJob) return state.terminateJob();
        state.live.clear(); state.pids = []; return;
      case "jobProcessIds": return state.jobQuery ? state.jobQuery() : state.pids;
      case "handleClose":
        state.closeCount++;
        if (state.close) return state.close();
        return;
      case "terminateProcess":
        if (state.terminate) return state.terminate(...args);
        if (!table.matches(state.live.get(args[0]), { pid: args[0], startTime: args[1] })) return false;
        state.live.delete(args[0]); return true;
      default: throw new Error(`意外的 native 调用 ${name}`);
    }
  },
} });
mock.module("node:child_process", { namedExports: {
  execFile: (...args) => {
    if (state.execFile) return state.execFile(...args);
    if (state.support) return args.at(-1)(null, "/test.scope\n");
    throw new Error("不应探测 Linux scope");
  },
  spawn: (...args) => {
    state.spawnArgs = args;
    if (state.spawnThrow) throw state.spawnThrow;
    const child = new EventEmitter();
    child.pid = root.pid;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {
      state.calls.push(["child.kill"]);
      if (state.killChild) return state.killChild();
      state.live.delete(root.pid);
      child.emit("exit", null, "SIGKILL");
      return true;
    };
    if (state.constructManaged) child.stderr.setEncoding = () => { throw fault("Managed 构造失败"); };
    state.child = child;
    queueMicrotask(() => state.spawnEvent ? state.spawnEvent(child) : child.emit("spawn"));
    return child;
  },
} });
mock.module(new URL("../../dist/rpc.js", import.meta.url), { namedExports: {
  StdioRpcTransport: class {
    constructor() { if (state.constructRpc) throw fault("RPC 构造失败"); }
    block() {}
    writeRaw() { if (state.release) state.release(); }
    onEvent() {}
    async send() { if (state.abort) return state.abort(); return { success: true }; }
    closeInput() {
      if (!state.keepRoot) state.child.emit("exit", 0, null);
      if (state.eof) state.eof();
    }
  },
} });
const snapshots = await import("../../dist/snapshots.js");
mock.module(new URL("../../dist/snapshots.js", import.meta.url), { namedExports: {
  ...snapshots,
  stopSnapshot: (...args) => state.stopSnapshot ? state.stopSnapshot(...args) : snapshots.stopSnapshot(...args),
} });
const { spawnManaged, stopByIdentity, isSameProcess, readIdentity } = await import("../../dist/process.js");
const fast = { abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 };
const spawn = () => spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i", startHeld: true });
const failed = (report, text) => report.steps.some((step) => !step.ok && step.detail?.includes(text));
// 只压缩等待时间；保留真实异步定时器和 poll 的每轮查询。
const timeout = globalThis.setTimeout;
mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, Math.min(ms, 1), ...args));
let clock = 0;
mock.method(Date, "now", () => (clock += 1_000));

test("spawn 事件之前不查询身份或创建 Job，事件到达后才返回 Managed", async () => {
  reset();
  state.spawnEvent = () => {};
  let queries = 0;
  state.query = (pid) => { queries++; return state.live.get(pid) ?? null; };
  let settled = false;
  const pending = spawn().then((proc) => { settled = true; return proc; });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.ok(state.child);
  assert.equal(settled, false);
  assert.equal(queries, 0);
  assert.ok(!state.calls.some(([name]) => name === "jobCreate"));
  state.child.emit("spawn");
  const proc = await pending;
  assert.deepEqual(proc.identity, root);
  assert.equal(queries, 1);
  assert.ok(state.calls.some(([name]) => name === "jobAssign"));
  await proc.stop(fast);
  assert.equal(state.closeCount, 1);
});

test("spawn 同步抛错直接保留原错，不创建 Job 或回收不存在的子进程", async () => {
  reset();
  const error = Object.assign(new Error("spawn 参数错误"), { code: "EINVAL" });
  state.spawnThrow = error;
  await assert.rejects(spawn(), (actual) => actual === error);
  assert.equal(state.child, undefined);
  assert.deepEqual(state.calls, []);
});

test("spawn 前 error 事件保留系统原错，不查询身份或创建 Job", async () => {
  reset();
  const error = Object.assign(new Error("spawn 找不到程序"), { code: "ENOENT" });
  state.spawnEvent = (child) => { child.pid = undefined; child.emit("error", error); };
  state.query = () => { throw new Error("失败的 spawn 不应查询 PID"); };
  await assert.rejects(spawn(), (actual) => actual === error);
  assert.deepEqual(state.calls, []);
  assert.equal(state.closeCount, 0);
});

test("jobCreate 失败回收已启动的 gate，不关闭尚未创建的句柄", async () => {
  reset();
  const error = fault("Job 创建失败");
  state.createJob = () => { throw error; };
  await assert.rejects(spawn(), (actual) => actual === error);
  assert.deepEqual(state.calls, [["jobCreate"], ["child.kill"]]);
  assert.equal(state.closeCount, 0);
});

test("启动身份为 null 返回 EHOSTKIT_SPAWN 并回收 gate，不创建 Job", async () => {
  reset();
  state.query = () => null;
  await assert.rejects(spawn(), { code: "EHOSTKIT_SPAWN", message: "pi exited during start" });
  assert.deepEqual(state.calls, [["child.kill"]]);
  assert.equal(state.closeCount, 0);
});

test("Job 持续查询失败返回未知哨兵，关闭句柄且重复 stop 共享报告", async () => {
  reset();
  const proc = await spawn();
  state.jobQuery = () => { throw fault("Job 查询失败"); };
  const a = proc.stop(fast), b = proc.stop(fast);
  assert.equal(a, b);
  const report = await a;
  assert.equal(await proc.stop(), report);
  assert.ok(failed(report, "Job 查询失败"));
  assert.ok(report.leftovers.some((entry) => entry.pid === 0 && /Job Object/.test(entry.exe)));
  assert.equal(state.closeCount, 1);
  assert.equal(report.steps.filter((step) => step.step === "query Job Object").length, 1);
});

test("Job 最终查询失败保留已知成员并添加未知范围哨兵", async () => {
  reset();
  const child = row(101);
  state.live.set(101, child);
  const proc = await spawn();
  state.terminateJob = () => {};
  let reads = 0;
  state.jobQuery = () => { if (++reads > 1) throw fault("最终 Job 查询失败"); return [101]; };
  const report = await proc.stop(fast);
  assert.ok(report.leftovers.some((entry) => entry.pid === 101 && entry.startTime === child.startTime));
  assert.ok(report.leftovers.some((entry) => entry.pid === 0));
  assert.ok(failed(report, "最终 Job 查询失败"));
  assert.equal(state.closeCount, 1);
});

test("Job 暂时查询失败后确认空，只保留失败步骤而不伪造残留", async () => {
  reset();
  const proc = await spawn();
  let reads = 0;
  state.jobQuery = () => { if (++reads === 1) throw fault("暂时 Job 查询失败"); return []; };
  const report = await proc.stop(fast);
  assert.deepEqual(report.leftovers, []);
  assert.ok(failed(report, "暂时 Job 查询失败"));
  assert.equal(state.closeCount, 1);
});

test("Job 单个 PID 查询失败不跳过其他成员，已知身份不丢失", async () => {
  reset();
  state.live.set(101, row(101)); state.live.set(102, row(102));
  const proc = await spawn();
  state.terminateJob = () => {};
  state.pids = [101, 102];
  let reads = 0;
  state.query = (pid) => {
    if (pid === 101 && ++reads > 1) throw fault("成员查询失败");
    return state.live.get(pid) ?? null;
  };
  const report = await proc.stop(fast);
  assert.deepEqual(report.leftovers, [{ pid: 101, startTime: "101" }, { pid: 102, startTime: "102" }]);
  assert.ok(failed(report, "成员查询失败"));
});

test("Job 成员第一次查询失败保留未知 PID，不能当作 gone", async () => {
  reset();
  const proc = await spawn();
  state.terminateJob = () => {};
  state.pids = [101];
  state.query = () => { throw fault("身份不可读"); };
  const report = await proc.stop(fast);
  assert.deepEqual(report.leftovers, [{ pid: 101, startTime: "" }]);
  assert.ok(failed(report, "身份不可读"));
});

test("Job 终止与句柄关闭同时失败都写入报告", async () => {
  reset();
  const proc = await spawn();
  state.terminateJob = () => { throw fault("Job 终止失败"); };
  state.close = () => { throw fault("句柄关闭失败"); };
  const report = await proc.stop(fast);
  assert.ok(failed(report, "Job 终止失败"));
  assert.ok(failed(report, "句柄关闭失败"));
  assert.equal(state.closeCount, 1);
});

test("关闭输入及 abort 异常不阻止 Job 清理，字符串异常保留原因", async () => {
  reset();
  const proc = await spawn();
  proc.release();
  state.abort = () => { throw "abort 字符串异常"; };
  state.eof = () => { throw fault("关闭输入失败"); };
  const report = await proc.stop(fast);
  assert.ok(failed(report, "abort 字符串异常"));
  assert.ok(failed(report, "关闭输入失败"));
  assert.ok(state.calls.some(([name]) => name === "jobTerminate"));
});

test("Managed 最终 pi 查询失败保留原身份，不把未知当退出", async () => {
  reset();
  const proc = await spawn();
  state.keepRoot = true;
  state.query = () => { throw fault("最终 pi 查询失败"); };
  const report = await proc.stop(fast);
  assert.ok(failed(report, "最终 pi 查询失败"));
  assert.deepEqual(report.leftovers, [{ pid: root.pid, startTime: root.startTime }]);
});

test("Windows 恢复停止逐目标隔离终止错误，查询未知保留身份", async () => {
  reset();
  state.live.set(101, row(101)); state.live.set(102, row(102));
  const sent = [];
  state.terminate = (pid) => {
    sent.push(pid);
    if (pid === 101 || pid === 100) throw fault(`终止失败 ${pid}`);
    state.live.delete(pid); return true;
  };
  const report = await stopByIdentity(root, fast);
  assert.deepEqual(sent, [100, 101, 102]);
  assert.deepEqual(report.leftovers.map((entry) => entry.pid), [101, 100]);
  assert.ok(failed(report, "终止失败 101"));
  assert.ok(failed(report, "终止失败 100"));
});

test("Windows 恢复停止列表失败也终止 pi 并输出快照失败", async () => {
  reset();
  state.list = () => { throw fault("恢复列表失败"); };
  const report = await stopByIdentity(root, fast);
  assert.ok(failed(report, "恢复列表失败"));
  assert.ok(state.calls.some(([name, pid]) => name === "terminateProcess" && pid === 100));
  assert.deepEqual(report.leftovers, []);
});

test("Windows 恢复停止单父查询失败只丢弃该分支，其他分支继续", async () => {
  reset();
  for (const entry of [row(101), row(102), row(103, 101), row(104, 102)]) state.live.set(entry.pid, entry);
  state.query = (pid) => { if (pid === 101) throw fault("父身份失败"); return state.live.get(pid) ?? null; };
  const report = await stopByIdentity(root, fast);
  const sent = state.calls.filter(([name]) => name === "terminateProcess").map(([, pid]) => pid);
  assert.ok(sent.includes(104)); assert.ok(!sent.includes(103));
  assert.ok(report.leftovers.some((entry) => entry.pid === 101));
  assert.ok(failed(report, "父身份失败"));
});

test("Windows 恢复停止 pi 查询失败返回 unknown，仍尝试身份校验终止", async () => {
  reset();
  state.query = () => { throw fault("pi 查询不可用"); };
  state.terminate = () => { throw fault("pi 终止不可用"); };
  const report = await stopByIdentity(root, fast);
  assert.equal(report.steps.find((step) => step.step === "identity").detail, "unknown");
  assert.ok(report.leftovers.some((entry) => entry.pid === 100 && entry.startTime === "1"));
  assert.ok(failed(report, "pi 查询不可用"));
  assert.ok(failed(report, "pi 终止不可用"));
});

test("readIdentity 和 isSameProcess 的查询错误向调用方传播", async () => {
  reset();
  state.query = () => { throw fault("身份查询失败"); };
  assert.throws(() => readIdentity(100, "r", "i"), /身份查询失败/);
  await assert.rejects(isSameProcess(root), /身份查询失败/);
});

test("spawn 的 Job 分配失败回收子进程和已创建句柄", async () => {
  reset();
  state.assign = () => { throw fault("Job 分配失败"); };
  await assert.rejects(spawn(), /Job 分配失败/);
  assert.ok(state.calls.some(([name]) => name === "child.kill"));
  assert.equal(state.closeCount, 1);
});

for (const stage of ["assign", "stop-reject"]) {
  for (const emitted of [false, true]) {
    test(`${stage} 回收 kill 返回 false（error 事件=${emitted}）关闭输入并报告未确认进程`, async () => {
      reset();
      const primary = fault("启动主错误");
      if (stage === "assign") state.assign = () => { throw primary; };
      else {
        Object.defineProperty(process, "platform", { value: "darwin" });
        state.release = () => { throw primary; };
        state.stopSnapshot = async () => { throw fault("停止拒绝"); };
        state.keepRoot = true;
        state.signal = () => false;
      }
      const killError = Object.assign(new Error("kill 权限失败事件"), { code: "EPERM" });
      state.killChild = () => {
        if (emitted) queueMicrotask(() => state.child.emit("error", killError));
        return false;
      };
      try {
        const operation = stage === "assign" ? spawn() : spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i" });
        await assert.rejects(operation, (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0], primary);
          assert.equal(error.code, "EIO");
          assert.match(error.message, /未发送 SIGKILL/);
          const unknown = error.errors.find((failure) => failure.cause?.pid === root.pid);
          assert.ok(unknown);
          assert.equal(unknown.cause.identity.pid, root.pid);
          if (emitted) {
            assert.ok(error.errors.includes(killError));
            assert.ok(unknown.cause.errors.includes(killError));
          }
          return true;
        });
        assert.equal(state.child.stdin.writableEnded, true);
        assert.equal(state.child.stdin.destroyed, true);
        assert.equal(state.calls.filter(([name]) => name === "child.kill").length, 1);
        assert.equal(state.closeCount, stage === "assign" ? 1 : 0);
      } finally {
        Object.defineProperty(process, "platform", { value: "win32" });
      }
    });
  }
}

test("kill 返回 false 但随后明确退出时，只保留启动主错误", async () => {
  reset();
  const primary = fault("Job 分配失败");
  state.assign = () => { throw primary; };
  state.killChild = () => {
    queueMicrotask(() => state.child.emit("exit", 0, null));
    return false;
  };
  await assert.rejects(spawn(), (error) => error === primary);
  assert.equal(state.child.stdin.destroyed, true);
});

for (const kind of ["constructRpc", "constructManaged"]) {
  test(`${kind} 构造失败回收 gate 和 Job，回收双错全部保留`, async () => {
    reset();
    state[kind] = true;
    state.killChild = () => { throw fault("gate 回收失败"); };
    state.close = () => { throw fault("Job 回收失败"); };
    await assert.rejects(spawn(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /构造失败/);
      assert.match(error.message, /gate 回收失败/);
      assert.match(error.message, /Job 回收失败/);
      assert.match(error.message, /未能在 2000 ms 内确认/);
      assert.equal(error.errors.length, 4);
      assert.equal(error.code, "EIO");
      return true;
    });
    assert.equal(state.closeCount, 1);
  });
}

test("gate 放行失败且停止报告含 Job 错误时保留原错与完整报告", async () => {
  reset();
  state.release = () => { throw fault("gate 放行失败"); };
  state.terminateJob = () => { throw fault("放行后 Job 清理失败"); };
  await assert.rejects(spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i" }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /gate 放行失败/);
    assert.match(error.message, /放行后 Job 清理失败/);
    assert.equal(error.code, "EIO");
    assert.ok(error.errors[1].cause.steps.some((step) => !step.ok && step.step === "TerminateJobObject"));
    return true;
  });
  assert.equal(state.closeCount, 1);
});

test("POSIX SIGTERM 失败不阻止最终快照和后代清理", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    reset();
    state.live.set(101, { ...row(101), pgid: 101 });
    const proc = await spawn();
    state.keepRoot = true;
    state.signal = (id, signal) => {
      if (signal === "SIGTERM") throw fault("SIGTERM 失败");
      state.live.delete(id.pid); return true;
    };
    const report = await proc.stop(fast);
    assert.ok(failed(report, "SIGTERM 失败"));
    assert.deepEqual(report.leftovers, []);
    assert.ok(state.calls.some(([name, pid, signal]) => name === "signal" && pid === 101 && signal === "SIGKILL"));
  } finally {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
});

test("POSIX 恢复停止的单目标信号失败不中断其他后代及 pi", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    reset();
    state.live.set(101, { ...row(101), pgid: 101 }); state.live.set(102, { ...row(102), pgid: 102 });
    state.signal = (id, signal) => {
      if (id.pid === 101 || signal === "SIGTERM") throw fault(`目标信号失败 ${id.pid}`);
      state.live.delete(id.pid); return true;
    };
    const report = await stopByIdentity(root, fast);
    assert.deepEqual(report.leftovers.map((entry) => entry.pid), [101]);
    assert.ok(state.calls.some(([name, pid, signal]) => name === "signal" && pid === 102 && signal === "SIGKILL"));
    assert.ok(failed(report, "目标信号失败 101"));
  } finally {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
});

test("gate 放行和 stop 同时拒绝时，两种错误都返回调用方", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    reset();
    state.release = () => { throw fault("原始放行错误"); };
    state.keepRoot = true;
    state.signal = () => false;
    state.stopSnapshot = async () => { throw fault("停止本身拒绝"); };
    state.killChild = () => { throw fault("停止拒绝后的子进程回收失败"); };
    await assert.rejects(spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i" }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /原始放行错误/); assert.match(error.message, /停止本身拒绝/);
      assert.match(error.message, /停止拒绝后的子进程回收失败/);
      assert.match(error.message, /未能在 2000 ms 内确认/);
      assert.equal(error.errors.length, 4);
      assert.equal(error.code, "EIO");
      return true;
    });
    assert.ok(state.calls.some(([name]) => name === "child.kill"));
  } finally {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
});

for (const content of [null, "broken unified cgroup", "0::relative-path\n"]) {
  test(`Linux 启动 scope 查询失败或内容损坏直接失败并回收 gate：${content}`, async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      reset(); state.support = true;
      state.readFile = () => { if (content === null) throw fault("scope 查询失败"); return content; };
      const { spawnManaged: spawnLinux } = await import(`../../dist/process.js?scope-fault=${encodeURIComponent(String(content))}`);
      await assert.rejects(spawnLinux({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i" }), /scope 查询失败|cannot read unified cgroup/);
      assert.ok(state.calls.some(([name]) => name === "child.kill"));
    } finally {
      Object.defineProperty(process, "platform", { value: "win32" });
    }
  });
}

for (const kind of ["controllers", "executable", "exec-error", "malformed-probe"]) {
  test(`Linux 能力探测的 ${kind} 只降级覆盖范围，不报告进程已退出`, async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      reset();
      state.exists = (file) => kind === "controllers" ? false : kind === "executable" ? file.endsWith("cgroup.controllers") : true;
      state.execFile = (...args) => args.at(-1)(kind === "exec-error" ? fault("探测失败") : null, "无 scope 输出\n");
      const module = await import(`../../dist/process.js?probe=${kind}`);
      assert.equal(await module.linuxCgroupSupport(), null);
      const proc = await module.spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i", startHeld: true });
      assert.equal(proc.coverage, "snapshot_visible");
      assert.equal(await module.isSameProcess(root), "alive");
      state.child.emit("exit", 0, null);
    } finally {
      Object.defineProperty(process, "platform", { value: "win32" });
    }
  });
}

test("execFile 同步抛错保留拒绝原因，重复探测复用失败结果且不启动 gate", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    reset(); state.support = true;
    const error = Object.assign(new Error("探测 execFile 同步错误"), { code: "EINVAL" });
    let calls = 0;
    state.execFile = () => { calls++; throw error; };
    const module = await import("../../dist/process.js?probe-sync-throw");
    const probe = module.linuxCgroupSupport();
    assert.equal(module.linuxCgroupSupport(), probe);
    await assert.rejects(probe, (actual) => actual === error);
    await assert.rejects(module.spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i" }), (actual) => actual === error);
    assert.equal(calls, 1);
    assert.equal(state.spawnArgs, undefined);
    assert.deepEqual(state.calls, []);
  } finally {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
});

test("execFile 异步超时错误回调降级 snapshot，有效 stdout 不能掩盖超时", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    reset(); state.support = true;
    let calls = 0;
    state.execFile = (...args) => {
      calls++;
      assert.equal(args[2].timeout, 10_000);
      const error = Object.assign(new Error("探测超时"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
      queueMicrotask(() => args.at(-1)(error, "/test.scope\n"));
    };
    const module = await import("../../dist/process.js?probe-timeout-callback");
    assert.equal(await module.linuxCgroupSupport(), null);
    const proc = await module.spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i", startHeld: true });
    assert.equal(proc.coverage, "snapshot_visible");
    assert.equal(await module.isSameProcess(root), "alive");
    assert.equal(calls, 1);
    const report = await proc.stop(fast);
    assert.equal(report.coverage, "snapshot_visible");
    assert.deepEqual(report.leftovers, []);
  } finally {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
});

for (const code of ["ENOENT", "ESRCH"]) {
  test(`Linux 启动 scope 的暂时 ${code} 继续等待，不误判 gate 已退出`, async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      reset(); state.support = true;
      let reads = 0;
      state.readFile = () => {
        if (++reads === 1) throw Object.assign(new Error(code), { code });
        const unit = state.spawnArgs[1].find((arg) => arg.startsWith("--unit=")).slice(7);
        return `0::/test/${unit}.scope\n`;
      };
      const module = await import(`../../dist/process.js?scope-retry=${code}`);
      const proc = await module.spawnManaged({ argv: ["unused"], cwd: ".", env: {}, runId: "r", instanceId: "i", startHeld: true });
      assert.equal(proc.coverage, "cgroup");
      assert.ok(proc.identity.cgroup.endsWith(".scope"));
      assert.equal(reads, 2);
      assert.ok(!state.calls.some(([name]) => name === "child.kill"));
      state.child.emit("exit", 0, null);
    } finally {
      Object.defineProperty(process, "platform", { value: "win32" });
    }
  });
}
