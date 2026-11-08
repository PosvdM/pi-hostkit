// 用隔离模块和 /proc 替身覆盖 Linux 分支，不要求本机运行 Linux。
import assert from "node:assert/strict";
import { mock, test } from "node:test";

Object.defineProperty(process, "platform", { value: "linux" });
const fault = (code, message = code) => Object.assign(new Error(message), { code });
let state, serial = 0;
const id = { pid: 100, startTime: "boot:10" };
function stat(pid = 100, ticks = "10", group = 100) {
  const fields = Array(20).fill("0");
  fields[0] = "S"; fields[1] = "1"; fields[2] = String(group); fields[19] = ticks;
  return `${pid} (带空格及 ) 的命令) ${fields.join(" ")}`;
}
function reset() {
  state = { files: new Map([["/proc/100/stat", stat()]]), entries: ["100"], boot: "boot", calls: [], readCalls: [] };
}
mock.module("node:fs", { namedExports: {
  readdirSync: (dir) => {
    assert.equal(dir, "/proc");
    if (state.readdir) return state.readdir();
    return state.entries;
  },
  readFileSync: (file) => {
    state.readCalls.push(file);
    if (state.read) {
      const result = state.read(file);
      if (result !== undefined) return result;
    }
    if (file === "/proc/sys/kernel/random/boot_id") return state.boot;
    if (!state.files.has(file)) throw fault("ENOENT");
    return state.files.get(file);
  },
} });
mock.module(new URL("../../dist/native.js", import.meta.url), { namedExports: {
  nativeFn: (name) => (...args) => {
    state.calls.push([name, ...args]);
    if (state[name]) return state[name](...args);
    if (name === "pidfdOpen") return args[0] + 1_000;
    if (name === "pidfdSignal") return true;
    if (name === "fdClose") return;
    throw new Error(`意外调用 ${name}`);
  },
} });
mock.method(process, "kill", (pid, signal) => {
  state.calls.push(["kill", pid, signal]);
  if (state.kill) return state.kill(pid, signal);
  return true;
});
const load = () => import(`../../dist/proctable.js?fault=${++serial}`);
const statReadCount = () => state.readCalls.filter((file) => file === "/proc/100/stat").length;
function statReadSequence(...results) {
  let index = 0;
  state.read = (file) => {
    if (file !== "/proc/100/stat") return;
    assert.ok(index < results.length, "stat 读取次数不得超过指定序列");
    const result = results[index++];
    if (result instanceof Error) throw result;
    return result;
  };
}

for (const [kind, initial] of [["空内容", ""], ["截断内容", "100 (命令) S 1 100"]]) {
  for (const code of ["ENOENT", "ESRCH"]) {
    test(`stat ${kind}后重读 ${code} 返回 null`, async () => {
      reset();
      const { processInfo } = await load();
      statReadSequence(initial, fault(code));
      assert.equal(processInfo(100), null);
      assert.equal(statReadCount(), 2);
      assert.ok(!state.readCalls.some((file) => file.includes("boot_id")));
    });
  }

  test(`stat ${kind}后重读有效内容使用新身份并缓存 boot ID`, async () => {
    reset();
    const { processInfo } = await load();
    const recovered = stat(100, "42", 202);
    statReadSequence(initial, recovered);
    const expected = { pid: 100, ppid: 1, pgid: 202, startTime: "boot:42", zombie: false };
    assert.deepEqual(processInfo(100), expected);
    assert.equal(statReadCount(), 2);
    state.read = undefined;
    state.files.set("/proc/100/stat", recovered);
    state.boot = "另一次启动";
    assert.deepEqual(processInfo(100), expected);
    assert.equal(statReadCount(), 3);
    assert.equal(state.readCalls.filter((file) => file.includes("boot_id")).length, 1);
  });

  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
    test(`stat ${kind}后重读 ${code} 传播原错误并保留首次解析故障`, async () => {
      reset();
      const { processInfo } = await load();
      const existingCause = new Error("底层读取原因");
      const readError = Object.assign(new Error("stat 重读失败", { cause: existingCause }), { code });
      statReadSequence(initial, readError);
      assert.throws(() => processInfo(100), (error) => {
        assert.equal(error, readError);
        assert.equal(error.code, code);
        assert.equal(error.cause, existingCause);
        assert.equal(error.statParseError.code, "EHOSTKIT_PROC");
        assert.deepEqual(error.statParseError.statReads, [{ byteLength: Buffer.byteLength(initial), excerpt: initial }]);
        return true;
      });
      assert.equal(statReadCount(), 2);
      assert.ok(!state.readCalls.some((file) => file.includes("boot_id")));
    });
  }
}

