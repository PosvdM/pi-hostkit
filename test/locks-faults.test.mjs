import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { boundaryModule, fault } from "./fixtures/boundary-module.mjs";
import { ProcessTableError } from "../dist/proctable.js";

const identity = { pid: 123, startTime: "start", runId: "run", instanceId: "instance" };
const host = { app: "pi-pane", identity };

async function fixture(platform = "linux") {
  const files = new Map();
  const failures = new Map();
  const calls = [];
  let held = false;
  const status = {
    identities: [], scopes: [], rows: [{ pid: 456 }], args: new Map(),
    report: { steps: [], leftovers: [] }, reports: [], stopErrors: [], stopped: [],
    commandErrors: new Map(), protocolErrors: [], spawnReport: { steps: [], leftovers: [] },
    pathErrors: { canonical: new Map(), key: new Map() }, pathQueries: [],
  };
  const dir = path.resolve("lock-home");
  const file = path.resolve("session.jsonl");
  const recordFile = path.join(dir, ".pi", "hostkit", "locks", `session-${createHash("sha256").update(file).digest("hex")}.json`);
  const invoke = (name) => { calls.push(name); if (failures.has(name)) throw failures.get(name); };
  const probePath = (operation, p) => {
    invoke(operation);
    status.pathQueries.push({ operation, path: p });
    if (status.pathErrors[operation].has(p)) throw status.pathErrors[operation].get(p);
    return p;
  };
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
    "./paths.js": { comparisonKey: (p) => probePath("key", p), realPathOrPending: (p) => probePath("canonical", p) },
    "./localfs.js": { assertLocalFilesystem: () => invoke("localfs") },
    "./secrets.js": { ensurePrivateDir: async () => invoke("private-dir") },
    "./native.js": { nativeFn: (name) => () => {
      if (status.releaseActuallyCompletes && ["fdClose", "mutexRelease"].includes(name)) held = false;
      invoke(name);
      if (name === "userSid") return "sid";
      if (["flockAcquire", "mutexAcquire"].includes(name)) { if (held) return -1; held = true; return 10; }
      held = false;
    } },
    "./process.js": {
      isSameProcess: async () => { invoke("identity"); const value = status.identities.shift() ?? "gone"; if (value instanceof Error) throw value; return value; },
      scopePopulated: () => { invoke("scope"); const value = status.scopes.shift() ?? false; if (value instanceof Error) throw value; return value; },
      stopByIdentity: async (candidate) => {
        invoke("stop");
        status.stopped.push(candidate.pid);
        const error = status.stopErrors.shift();
        if (error) throw error;
        return status.reports.shift() ?? status.report;
      },
      spawnManaged: async () => {
        invoke("spawn");
        return {
          identity, exited: new Promise(() => {}), release() { invoke("gate-release"); },
          stop: async () => { invoke("spawn-stop"); return status.spawnReport; },
        };
      },
    },
    "./fs-probe.js": { pathExistsStrict: () => {
      invoke("gate-protocol");
      const error = status.protocolErrors.shift();
      if (error) throw error;
      return true;
    } },
    "./proctable.js": {
      ProcessTableError,
      listProcesses: () => { invoke("processes"); return status.rows; },
      processCommandLine: (pid) => {
        invoke("commandline");
        if (status.commandErrors.has(pid)) throw status.commandErrors.get(pid);
        return status.args.has(pid) ? status.args.get(pid) : [];
      },
    },
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

for (const [platform, code] of [["linux", "EIO"], ["linux", "EINTR"], ["win32", "EIO"]]) {
  test(`${platform}/${code} 原生释放失败保留未知占用且不得重放关闭`, async () => {
    const f = await fixture(platform);
    const lock = await f.acquire();
    const operation = platform === "win32" ? "mutexRelease" : "fdClose";
    const error = f.setFault(operation, code);
    await assert.rejects(lock.release(), (e) => e === error);
    assert.equal(f.held(), true);
    assert.equal((await f.mod.probeSessionWriterLock(f.file)).held, true);
    f.failures.clear();
    await assert.rejects(lock.release(), (e) => e === error);
    assert.equal(f.calls.filter((c) => c === operation).length, 1);
    assert.equal((await f.mod.probeSessionWriterLock(f.file)).held, true);
  });
}

for (const [platform, code] of [["linux", "EINTR"], ["win32", "EIO"]]) {
  test(`恢复后 ${platform} 实际释放但报 ${code}，旧对象永久失去写入资格`, async () => {
    const f = await fixture(platform);
    const lock = await f.acquire();
    assert.equal(await lock.recoverPreviousWriter(), "none");
    f.status.releaseActuallyCompletes = true;
    const operation = platform === "win32" ? "mutexRelease" : "fdClose";
    const failure = f.setFault(operation, code);
    await assert.rejects(lock.release(), (error) => error === failure);
    assert.equal(f.held(), false, "内核锁已实际释放");
    assert.equal(JSON.parse(f.files.get(f.recordFile)).state, "released");
    // 另一宿主已取得内核锁并写入记录，原对象不得覆盖它或启动新写者。
    const external = JSON.stringify({ state: "running", host: "另一宿主" });
    f.files.set(f.recordFile, external);
    const writes = f.calls.filter((call) => call === "write").length;
    f.failures.clear();
    await assert.rejects(lock.update({ state: "running" }), { code: "EHOSTKIT_LOCK_STATE" });
    await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }), { code: "EHOSTKIT_LOCK_STATE" });
    await assert.rejects(lock.recoverPreviousWriter(), { code: "EHOSTKIT_LOCK_STATE" });
    await assert.rejects(lock.release(), (error) => error === failure);
    await assert.rejects(lock.release({ writerSwitchedAway: true }), (error) => error === failure);
    assert.equal(f.files.get(f.recordFile), external);
    assert.equal(f.calls.filter((call) => call === "write").length, writes);
    assert.equal(f.calls.includes("spawn"), false);
    assert.equal(f.calls.filter((call) => call === operation).length, 1);
    assert.equal((await f.mod.probeSessionWriterLock(f.file)).held, true, "进程内未知占用仍保留");
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
    // 首个候选失败时没有最终身份查询，第二个候选必须仍然返回 alive。
    f.status.identities.push(...(firstFails === "query" ? [error, "alive", "gone"] : ["alive", "alive", "gone"]));
    if (firstFails === "leftovers") f.status.reports.push({ steps: [], leftovers: [identity] });
    if (firstFails === "stop") f.status.stopErrors.push(error);
    if (firstFails === "leftovers") assert.equal(await lock.recoverPreviousWriter(), "failed");
    else await assert.rejects(lock.recoverPreviousWriter(), (e) => e === error);
    assert.deepEqual(f.status.stopped, firstFails === "query" ? [789] : [456, 789]);
    assert.deepEqual(lock.recoveryReports.at(-1).leftovers, []);
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
    if (unreadable === "throws") f.status.commandErrors.set(456, fault());
    if (unreadable === "gate-protocol") f.status.protocolErrors.push(fault());
    const lock = await f.acquire();
    f.status.identities.push("alive", "gone");
    assert.equal(await lock.recoverPreviousWriter(), "failed");
    assert.deepEqual(f.status.stopped, [789]);
    assert.equal(f.held(), false);
  });
}

