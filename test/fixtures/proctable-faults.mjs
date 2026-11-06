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
  state = { files: new Map([["/proc/100/stat", stat()]]), entries: ["100"], boot: "boot", calls: [] };
}
mock.module("node:fs", { namedExports: {
  readdirSync: (dir) => {
    assert.equal(dir, "/proc");
    if (state.readdir) return state.readdir();
    return state.entries;
  },
  readFileSync: (file) => {
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

for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ENOTDIR"]) {
  test(`processInfo 的 ${code} 只在确认不存在时返回 null`, async () => {
    reset();
    const { processInfo } = await load();
    state.read = (file) => { if (file === "/proc/100/stat") throw fault(code); };
    if (["ENOENT", "ESRCH"].includes(code)) assert.equal(processInfo(100), null);
    else assert.throws(() => processInfo(100), { code });
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