for (const [kind, initial, retry] of [
  ["持续空内容", "", ""],
  ["持续截断内容", "100 (命令) S 1 100", "100 (命令) S 1"],
  ["超长坏内容", `首${"坏".repeat(300)}首次尾部`, `次${"错".repeat(400)}重读尾部`],
]) {
  test(`stat ${kind}在两次读取后保留有限诊断并抛错`, async () => {
    reset();
    const { processInfo } = await load();
    statReadSequence(initial, retry);
    const expected = [initial, retry].map((value) => ({ byteLength: Buffer.byteLength(value), excerpt: value.slice(0, 256) }));
    assert.throws(() => processInfo(100), (error) => {
      assert.equal(error.code, "EHOSTKIT_PROC");
      assert.deepEqual(error.statReads, expected);
      assert.ok(error.statReads.every(({ excerpt }) => excerpt.length <= 256));
      assert.ok(error.message.includes(JSON.stringify(expected)));
      assert.equal(error.cause.code, "EHOSTKIT_PROC");
      assert.deepEqual(error.cause.statReads, expected.slice(0, 1));
      if (kind === "超长坏内容") {
        assert.ok(!error.message.includes("首次尾部"));
        assert.ok(!error.message.includes("重读尾部"));
        assert.ok(!error.cause.message.includes("首次尾部"));
        assert.equal(error.statReads[0].excerpt.length, 256);
        assert.equal(error.statReads[1].excerpt.length, 256);
      }
      return true;
    });
    assert.equal(statReadCount(), 2);
    assert.ok(!state.readCalls.some((file) => file.includes("boot_id")));
  });
}

for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ENOTDIR"]) {
  test(`processInfo 的 ${code} 只在确认不存在时返回 null`, async () => {
    reset();
    const { processInfo } = await load();
    state.read = (file) => { if (file === "/proc/100/stat") throw fault(code); };
    if (["ENOENT", "ESRCH"].includes(code)) assert.equal(processInfo(100), null);
    else assert.throws(() => processInfo(100), { code });
    assert.equal(statReadCount(), 1);
  });
}

test("stat 损坏的启动时间、父 PID、进程组和状态都不能产生可用身份", async () => {
  for (const [index, value] of [[19, "bad"], [1, "nan"], [2, "9007199254740992"], [0, ""]]) {
    reset();
    const { processInfo } = await load();
    const fields = stat().slice(stat().lastIndexOf(")") + 2).split(" ");
    fields[index] = value;
    state.files.set("/proc/100/stat", `100 (命令) ${fields.join(" ")}`);
    assert.throws(() => processInfo(100), { code: "EHOSTKIT_PROC" });
    assert.equal(statReadCount(), 2);
  }
});

test("boot ID 读取失败或空内容向上传播，成功结果才缓存", async () => {
  reset();
  const { processInfo } = await load();
  state.read = (file) => { if (file.includes("boot_id")) throw fault("EIO", "boot 查询失败"); };
  assert.throws(() => processInfo(100), /boot 查询失败/);
  state.read = undefined; state.boot = "\n";
  assert.throws(() => processInfo(100), { code: "EHOSTKIT_PROC" });
  state.boot = "boot";
  assert.equal(processInfo(100).startTime, "boot:10");
  state.boot = "另一次启动";
  assert.equal(processInfo(100).startTime, "boot:10");
  assert.equal(state.readCalls.filter((file) => file.includes("boot_id")).length, 3);
  assert.equal(statReadCount(), 4);
});