test("多个候选的停止错误一并报告且每个目标均已尝试", async () => {
  const f = await fixture();
  f.files.set(f.recordFile, JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" }));
  f.status.rows = [{ pid: 456, startTime: "a" }, { pid: 789, startTime: "b" }];
  for (const row of f.status.rows) f.status.args.set(row.pid, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
  f.status.identities.push("alive", "alive");
  const errors = [fault("EACCES"), fault("EIO")];
  f.status.stopErrors.push(...errors);
  const lock = await f.acquire();
  await assert.rejects(lock.recoverPreviousWriter(), (e) => e instanceof AggregateError && errors.every((error) => e.errors.includes(error)));
  assert.deepEqual(f.status.stopped, [456, 789]);
  assert.equal(f.held(), false);
});

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
  for (const cleanup of ["leftovers", "failed-step"]) {
    test(`spawnWriter ${operation} 失败及停止报告 ${cleanup} 可见，活写者不能普通释放或再次启动`, async () => {
      const f = await fixture();
      const lock = await f.acquire();
      await lock.recoverPreviousWriter();
      const error = f.setFault(operation);
      const report = f.status.spawnReport;
      if (cleanup === "leftovers") report.leftovers.push(identity);
      else report.steps.push({ step: "kill", ok: false, detail: "EPERM", at: "now" });
      const spec = { argv: ["cli.js", "--mode", "rpc", "--session", f.file] };
      await assert.rejects(lock.spawnWriter(spec), (e) => e instanceof AggregateError && e.errors[0] === error && e.errors[1].cause === report);
      f.failures.clear();
      const before = f.files.get(f.recordFile);
      f.status.identities.push("alive");
      await assert.rejects(lock.release(), { code: "EHOSTKIT_LOCK_STATE" });
      const query = f.setFault("identity", "EACCES");
      await assert.rejects(lock.release(), (e) => e.code === "EHOSTKIT_LOCK_STATE" && e.cause === query);
      await assert.rejects(lock.spawnWriter(spec), { code: "EHOSTKIT_LOCK_STATE" });
      assert.equal(f.calls.filter((c) => c === "spawn").length, 1);
      assert.equal(f.files.get(f.recordFile), before);
      assert.equal(f.held(), true);
      f.failures.clear();
      await lock.release();
      assert.equal(f.held(), false);
    });
  }

  test(`spawnWriter ${operation} 失败后的正常停止报告保留首错，grace 和未放行 abort 不构成清理失败`, async () => {
    const f = await fixture();
    const lock = await f.acquire();
    await lock.recoverPreviousWriter();
    const error = f.setFault(operation);
    f.status.spawnReport.steps.push(
      { step: "grace", ok: false, at: "now" },
      { step: "abort", ok: false, detail: "process held at the start gate", at: "now" },
    );
    await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }), (e) => e === error);
    f.failures.clear();
    await lock.release();
  });

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

