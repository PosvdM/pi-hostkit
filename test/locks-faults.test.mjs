import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { boundaryModule, fault } from "./fixtures/boundary-module.mjs";

const identity = { pid: 123, startTime: "start", runId: "run", instanceId: "instance" };
const host = { app: "pi-pane", identity };

async function fixture(platform = "linux") {
  const files = new Map();
  const failures = new Map();
  const calls = [];
  let held = false;
  const status = { identities: [], scopes: [], rows: [{ pid: 456 }], args: new Map(), report: { steps: [], leftovers: [] } };
  const dir = path.resolve("lock-home");
  const file = path.resolve("session.jsonl");
  const recordFile = path.join(dir, ".pi", "hostkit", "locks", `session-${createHash("sha256").update(file).digest("hex")}.json`);
  const invoke = (name) => { calls.push(name); if (failures.has(name)) throw failures.get(name); };
  const mod = await boundaryModule("locks", { platform, imports: {
    "node:crypto": { createHash, randomBytes: (...args) => { invoke("random"); return randomBytes(...args); } },
    "node:fs": {
      mkdirSync() { invoke("mkdir"); },
      readFileSync(p) { invoke("read"); if (!files.has(p)) throw fault("ENOENT"); return files.get(p); },
      openSync(p) {
        invoke("create");
        if (files.has(p)) throw fault("EEXIST");
        files.set(p, "partial");
        return p;
      },
      writeFileSync(p, data) { invoke("write"); files.set(p, data); },
      closeSync() { invoke("temp-close"); },
      renameSync(from, to) { invoke("rename"); files.set(to, files.get(from)); files.delete(from); },
      unlinkSync(p) { invoke("unlink"); files.delete(p); },
    },
    "node:fs/promises": { mkdir: async () => invoke("instance-mkdir"), realpath: async (p) => { invoke("instance-realpath"); return p; } },
    "node:os": { homedir: () => dir },
    "./paths.js": { comparisonKey: (p) => { invoke("key"); return p; }, realPathOrPending: (p) => { invoke("canonical"); return p; } },
    "./localfs.js": { assertLocalFilesystem: () => invoke("localfs") },
    "./secrets.js": { ensurePrivateDir: async () => invoke("private-dir") },
    "./native.js": { nativeFn: (name) => () => {
      invoke(name);
      if (name === "userSid") return "sid";
      if (["flockAcquire", "mutexAcquire"].includes(name)) { if (held) return -1; held = true; return 10; }
      held = false;
    } },
    "./process.js": {
      isSameProcess: async () => { invoke("identity"); const value = status.identities.shift() ?? "gone"; if (value instanceof Error) throw value; return value; },
      scopePopulated: () => { invoke("scope"); const value = status.scopes.shift() ?? false; if (value instanceof Error) throw value; return value; },
      stopByIdentity: async () => { invoke("stop"); return status.report; },
      spawnManaged: async () => { invoke("spawn"); return { identity, exited: new Promise(() => {}), release() { invoke("gate-release"); }, stop: async () => { invoke("spawn-stop"); } }; },
    },
    "./fs-probe.js": { pathExistsStrict: () => { invoke("gate-protocol"); return true; } },
    "./proctable.js": { listProcesses: () => { invoke("processes"); return status.rows; }, processCommandLine: (pid) => { invoke("commandline"); return status.args.has(pid) ? status.args.get(pid) : []; } },
  } });
  const setFault = (name, code = "EIO") => { const error = fault(code, name); failures.set(name, error); return error; };
  const acquire = () => mod.acquireSessionWriterLock(file, host);
  return { mod, acquire, files, failures, calls, setFault, recordFile, file, status, held: () => held };
}

for (const [platform, operation] of [["linux", "instance-mkdir"], ["linux", "instance-realpath"], ["win32", "userSid"], ["win32", "mutexAcquire"]]) {
  test(`实例锁 ${platform}/${operation} 失败不得留下占用`, async () => {
    const f = await fixture(platform);
    const error = f.setFault(operation);
    await assert.rejects(f.mod.acquireInstanceLock("daemon", path.dirname(f.file)), (e) => e === error);
    assert.equal(f.held(), false);
  });
}

