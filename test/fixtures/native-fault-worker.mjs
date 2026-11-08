import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";

const b = createRequire(import.meta.url)(process.env.HOSTKIT_TEST_NATIVE_ADDON);
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const dir = mkdtempSync(path.join(tmpdir(), "hostkit-native-cases-"));
const file = path.join(dir, "private");
writeFileSync(file, "");
after(() => rmSync(dir, { recursive: true, force: true }));
const reset = () => b._fault("", 0, 0);
const counts = () => b._stats().slice(0, 3);
const mutex = () => `Local\\hostkit-fault-${randomUUID()}`;

// 每个故障重复三次，核对堆内存、句柄/描述符、LocalFree/ACL 资源的净变化。
function fails(title, op, invoke, { nth = 1, error = win ? 5 : 5, code, before, after: cleanup } = {}) {
  test(title, () => {
    before?.();
    const baseline = counts();
    try {
      for (let i = 0; i < 3; i++) {
        b._fault(op, nth, error);
        try {
          assert.throws(invoke, code ? { code } : (e) => e instanceof Error && typeof e.code === "string");
          if (op) assert.ok(b._stats()[3] >= (nth || 1), `${op} 故障必须实际触发`);
        } finally {
          reset();
          assert.deepEqual(counts(), baseline, `${op} 必须释放临时资源`);
        }
      }
    } finally { reset(); cleanup?.(); }
  });
}
function succeeds(title, invoke) {
  test(title, () => {
    const baseline = counts();
    try { invoke(); } finally { reset(); assert.deepEqual(counts(), baseline); }
  });
}

fails("fsInfo：系统查询失败可见", win ? "GetVolumePathNameW" : "statfs", () => b.fsInfo(file));
succeeds("fsInfo：正常查询与 NUL 拒绝", () => {
  assert.equal(typeof b.fsInfo(file).local, "boolean");
  assert.throws(() => b.fsInfo(`${file}\0tail`), { code: "EINVAL" });
});