for (const operation of ["canonical", "key"]) {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    test(`候选 sameFile 的 ${operation}/${code} 失败保留未知状态且仍停止下一写者`, async () => {
      const f = await fixture();
      const old = JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" });
      f.files.set(f.recordFile, old);
      const lock = await f.acquire();
      const uncertainFile = path.resolve("unknown-session.jsonl");
      f.status.rows = [{ pid: 456, startTime: "a" }, { pid: 789, startTime: "b" }];
      f.status.args.set(456, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", uncertainFile]);
      f.status.args.set(789, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
      f.status.pathErrors[operation].set(uncertainFile, fault(code));
      f.status.identities.push("alive", "gone");
      const start = f.status.pathQueries.length;
      assert.equal(await lock.recoverPreviousWriter(), "failed");
      assert.ok(f.status.pathQueries.slice(start).some((query) => query.operation === operation && query.path === uncertainFile));
      assert.deepEqual(f.status.stopped, [789]);
      assert.equal(lock.recoveryReports.length, 1);
      assert.equal(f.files.get(f.recordFile), old);
      assert.equal(f.calls.includes("create"), false);
      assert.equal(f.held(), false);
    });
  }
}

for (const cleanup of ["reject", "leftovers", "failed-step"]) {
  test(`spawnWriter 放行失败与停止 ${cleanup} 聚合时保留首个错误码`, async () => {
    const f = await fixture();
    const lock = await f.acquire();
    await lock.recoverPreviousWriter();
    const primary = f.setFault("gate-release", "EHOSTKIT_RPC_QUEUE_FULL");
    const report = f.status.spawnReport;
    let secondary;
    if (cleanup === "reject") secondary = f.setFault("spawn-stop", "EPERM");
    else if (cleanup === "leftovers") report.leftovers.push(identity);
    else report.steps.push({ step: "SIGKILL pi", ok: false, detail: "EPERM", at: "now" });
    await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }), (e) => {
      assert.ok(e instanceof AggregateError);
      assert.equal(e.code, primary.code);
      assert.equal(e.errors[0], primary);
      if (secondary) assert.equal(e.errors[1], secondary);
      else assert.equal(e.errors[1].cause, report);
      return true;
    });
    f.failures.clear();
    await lock.release({ writerSwitchedAway: true });
  });
}