for (const operation of ["mkdir", "private-dir", "localfs", "canonical", "key", "flockAcquire"]) {
  test(`拿锁前 ${operation} 失败不得留下占用`, async () => {
    const f = await fixture();
    const error = f.setFault(operation, "EACCES");
    await assert.rejects(f.acquire(), (e) => e === error);
    assert.equal(f.held(), false);
    f.failures.clear();
    const lock = await f.acquire();
    await lock.release();
  });
}

for (const code of ["EACCES", "EPERM", "EIO"]) {
  test(`锁记录读取 ${code} 不得恢复成没有前任写者`, async () => {
    const f = await fixture();
    f.setFault("read", code);
    const lock = await f.acquire();
    assert.equal(await lock.recoverPreviousWriter(), "failed");
    assert.equal(f.held(), false);
    assert.equal(f.calls.includes("create"), false);
  });
}

for (const phase of ["recover", "update", "release"]) {
  for (const operation of ["random", "create", "write", "temp-close", "rename"]) {
    test(`${phase} 的临时记录 ${operation} 失败遵守持锁与提交不变式`, async () => {
      const f = await fixture();
      const lock = await f.acquire();
      if (phase !== "recover") await lock.recoverPreviousWriter();
      const before = f.files.get(f.recordFile);
      const error = f.setFault(operation, "EACCES");
      const op = () => phase === "recover" ? lock.recoverPreviousWriter() : phase === "update" ? lock.update({ state: "running" }) : lock.release();
      await assert.rejects(op(), (e) => e === error);
      assert.equal(f.files.get(f.recordFile), before);
      assert.equal([...f.files.keys()].some((p) => p.endsWith(".tmp")), false);
      assert.equal(f.held(), phase !== "recover");
      f.failures.clear();
      if (phase === "recover") await (await f.acquire()).release();
      else {
        await lock.update({ state: "stopping" });
        assert.equal(JSON.parse(f.files.get(f.recordFile)).state, "stopping");
        await lock.release();
      }
    });
  }
}

for (const operation of ["write", "temp-close", "rename"]) {
  test(`临时记录 ${operation} 及删除同时失败时保留两项错误`, async () => {
    const f = await fixture();
    const lock = await f.acquire();
    const primary = f.setFault(operation);
    const cleanup = f.setFault("unlink", "EPERM");
    await assert.rejects(lock.recoverPreviousWriter(), (e) => e instanceof AggregateError && e.errors.includes(primary) && e.errors.includes(cleanup));
    assert.equal(f.held(), false);
  });
}