test("listProcesses 保留可读行并报告每个坏行，消失行不算故障", async () => {
  reset();
  const { listProcesses, ProcessTableError } = await load();
  state.entries = ["100", "101", "102", "103", "not-a-pid"];
  state.read = (file) => {
    if (file === "/proc/101/stat") throw fault("EACCES", "101 不可读");
    if (file === "/proc/103/stat") throw fault("EIO", "103 设备错误");
  };
  assert.throws(listProcesses, (error) => {
    assert.ok(error instanceof ProcessTableError);
    assert.deepEqual(error.rows.map((entry) => entry.pid), [100]);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /101 不可读/); assert.match(error.message, /103 设备错误/);
    return true;
  });
});

test("进程表目录查询失败直接抛错，不返回空表", async () => {
  reset();
  const { listProcesses } = await load();
  state.readdir = () => { throw fault("EIO", "proc 列举失败"); };
  assert.throws(listProcesses, /proc 列举失败/);
});

test("pidfdOpen 非 ENOSYS 错误传播，负 fd 表示已退出", async () => {
  reset();
  const { signalProcess } = await load();
  state.pidfdOpen = () => { throw fault("EPERM"); };
  assert.throws(() => signalProcess(id, "SIGKILL"), { code: "EPERM" });
  state.pidfdOpen = () => -1;
  assert.equal(signalProcess(id, "SIGKILL"), false);
  assert.ok(!state.calls.some(([name]) => name === "pidfdSignal" || name === "fdClose"));
});

test("pidfd 身份查询失败仍关闭 fd，信号与关闭同时失败保留两种原因", async () => {
  reset();
  const { signalProcess } = await load();
  state.read = (file) => { if (file === "/proc/100/stat") throw fault("EIO", "身份读取失败"); };
  state.fdClose = () => { throw fault("EBADF", "关闭 fd 失败"); };
  assert.throws(() => signalProcess(id, "SIGKILL"), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /身份读取失败/); assert.match(error.message, /关闭 fd 失败/);
    assert.equal(error.errors.length, 2); return true;
  });
  state.read = undefined;
  state.pidfdSignal = () => { throw fault("EPERM", "发送信号失败"); };
  assert.throws(() => signalProcess(id, "SIGKILL"), (error) => {
    assert.match(error.message, /发送信号失败/); assert.match(error.message, /关闭 fd 失败/); return true;
  });
});

test("pidfd 成功信号后的关闭失败不能被吞掉", async () => {
  reset();
  const { signalProcess } = await load();
  state.fdClose = () => { throw fault("EBADF"); };
  assert.throws(() => signalProcess(id, "SIGKILL"), { code: "EBADF" });
});

test("PID 复用、僵尸或进程组变化时关闭 fd 且不发送信号", async () => {
  for (const kind of ["reused", "zombie", "group"]) {
    reset();
    const { signalProcess } = await load();
    state.files.set("/proc/100/stat", kind === "reused" ? stat(100, "11") : kind === "group" ? stat(100, "10", 101) : stat().replace(") S ", ") Z "));
    assert.equal(signalProcess(id, "SIGKILL", 100), false);
    assert.equal(state.calls.filter(([name]) => name === "fdClose").length, 1);
    assert.ok(!state.calls.some(([name]) => name === "pidfdSignal" || name === "kill"));
  }
});

test("pidfdOpen ENOSYS 降级 kill，仅 ESRCH 算作目标退出", async () => {
  reset();
  const { signalProcess } = await load();
  state.pidfdOpen = () => { throw fault("ENOSYS"); };
  state.kill = () => { throw fault("ESRCH"); };
  assert.equal(signalProcess(id, "SIGKILL"), false);
  state.kill = () => { throw fault("EPERM"); };
  assert.throws(() => signalProcess(id, "SIGKILL"), { code: "EPERM" });
  assert.equal(state.calls.filter(([name]) => name === "pidfdOpen").length, 1);
});