for (const stage of ["record-cleanup", "abandon", "acquire", "probe", "multiple-writers"]) {
  test(`锁的 ${stage} 聚合错误保留首个错误码`, async () => {
    const f = await fixture();
    const primary = fault("EACCES", stage);
    const cleanup = fault("EIO", "cleanup");
    let operation;
    if (stage === "acquire" || stage === "probe") {
      f.failures.set("read", Object.defineProperty(new Error(), "message", { get() { throw primary; } }));
      f.failures.set("fdClose", cleanup);
      operation = stage === "acquire" ? f.acquire() : f.mod.probeSessionWriterLock(f.file);
    } else if (stage === "multiple-writers") {
      f.files.set(f.recordFile, JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" }));
      f.status.rows = [{ pid: 456, startTime: "a" }, { pid: 789, startTime: "b" }];
      for (const row of f.status.rows) f.status.args.set(row.pid, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
      f.status.identities.push("alive", "alive");
      f.status.stopErrors.push(primary, cleanup);
      operation = (await f.acquire()).recoverPreviousWriter();
    } else {
      const lock = await f.acquire();
      f.failures.set("write", primary);
      f.failures.set(stage === "record-cleanup" ? "unlink" : "fdClose", cleanup);
      operation = lock.recoverPreviousWriter();
    }
    await assert.rejects(operation, (e) => {
      assert.ok(e instanceof AggregateError);
      assert.equal(e.code, primary.code);
      assert.deepEqual(e.errors, [primary, cleanup]);
      return true;
    });
  });
}

for (const stopFails of [false, true]) {
  test(`部分进程表保留可读写者并报告查询失败（停止失败=${stopFails}）`, async () => {
    const f = await fixture();
    const old = JSON.stringify({ version: 1, sessionFile: f.file, host, state: "starting", updatedAt: "old" });
    f.files.set(f.recordFile, old);
    const candidate = { pid: 789, startTime: "b" };
    f.status.args.set(candidate.pid, [path.resolve("gate.js"), "cli.js", "--mode", "rpc", "--session", f.file]);
    const query = new ProcessTableError([fault("EACCES")], [candidate]);
    f.failures.set("processes", query);
    f.status.identities.push("alive", "gone");
    const cleanup = fault("EPERM");
    if (stopFails) f.status.stopErrors.push(cleanup);
    const lock = await f.acquire();
    await assert.rejects(lock.recoverPreviousWriter(), (error) => {
      if (stopFails) assert.deepEqual(error.errors, [query, cleanup]);
      else assert.equal(error, query);
      return true;
    });
    assert.deepEqual(f.status.stopped, [candidate.pid]);
    assert.equal(f.files.get(f.recordFile), old);
    assert.equal(f.held(), false);
    assert.equal(lock.recoveryReports.length, stopFails ? 0 : 1);
  });
}

for (const detail of ["not running or identity changed", "EPERM", "query failed: not running or identity changed"]) {
  test(`spawnWriter 停止步骤 SIGKILL pi/${detail} 区分跳过与真正失败`, async () => {
    const f = await fixture();
    const lock = await f.acquire();
    await lock.recoverPreviousWriter();
    const primary = f.setFault("gate-release", "EHOSTKIT_RPC_QUEUE_FULL");
    const report = f.status.spawnReport;
    report.steps.push({ step: "SIGKILL pi", ok: false, detail, at: "now" });
    await assert.rejects(lock.spawnWriter({ argv: ["cli.js", "--mode", "rpc", "--session", f.file] }), (e) => {
      if (detail === "not running or identity changed") assert.equal(e, primary);
      else {
        assert.ok(e instanceof AggregateError);
        assert.equal(e.code, primary.code);
        assert.equal(e.errors[1].cause, report);
      }
      return true;
    });
    f.failures.clear();
    await lock.release();
  });
}