if (win) {
  const row = b.processInfo(process.pid);
  const start = row.startTime;
  const command = () => b.processCommandLine(process.pid);
  const terminate = () => b.terminateProcess(process.pid, start);
  fails("processInfo：全局快照失败不能当不存在", "NtQuerySystemInformation", () => b.processInfo(process.pid), { error: 0xc0000022 });
  fails("listProcesses：全局快照失败不能返回空表", "NtQuerySystemInformation", () => b.listProcesses(), { error: 0xc0000022 });
  fails("listProcesses：反复扩容仍失败可见", "NtQuerySystemInformation", () => b.listProcesses(), { nth: 0, error: 0xc0000004 });
  for (const name of ["processInfo", "listProcesses"])
    fails(`${name}：损坏的快照项不能返回部分结果`, "snapshotMalformed", () => b[name](process.pid));
  fails("processInfo：成功查询后的 CloseHandle 失败可见", "CloseHandle", () => b.processInfo(process.pid));
  fails("processCommandLine：成功查询后的 CloseHandle 失败可见", "CloseHandle", command);
  fails("terminateProcess：身份不同仍须报告关闭失败", "CloseHandle", () => b.terminateProcess(process.pid, "wrong"));
  for (const [op, nth] of [["OpenProcess", 1], ["GetProcessTimes", 1], ["WaitForSingleObject", 1]]) {
    fails(`processInfo：${op} 失败可见`, op, () => b.processInfo(process.pid), { nth });
    fails(`processCommandLine：${op} 失败可见`, op, command, { nth });
    fails(`terminateProcess：${op} 失败不能报告已退出`, op, terminate, { nth });
  }
  fails("listProcesses：结果数组创建失败回收快照", "napi_create_array", () => b.listProcesses(), { code: "EHOSTKIT" });
  fails("listProcesses：单行转换失败回收快照", "napi_set_named_property", () => b.listProcesses(), { code: "EHOSTKIT" });
  fails("listProcesses：数组写入失败回收快照", "napi_set_element", () => b.listProcesses(), { code: "EHOSTKIT" });
  for (const [op, nth, error] of [
    ["GetProcAddress", 1, 127], ["NtQueryInformationProcess", 1, 0xc0000022],
    ["NtQueryInformationProcess", 2, 0xc0000022], ["commandMalformed", 1, 0],
    ["malloc", 1, 8], ["malloc", 2, 8], ["CommandLineToArgvW", 1, 8],
    ["napi_create_array", 1, 8], ["napi_set_element", 1, 8],
  ]) fails(`processCommandLine：${op} 第 ${nth} 次失败回收缓冲区与句柄`, op, command, { nth, error });
  fails("terminateProcess：发信号访问拒绝不能报告已退出", "TerminateProcess", terminate);
  fails("terminateProcess：其他发信号失败可见", "TerminateProcess", terminate, { error: 6 });
  succeeds("身份变化和确认不存在可返回否定结果，查询失败不可", () => {
    assert.equal(b.terminateProcess(process.pid, "wrong"), false);
    assert.throws(() => b.terminateProcess(process.pid, `${start}\0extra`), { code: "EINVAL" });
    b._fault("OpenProcess", 1, 87);
    assert.equal(command(), null);
    b._fault("OpenProcess", 1, 87);
    assert.equal(terminate(), false);
    b._fault("OpenProcess", 1, 87);
    assert.equal(b.processInfo(process.pid), null);
  });
  succeeds("正常进程信息、列表、命令行", () => {
    assert.equal(row.pid, process.pid);
    assert.ok(b.listProcesses().some(p => p.pid === process.pid));
    assert.ok(command().includes(process.execPath));
  });
  for (const op of ["CreateJobObjectW", "SetInformationJobObject", "napi_create_int64"])
    fails(`jobCreate：${op} 失败不泄漏 Job`, op, () => b.jobCreate());
  let job;
  const jobSetup = { before: () => { job = b.jobCreate(); }, after: () => b.handleClose(job) };
  for (const op of ["OpenProcess", "WaitForSingleObject", "GetProcessTimes", "AssignProcessToJobObject"])
    fails(`jobAssign：${op} 失败回收进程句柄`, op, () => b.jobAssign(job, process.pid, start), jobSetup);
  fails("jobAssign：身份变化不分配进程", "", () => b.jobAssign(job, process.pid, "wrong"), { ...jobSetup, code: "ESRCH" });
  fails("jobTerminate：失败可见", "TerminateJobObject", () => b.jobTerminate(job), jobSetup);
  fails("jobProcessIds：查询失败不能返回空表", "QueryInformationJobObject", () => b.jobProcessIds(job), jobSetup);
  fails("jobProcessIds：持续 MORE_DATA 不能返回部分结果", "QueryInformationJobObject", () => b.jobProcessIds(job), { ...jobSetup, nth: 0, error: 234 });
  fails("jobProcessIds：成功状态但人口截断不能返回部分结果", "jobTruncated", () => b.jobProcessIds(job), { ...jobSetup, nth: 0, error: 234 });
  fails("jobProcessIds：数组创建失败回收列表", "napi_create_array", () => b.jobProcessIds(job), jobSetup);
  // 只把独立子进程放入 Job，避免 KILL_ON_JOB_CLOSE 终止测试进程。
  function identityFixture() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    child.unref();
    let j;
    try {
      assert.ok(child.pid);
      j = b.jobCreate();
      const identity = b.processInfo(child.pid);
      assert.ok(identity);
      b.jobAssign(j, child.pid, identity.startTime);
      reset();
      return { job: j, pid: child.pid, start: identity.startTime, close() {
        try { b.handleClose(j); } finally { child.kill(); }
      } };
    } catch (error) {
      reset();
      try { if (j) b.handleClose(j); } finally { child.kill(); }
      throw error;
    }
  }
  function withIdentity(invoke) {
    const f = identityFixture();
    try { invoke(f); } finally { reset(); f.close(); }
  }
  const identityTrace = (j, sequence, { member = 1, times = 1, wait = 1 } = {}) => {
    assert.deepEqual(b._identityStats(), [1, member, times, wait, 1, 0, sequence, j]);
  };
  let identity;
  const identitySetup = { before: () => { identity = identityFixture(); }, after: () => identity.close() };
  const queryIdentity = () => b.jobProcessIdentity(identity.job, identity.pid);
  succeeds("jobProcessIdentity：成员身份与存活在同一个固定句柄上确认", () => withIdentity(f => {
    assert.deepEqual(b.jobProcessIdentity(f.job, f.pid), { pid: f.pid, startTime: f.start });
    identityTrace(f.job, 12345);
  }));
  succeeds("jobProcessIdentity：真实非成员不读取创建时间或返回身份", () => {
    const j = b.jobCreate();
    try {
      reset();
      assert.equal(b.jobProcessIdentity(j, process.pid), null);
      identityTrace(j, 125, { times: 0, wait: 0 });
    } finally { reset(); b.handleClose(j); }
  });
  succeeds("jobProcessIdentity：枚举 PID 复用为存活非成员对象时返回 null", () => withIdentity(f => {
    assert.ok(b.jobProcessIds(f.job).includes(f.pid));
    b._fault("jobIdentityReused", 1, 0);
    assert.equal(b.jobProcessIdentity(f.job, f.pid), null);
    assert.equal(b._stats()[3], 1);
    identityTrace(f.job, 125, { times: 0, wait: 0 });
  }));
  succeeds("jobProcessIdentity：明确退出返回 null，且关闭固定句柄", () => withIdentity(f => {
    b._fault("waitResult", 1, 0);
    assert.equal(b.jobProcessIdentity(f.job, f.pid), null);
    assert.equal(b._stats()[3], 1);
    identityTrace(f.job, 12345);
  }));
  succeeds("jobProcessIdentity：OpenProcess 明确不存在才返回 null", () => {
    const j = b.jobCreate();
    try {
      b._fault("OpenProcess", 1, 87);
      assert.equal(b.jobProcessIdentity(j, process.pid), null);
      assert.deepEqual(b._identityStats(), [1, 0, 0, 0, 0, 0, 1, 0]);
      assert.equal(b._stats()[5], 0);
    } finally { reset(); b.handleClose(j); }
  });
  for (const [op, error, code] of [
    ["OpenProcess", 5, "EACCES"], ["OpenProcess", 6, "EWIN6"], ["OpenProcess", 2, "ENOENT"],
    ["IsProcessInJob", 5, "EACCES"], ["IsProcessInJob", 6, "EWIN6"], ["IsProcessInJob", 87, "EINVAL"],
    ["GetProcessTimes", 5, "EACCES"], ["WaitForSingleObject", 5, "EACCES"],
    ["waitResult", 128, "EWIN13"], ["CloseHandle", 6, "EWIN6"],
  ]) fails(`jobProcessIdentity：${op} 错误 ${error} 可见且释放临时句柄`, op, queryIdentity,
    { ...identitySetup, error, code });
  for (const [op, nth] of [
    ["napi_create_object", 1], ["napi_create_uint32", 1], ["napi_create_string_utf8", 1],
    ["napi_set_named_property", 1], ["napi_set_named_property", 2],
  ]) fails(`jobProcessIdentity：${op} 第 ${nth} 次失败前已释放固定句柄`, op, () => {
    try { return queryIdentity(); } finally { identityTrace(identity.job, 12345); }
  }, { ...identitySetup, nth, code: "EHOSTKIT" });
  for (const [op, error, code, sequence, trace] of [
    ["IsProcessInJob", 5, "EACCES", 125, { times: 0, wait: 0 }],
    ["GetProcessTimes", 5, "EACCES", 1235, { wait: 0 }],
    ["WaitForSingleObject", 5, "EACCES", 12345, {}],
    ["waitResult", 128, "EWIN13", 12345, {}],
  ]) succeeds(`jobProcessIdentity：${op} 与关闭双失败保留主错误及关闭错误`, () => withIdentity(f => {
    for (let i = 0; i < 3; i++) {
      b._fault(op, 1, error, "CloseHandle", 1, 6);
      assert.throws(() => b.jobProcessIdentity(f.job, f.pid), e => {
        assert.equal(e.code, code);
        assert.equal(e.errno, op === "waitResult" ? 13 : error);
        assert.match(e.message, new RegExp(op === "waitResult" ? "WaitForSingleObject" : op));
        assert.match(e.message, /CloseHandle\(process\).*Windows error 6/);
        return true;
      });
      assert.deepEqual(b._stats().slice(3, 6), [1, 1, 1]);
      identityTrace(f.job, sequence, trace);
    }
  }));
  succeeds("jobProcessIdentity：非成员的关闭失败不能返回 null", () => {
    const j = b.jobCreate();
    try {
      b._fault("CloseHandle", 1, 6);
      assert.throws(() => b.jobProcessIdentity(j, process.pid), { code: "EWIN6", errno: 6 });
      identityTrace(j, 125, { times: 0, wait: 0 });
      assert.equal(b._stats()[5], 1);
    } finally { reset(); b.handleClose(j); }
  });
  succeeds("jobProcessIdentity：退出结论的关闭失败不能返回 null", () => withIdentity(f => {
    b._fault("waitResult", 1, 0, "CloseHandle", 1, 6);
    assert.throws(() => b.jobProcessIdentity(f.job, f.pid), { code: "EWIN6", errno: 6 });
    identityTrace(f.job, 12345);
    assert.deepEqual(b._stats().slice(3, 6), [1, 1, 1]);
  }));
  succeeds("jobProcessIdentity：参数错误不打开进程句柄", () => {
    for (const args of [[], [0, process.pid], [1, 0], [1, -1], [1, 0x100000000], ["job", process.pid]]) {
      reset();
      assert.throws(() => b.jobProcessIdentity(...args), { code: "EINVAL" });
      assert.deepEqual(b._identityStats(), [0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });
  succeeds("Job 正常创建、查询、终止和关闭", () => {
    const j = b.jobCreate();
    try { assert.deepEqual(b.jobProcessIds(j), []); b.jobTerminate(j); } finally { b.handleClose(j); }
  });
  for (const [op, nth] of [["OpenProcessToken", 1], ["GetTokenInformation", 1], ["GetTokenInformation", 2], ["CopySid", 1], ["ConvertSidToStringSidW", 1], ["malloc", 1], ["malloc", 2], ["CloseHandle", 1]])
    fails(`userSid：${op} 第 ${nth} 次失败不能返回 null`, op, () => b.userSid(), { nth });
  for (const op of ["SetEntriesInAclW", "InitializeSecurityDescriptor", "SetSecurityDescriptorOwner", "SetSecurityDescriptorDacl", "SetSecurityDescriptorControl", "CreateMutexW", "GetSecurityInfo", "WaitForSingleObject", "napi_create_int64"])
    fails(`mutexAcquire：${op} 失败回收 SID、ACL、SD、句柄及所有权`, op, () => b.mutexAcquire(mutex()));
  succeeds("mutexRelease：ReleaseMutex 失败可见且仍尝试关闭句柄", () => {
    const h = b.mutexAcquire(mutex());
    b._fault("ReleaseMutex", 1, 288);
    assert.throws(() => b.mutexRelease(h), (e) => e.errno === 288);
  });
  succeeds("mutexRelease：ReleaseMutex 与 CloseHandle 双失败同时可见且不重试关闭", () => {
    const h = b.mutexAcquire(mutex());
    b._fault("ReleaseMutex", 1, 288, "CloseHandle", 1, 6);
    assert.throws(() => b.mutexRelease(h), (e) => {
      assert.equal(e.errno, 288);
      assert.equal(e.code, "EWIN288");
      assert.match(e.message, /ReleaseMutex/);
      assert.match(e.message, /Windows error 288/);
      assert.match(e.message, /CloseHandle\(mutex\).*Windows error 6/);
      return true;
    });
    assert.deepEqual(b._stats().slice(3, 6), [1, 1, 1]);
  });
  succeeds("mutexRelease：CloseHandle 失败可见", () => {
    const h = b.mutexAcquire(mutex());
    b._fault("CloseHandle", 1, 6);
    assert.throws(() => b.mutexRelease(h), (e) => e.errno === 6);
  });
  succeeds("handleClose：失败可见", () => {
    const h = b.jobCreate();
    b._fault("CloseHandle", 1, 6);
    assert.throws(() => b.handleClose(h), (e) => e.errno === 6);
  });
  fails("fsInfo：卷类型未知不是可用查询结果", "GetDriveTypeW", () => b.fsInfo(file));
  for (const op of ["SetEntriesInAclW", "SetNamedSecurityInfoW"])
    fails(`setPrivateAcl：${op} 失败回收 SID、路径与 ACL`, op, () => b.setPrivateAcl(file, false));
  // 独立文件名避免 CREATE_NEW 的正常 EEXIST 掩盖注入。
  for (const op of ["SetEntriesInAclW", "InitializeSecurityDescriptor", "SetSecurityDescriptorDacl", "SetSecurityDescriptorControl", "CreateFileW"])
    fails(`createPrivateFile：${op} 失败回收临时资源`, op, () => b.createPrivateFile(path.join(dir, randomUUID())));
  succeeds("createPrivateFile：真实关闭后报错仍删除本次文件，且不重试关闭", () => {
    const target = path.join(dir, randomUUID());
    b._fault("CloseHandle", 2, 6); // 第一次关闭 token，第二次关闭文件。
    assert.throws(() => b.createPrivateFile(target), (e) => {
      assert.equal(e.errno, 6);
      assert.match(e.message, /CloseHandle\(file\)/);
      return true;
    });
    assert.throws(() => statSync(target), { code: "ENOENT" });
    assert.deepEqual(b._stats().slice(5, 7), [2, 1]);
  });
  succeeds("createPrivateFile：关闭与删除双失败同时可见，不重试关闭", () => {
    const target = path.join(dir, randomUUID());
    b._fault("CloseHandle", 2, 6, "DeleteFileW", 1, 5);
    try {
      assert.throws(() => b.createPrivateFile(target), (e) => {
        assert.equal(e.errno, 6);
        assert.equal(e.code, "EWIN6");
        assert.match(e.message, /CloseHandle\(file\)/);
        assert.match(e.message, /Windows error 6/);
        assert.match(e.message, /DeleteFileW.*Windows error 5/);
        return true;
      });
      assert.equal(statSync(target).size, 0);
      assert.deepEqual(b._stats().slice(3, 7), [2, 1, 2, 1]);
    } finally { rmSync(target, { force: true }); }
  });
  succeeds("createPrivateFile：成功保留新文件，CREATE_NEW 失败不删除已有文件", () => {
    const target = path.join(dir, randomUUID());
    b.createPrivateFile(target);
    writeFileSync(target, "原有内容");
    b._fault("CloseHandle", 2, 6, "DeleteFileW", 1, 5);
    assert.throws(() => b.createPrivateFile(target), { code: "EEXIST" });
    assert.equal(readFileSync(target, "utf8"), "原有内容");
    assert.deepEqual(b._stats().slice(5, 7), [1, 0]);
  });
  succeeds("私有文件与 ACL 正常读写", () => {
    const originalOwner = b.readAcl(file).owner;
    const user = b.userSid();
    b.setPrivateAcl(file, false);
    const acl = b.readAcl(file);
    // 提权进程创建的文件可能由 Administrators 持有；设置 DACL 不改属主。
    assert.equal(acl.owner, originalOwner);
    assert.ok([user, "S-1-5-32-544", "S-1-5-18"].includes(acl.owner));
    assert.equal(acl.protected, true);
    assert.equal(acl.nullDacl, false);
    assert.equal(acl.aces.length, 1);
    assert.equal(acl.aces[0].type, "allow");
    assert.equal(acl.aces[0].sid, user);
  });
  for (const op of ["GetNamedSecurityInfoW", "GetSecurityDescriptorControl", "GetAce", "ConvertSidToStringSidW", "napi_create_object", "napi_create_array", "napi_set_named_property", "napi_set_element"])
    fails(`readAcl：${op} 失败不能返回不完整的权限结论`, op, () => b.readAcl(file));
} else {
  const lockPath = path.join(dir, "lock");
  for (const op of ["open", "flock", "napi_create_int32"])
    fails(`flockAcquire：${op} 失败回收路径和描述符`, op, () => b.flockAcquire(lockPath));
  succeeds("flockAcquire：确认竞争才返回 -1", () => {
    const fd = b.flockAcquire(lockPath);
    try { assert.equal(b.flockAcquire(lockPath), -1); } finally { b.fdClose(fd); }
  });
  succeeds("flockAcquire：竞争后的 close 失败不能伪装成 busy", () => {
    const fd = b.flockAcquire(lockPath);
    try {
      b._fault("close", 1, 5);
      assert.throws(() => b.flockAcquire(lockPath), { code: "EIO" });
    } finally { reset(); b.fdClose(fd); }
  });
  succeeds("flockAcquire：EINTR 仅重试 flock，不泄漏 fd", () => {
    b._fault("flock", 1, 4);
    const fd = b.flockAcquire(lockPath);
    reset();
    b.fdClose(fd);
  });
  succeeds("fdClose：EINTR 可见且不重试已复用的编号", () => {
    const fd = b.flockAcquire(lockPath);
    b._fault("close", 1, 4);
    assert.throws(() => b.fdClose(fd), { code: "EINTR" });
  });
  if (!mac) {
    for (const op of ["pidfd_open", "napi_create_int32"])
      fails(`pidfdOpen：${op} 失败不泄漏 fd`, op, () => b.pidfdOpen(process.pid));
    succeeds("pidfdOpen：只有 ESRCH 返回 -1", () => {
      b._fault("pidfd_open", 1, 3);
      assert.equal(b.pidfdOpen(process.pid), -1);
    });
    for (const [error, code] of [[1, "EPERM"], [22, "EINVAL"], [38, "ENOSYS"]]) {
      let fd;
      fails(`pidfdSignal：${code} 可见且调用方仍持有 fd`, "pidfd_send_signal", () => b.pidfdSignal(fd, 0, false), {
        error, code, before: () => { fd = b.pidfdOpen(process.pid); }, after: () => b.fdClose(fd),
      });
    }
    succeeds("pidfdSignal：确认退出才返回 false；信号 0 可正常查询", () => {
      const fd = b.pidfdOpen(process.pid);
      try {
        assert.equal(b.pidfdSignal(fd, 0, false), true);
        b._fault("pidfd_send_signal", 1, 3);
        assert.equal(b.pidfdSignal(fd, 0, false), false);
      } finally { reset(); b.fdClose(fd); }
    });
  } else {
    for (const name of ["processInfo", "listProcesses", "processArgs"])
      fails(`${name}：sysctl 失败可见`, "sysctl", () => b[name](process.pid));
    fails("processInfo：部分记录不能当不存在", "sysctlPartial", () => b.processInfo(process.pid));
    fails("listProcesses：部分记录不能返回部分快照", "sysctlPartial", () => b.listProcesses());
    fails("listProcesses：扩容耗尽可见且不泄漏", "sysctlGrow", () => b.listProcesses(), { nth: 0, error: 12 });
    fails("listProcesses：填充快照失败回收缓冲区", "sysctl", () => b.listProcesses(), { nth: 2 });
    fails("processArgs：参数查询失败不能返回 null", "sysctl", () => b.processArgs(process.pid), { nth: 2 });
    fails("processArgs：缓冲区分配失败可见", "malloc", () => b.processArgs(process.pid));
    fails("processArgs：结果截断不能返回空参数", "sysctlPartial", () => b.processArgs(process.pid), { nth: 2 });
    for (const name of ["listProcesses", "processArgs"]) {
      fails(`${name}：结果数组分配失败回收缓冲区`, "napi_create_array", () => b[name](process.pid));
      fails(`${name}：数组元素写入失败回收缓冲区`, "napi_set_element", () => b[name](process.pid));
    }
    succeeds("macOS 进程查询正常结果", () => {
      assert.equal(b.processInfo(process.pid).pid, process.pid);
      assert.ok(b.listProcesses().some(p => p.pid === process.pid));
      assert.ok(b.processArgs(process.pid).length > 0);
      b._fault("sysctl", 2, 3);
      assert.equal(b.processArgs(process.pid), null);
    });
    // 显式写入 ACL，避免无 ACL 文件的 ENOENT 快路径遮住枚举故障。
    test("macOS ACL 故障准备：写入可枚举条目", () => {
      execFileSync("/bin/chmod", ["+a", `user:${userInfo().username} allow read`, file], { timeout: 10_000 });
      assert.ok(b.aclEntryCount(file) > 0);
    });
    for (const op of ["acl_get_link_np", "acl_get_entry", "acl_free"])
      fails(`aclEntryCount：${op} 失败可见且释放 ACL`, op, () => b.aclEntryCount(file));
    for (const op of ["acl_init", "acl_set_link_np", "acl_free"])
      fails(`aclClear：${op} 失败可见且释放路径/ACL`, op, () => b.aclClear(file));
    succeeds("macOS ACL 正常清空和计数", () => { b.aclClear(file); assert.equal(b.aclEntryCount(file), 0); });
  }
}