test("进程组 pidfd EINVAL 降级，其他错误传播并关闭两个 fd", async () => {
  reset();
  let api = await load();
  state.pidfdSignal = () => { throw fault("EPERM", "进程组信号失败"); };
  assert.throws(() => api.signalProcess(id, "SIGKILL", 100), /进程组信号失败/);
  assert.equal(state.calls.filter(([name]) => name === "fdClose").length, 2);
  reset(); api = await load();
  state.pidfdSignal = () => { throw fault("EINVAL"); };
  assert.equal(api.signalProcess(id, "SIGKILL", 100), true);
  assert.ok(state.calls.some(([name, pid]) => name === "kill" && pid === -100));
  assert.equal(api.signalProcess(id, "SIGKILL", 100), true);
  assert.equal(state.calls.filter(([name]) => name === "pidfdSignal").length, 1);
});

test("组 leader fd 查询或关闭失败不泄漏 member fd", async () => {
  reset();
  const { signalProcess } = await load();
  state.files.set("/proc/101/stat", stat(101, "11", 100));
  const member = { pid: 101, startTime: "boot:11" };
  state.read = (file) => { if (file === "/proc/100/stat") throw fault("EIO", "leader 查询失败"); };
  state.fdClose = (fd) => { if (fd === 1100) throw fault("EBADF", "leader fd 关闭失败"); };
  assert.throws(() => signalProcess(member, "SIGKILL", 100), (error) => {
    assert.match(error.message, /leader 查询失败/); assert.match(error.message, /leader fd 关闭失败/); return true;
  });
  assert.deepEqual(state.calls.filter(([name]) => name === "fdClose").map(([, fd]) => fd), [1100, 1101]);
});

test("组 leader 消失时经成员复查降级 kill，成员查询失败不能误发", async () => {
  reset();
  const { signalProcess } = await load();
  state.files.set("/proc/101/stat", stat(101, "11", 100));
  const member = { pid: 101, startTime: "boot:11" };
  state.pidfdOpen = (pid) => pid === 100 ? -1 : 1101;
  assert.equal(signalProcess(member, "SIGKILL", 100), true);
  assert.ok(state.calls.some(([name, pid]) => name === "kill" && pid === -100));
  state.calls = [];
  let reads = 0;
  state.read = (file) => { if (file === "/proc/101/stat" && ++reads > 1) throw fault("EIO", "成员复查失败"); };
  assert.throws(() => signalProcess(member, "SIGKILL", 100), /成员复查失败/);
  assert.ok(!state.calls.some(([name]) => name === "kill"));
  assert.equal(state.calls.filter(([name]) => name === "fdClose").length, 1);
});

test("Linux 命令行查询失败保留既有 unknown 契约，不能拿来证明退出", async () => {
  reset();
  const { processCommandLine, processInfo } = await load();
  state.files.set("/proc/100/cmdline", "node\0entry\0");
  assert.deepEqual(processCommandLine(100), ["node", "entry"]);
  state.read = (file) => { if (file.endsWith("/cmdline")) throw fault("EACCES", "命令行不可读"); };
  assert.equal(processCommandLine(100), null);
  assert.equal(processInfo(100).startTime, id.startTime);
});

test("原生进程查询及进程表错误传播，macOS 的 kill 仅把 ESRCH 当退出", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    reset();
    const { processInfo, listProcesses, signalProcess } = await load();
    state.processInfo = () => { throw fault("EIO", "原生身份查询失败"); };
    state.listProcesses = () => { throw fault("EACCES", "原生进程表失败"); };
    assert.throws(() => processInfo(100), /原生身份查询失败/);
    assert.throws(listProcesses, /原生进程表失败/);
    state.processInfo = () => ({ ...id, ppid: 1, pgid: 100, zombie: false });
    state.kill = () => { throw fault("ESRCH"); };
    assert.equal(signalProcess(id, "SIGKILL", 100), false);
    state.kill = () => { throw fault("EPERM"); };
    assert.throws(() => signalProcess(id, "SIGKILL", 100), { code: "EPERM" });
  } finally {
    Object.defineProperty(process, "platform", { value: "linux" });
  }
});