test("临时记录独占创建失败不得删除别人的临时文件", async () => {
  const f = await fixture();
  const lock = await f.acquire();
  f.setFault("create", "EEXIST");
  await assert.rejects(lock.recoverPreviousWriter(), { code: "EEXIST" });
  assert.equal(f.calls.includes("unlink"), false);
  assert.equal(f.held(), false);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} 原生释放失败保留未知占用且不得重放关闭`, async () => {
    const f = await fixture(platform);
    const lock = await f.acquire();
    const operation = platform === "win32" ? "mutexRelease" : "fdClose";
    const error = f.setFault(operation);
    await assert.rejects(lock.release(), (e) => e === error);
    assert.equal(f.held(), true);
    assert.equal((await f.mod.probeSessionWriterLock(f.file)).held, true);
    f.failures.clear();
    await assert.rejects(lock.release(), (e) => e === error);
    assert.equal(f.calls.filter((c) => c === operation).length, 1);
    assert.equal((await f.mod.probeSessionWriterLock(f.file)).held, true);
  });
}

for (const operation of ["acquire", "probe"]) {
  for (const closeFails of [false, true]) {
    test(`${operation} 拿锁后的意外记录异常必须释放，释放失败保留两项错误（${closeFails}）`, async () => {
      const f = await fixture();
      const primary = fault("EIO", "unexpected-read");
      f.failures.set("read", Object.defineProperty(new Error(), "message", { get() { throw primary; } }));
      const cleanup = closeFails ? f.setFault("fdClose") : undefined;
      const op = operation === "acquire" ? f.acquire() : f.mod.probeSessionWriterLock(f.file);
      await assert.rejects(op, (e) => closeFails
        ? e instanceof AggregateError && e.errors.includes(primary) && e.errors.includes(cleanup)
        : e === primary);
      assert.equal(f.held(), closeFails);
      assert.equal(f.calls.filter((c) => c === "fdClose").length, 1);
    });
  }
}

test("临时写和关闭同时失败会继续删除，并报告两个错误", async () => {
  const f = await fixture();
  const lock = await f.acquire();
  const primary = f.setFault("write");
  const cleanup = f.setFault("temp-close");
  await assert.rejects(lock.recoverPreviousWriter(), (e) => e instanceof AggregateError && e.errors.includes(primary) && e.errors.includes(cleanup));
  assert.equal([...f.files.keys()].some((p) => p.endsWith(".tmp")), false);
  assert.equal(f.held(), false);
  assert.equal(f.calls.filter((c) => c === "temp-close").length, 1);
});

for (const operation of ["identity", "scope", "processes", "commandline"]) {
  test(`前任写者 ${operation} 查询失败时释放锁并保留旧记录`, async () => {
    const f = await fixture();
    const old = JSON.stringify({ version: 1, sessionFile: f.file, host, state: "running", updatedAt: "old", ...(["identity", "scope"].includes(operation) ? { writer: identity } : {}) });
    f.files.set(f.recordFile, old);
    const lock = await f.acquire();
    const error = f.setFault(operation);
    if (operation === "commandline") assert.equal(await lock.recoverPreviousWriter(), "failed");
    else await assert.rejects(lock.recoverPreviousWriter(), (e) => e === error);
    assert.equal(f.files.get(f.recordFile), old);
    assert.equal(f.held(), false);
  });
}

test("恢复失败和原生释放失败同时可见，之后不得重放关闭", async () => {
  const f = await fixture();
  const lock = await f.acquire();
  const primary = f.setFault("write");
  const cleanup = f.setFault("fdClose");
  await assert.rejects(lock.recoverPreviousWriter(), (e) => e instanceof AggregateError && e.errors.includes(primary) && e.errors.includes(cleanup));
  f.failures.clear();
  await assert.rejects(lock.release(), (e) => e === cleanup);
  assert.equal(f.calls.filter((c) => c === "fdClose").length, 1);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  for (const transient of [false, true]) {
    test(`Windows rename/${code} ${transient ? "短暂失败重试成功" : "达到重试上限后清理并保持锁"}`, async () => {
      const f = await fixture("win32");
      const lock = await f.acquire();
      await lock.recoverPreviousWriter();
      const before = f.files.get(f.recordFile);
      const error = f.setFault("rename", code);
      if (transient) Object.defineProperty(error, "code", { get() { f.failures.delete("rename"); return code; } });
      const start = f.calls.filter((c) => c === "rename").length;
      if (transient) await lock.update({ state: "running" });
      else {
        await assert.rejects(lock.update({ state: "running" }), (e) => e === error);
        assert.equal(f.files.get(f.recordFile), before);
      }
      assert.equal(f.calls.filter((c) => c === "rename").length - start, transient ? 2 : 21);
      assert.equal([...f.files.keys()].some((p) => p.endsWith(".tmp")), false);
      assert.equal(f.held(), true);
      f.failures.clear();
      await lock.release();
    });
  }
}

for (const firstFails of ["leftovers", "query", "stop"]) {
  test(`首个候选 ${firstFails} 失败后仍清理第二个写者`, async () => {
    const f = await fixture();
    f.files.set(f.recordFile, JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" }));
    f.status.rows = [{ pid: 456, startTime: "a" }, { pid: 789, startTime: "b" }];
    for (const row of f.status.rows) f.status.args.set(row.pid, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
    const lock = await f.acquire();
    const error = fault();
    f.status.identities.push(...(firstFails === "query" ? [error, "alive"] : ["alive", "gone", "alive"]));
    if (firstFails === "leftovers") f.status.report.leftovers.push(identity);
    if (firstFails === "stop") {
      const stop = f.setFault("stop");
      // 只让第一个目标失败。
      f.failures.set("stop", Object.defineProperty(stop, "unused", { value: 1 }));
    }
    if (firstFails === "leftovers") assert.equal(await lock.recoverPreviousWriter(), "failed");
    else await assert.rejects(lock.recoverPreviousWriter());
    assert.equal(f.calls.filter((c) => c === "stop").length, firstFails === "query" ? 1 : 2);
    assert.equal(f.held(), false);
  });
}

for (const unreadable of [null, "throws", "gate-protocol"]) {
  test(`命令行 ${unreadable} 的未知候选不能被已停止的另一候选掩盖`, async () => {
    const f = await fixture();
    f.files.set(f.recordFile, JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" }));
    f.status.rows = [{ pid: 456, startTime: "a" }, { pid: 789, startTime: "b" }];
    f.status.args.set(456, unreadable === "gate-protocol" ? [path.resolve("gate.js")] : null);
    f.status.args.set(789, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
    if (unreadable === "throws") f.setFault("commandline");
    if (unreadable === "gate-protocol") f.setFault("gate-protocol");
    const lock = await f.acquire();
    f.status.identities.push("alive", "gone");
    assert.equal(await lock.recoverPreviousWriter(), "failed");
    if (unreadable === null) assert.equal(f.calls.filter((c) => c === "stop").length, 1);
    assert.equal(f.held(), false);
  });
}

for (const stage of ["stop", "final-identity", "final-scope", "leftovers"]) {
  test(`恢复停止的 ${stage} 失败保留旧记录并释放锁`, async () => {
    const f = await fixture();
    const old = JSON.stringify({ version: 1, sessionFile: f.file, host, writer: identity, state: "running", updatedAt: "old" });
    f.files.set(f.recordFile, old);
    const lock = await f.acquire();
    const error = fault("EIO", stage);
    f.status.identities.push("alive", ...(stage === "final-identity" ? [error] : []));
    if (stage === "stop") f.failures.set("stop", error);
    if (stage === "final-scope") f.status.scopes.push(error);
    if (stage === "leftovers") f.status.report.leftovers.push(identity);
    if (stage === "leftovers") assert.equal(await lock.recoverPreviousWriter(), "failed");
    else await assert.rejects(lock.recoverPreviousWriter(), (e) => e === error);
    assert.equal(f.files.get(f.recordFile), old);
    assert.equal(f.held(), false);
    if (stage !== "stop") assert.equal(lock.recoveryReports.length, 1);
  });
}

test("spawnManaged 失败不改变记录和持锁状态", async () => {
  const f = await fixture();
  const lock = await f.acquire();
  await lock.recoverPreviousWriter();
  const before = f.files.get(f.recordFile);
  const error = f.setFault("spawn");
  await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }), (e) => e === error);
  assert.equal(f.files.get(f.recordFile), before);
  assert.equal(f.held(), true);
  f.failures.clear();
  await lock.release();
});

for (const operation of ["write", "gate-release"]) {
  test(`spawnWriter 的 ${operation} 与停止同时失败时两项错误可见且锁保持占用`, async () => {
    const f = await fixture();
    const lock = await f.acquire();
    await lock.recoverPreviousWriter();
    const primary = f.setFault(operation);
    const cleanup = f.setFault("spawn-stop");
    await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }),
      (e) => e instanceof AggregateError && e.errors.includes(primary) && e.errors.includes(cleanup));
    assert.equal(f.held(), true);
    f.failures.clear();
    await lock.release({ writerSwitchedAway: true });
  });
}
