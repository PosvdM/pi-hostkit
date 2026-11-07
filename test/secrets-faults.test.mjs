import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { boundaryModule, fault } from "./fixtures/boundary-module.mjs";

async function fixture({ platform = "linux", fail = [], unsafe = false, at = {} } = {}) {
  const calls = [];
  const errors = new Map(fail.map((name) => [name, fault("EACCES", name)]));
  const file = path.resolve("private", "key");
  const dir = path.dirname(file);
  const invoke = (name) => {
    calls.push(name);
    if (errors.has(name) && (at[name] === undefined || calls.filter((call) => call === name).length === at[name])) throw errors.get(name);
  };
  const info = (directory) => ({
    uid: process.getuid?.() ?? 0, mode: unsafe ? 0o755 : directory ? 0o700 : 0o600,
    isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory,
  });
  const handle = {
    async writeFile() { invoke("write"); }, async sync() { invoke("sync"); }, async close() { invoke("close"); },
  };
  const mod = await boundaryModule("secrets", { platform, imports: {
    "node:fs/promises": {
      async mkdir() { invoke("mkdir"); }, async chmod() { invoke("chmod"); },
      async lstat(p) { invoke(p === file ? "file-stat" : "dir-stat"); return info(p === dir); },
      async open() { invoke("open"); return handle; }, async unlink() { invoke("unlink"); },
    },
    "./native.js": { nativeFn: (name) => (..._args) => {
      invoke(name);
      if (name === "userSid") return "user";
      if (name === "readAcl") return { owner: "user", protected: true, nullDacl: false, aces: [{ type: "allow", sid: "user" }] };
      if (name === "aclEntryCount") return unsafe ? 1 : 0;
    } },
  } });
  return { mod, file, dir, calls, errors };
}

for (const operation of ["write", "sync"]) {
  test(`密钥 ${operation} 失败会关闭句柄并删除本次创建的文件`, async () => {
    const f = await fixture({ fail: [operation] });
    await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => e === f.errors.get(operation));
    assert.deepEqual(f.calls.slice(-2), ["close", "unlink"]);
  });
  for (const cleanup of ["close", "unlink"]) {
    test(`密钥 ${operation} 失败后 ${cleanup} 清理失败可见且继续其余清理`, async () => {
      const f = await fixture({ fail: [operation, cleanup] });
      await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) =>
        e instanceof AggregateError && e.errors.includes(f.errors.get(operation)) && e.errors.includes(f.errors.get(cleanup)));
      assert.ok(f.calls.includes("close"));
      assert.ok(f.calls.includes("unlink"));
    });
  }
}

test("密钥写入后关闭句柄失败仍尝试删除文件", async () => {
  const f = await fixture({ fail: ["close"] });
  await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")));
  assert.ok(f.calls.includes("unlink"));
});

test("密钥最终权限检查失败会删除已写入文件", async () => {
  const f = await fixture({ fail: ["file-stat"] });
  await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), { code: "EHOSTKIT_NOT_PRIVATE" });
  assert.equal(f.calls.at(-1), "unlink");
});

for (const operation of ["dir-stat", "open"]) {
  test(`密钥创建前 ${operation} 失败不得删除不属于本次调用的文件`, async () => {
    const f = await fixture({ fail: [operation] });
    await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")));
    assert.equal(f.calls.includes("unlink"), false);
    assert.equal(f.calls.includes("write"), false);
  });
}

for (const [platform, operation, unsafe] of [
  ["linux", "mkdir", false], ["linux", "dir-stat", false], ["linux", "chmod", true],
  ["win32", "setPrivateAcl", false], ["win32", "userSid", false], ["win32", "readAcl", false],
  ["darwin", "aclEntryCount", false], ["darwin", "aclClear", true],
]) {
  test(`私密目录 ${platform}/${operation} 失败必须拒绝`, async () => {
    const f = await fixture({ platform, fail: [operation], unsafe });
    await assert.rejects(f.mod.ensurePrivateDir(f.dir));
  });
}

for (const operation of ["userSid", "readAcl", "aclEntryCount"]) {
  test(`权限查询 ${operation} 失败不得报告私密`, async () => {
    const f = await fixture({ platform: operation === "aclEntryCount" ? "darwin" : "win32", fail: [operation] });
    await assert.rejects(f.mod.checkPrivate(f.dir), (e) => e === f.errors.get(operation));
  });
}

for (const cleanupFails of [false, true]) {
  test(`Windows 原子创建后重新打开失败会清理且报告清理错误（${cleanupFails}）`, async () => {
    const f = await fixture({ platform: "win32", fail: ["open", ...(cleanupFails ? ["unlink"] : [])] });
    await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => cleanupFails
      ? e instanceof AggregateError && e.errors.includes(f.errors.get("open")) && e.errors.includes(f.errors.get("unlink"))
      : e === f.errors.get("open"));
    assert.ok(f.calls.includes("createPrivateFile"));
    assert.ok(f.calls.includes("unlink"));
  });
}

test("Windows 原子创建失败不得删除既有文件", async () => {
  const f = await fixture({ platform: "win32", fail: ["createPrivateFile"] });
  await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")));
  assert.equal(f.calls.includes("unlink"), false);
});

test("macOS 文件 ACL 清理失败也关闭和删除文件", async () => {
  // 父目录无 ACL，只有文件继承了异常 ACL。
  const calls = [];
  const mod = await boundaryModule("secrets", { platform: "darwin", imports: {
    "node:fs/promises": {
      lstat: async () => ({ uid: process.getuid?.() ?? 0, mode: 0o700, isSymbolicLink: () => false, isDirectory: () => true }),
      open: async () => ({ close: async () => calls.push("close") }), unlink: async () => calls.push("unlink"),
    },
    "./native.js": { nativeFn: (name) => (p) => {
      if (name === "aclEntryCount") return path.basename(p) === "key" ? 1 : 0;
      throw fault("EPERM");
    } },
  } });
  await assert.rejects(mod.writePrivateFile(path.resolve("private", "key"), Buffer.from("x")), { code: "EPERM" });
  assert.deepEqual(calls, ["close", "unlink"]);
});

for (const platform of ["linux", "win32", "darwin"]) {
  test(`私密目录 ${platform} 最终 lstat 复核失败不能被前置成功掩盖`, async () => {
    const f = await fixture({ platform, fail: ["dir-stat"], at: { "dir-stat": 2 } });
    await assert.rejects(f.mod.ensurePrivateDir(f.dir), (e) => {
      assert.equal(e.code, "EHOSTKIT_NOT_PRIVATE");
      assert.ok(e.message.includes(f.errors.get("dir-stat").message));
      return true;
    });
    assert.equal(f.calls.filter((call) => call === "dir-stat").length, 2);
    if (platform === "win32") assert.ok(f.calls.indexOf("setPrivateAcl") < f.calls.lastIndexOf("dir-stat"));
    assert.equal(f.calls.includes("unlink"), false);
  });
}

test("macOS 私密目录最终 ACL 查询失败不能被初次查询成功掩盖", async () => {
  const f = await fixture({ platform: "darwin", fail: ["aclEntryCount"], at: { aclEntryCount: 2 } });
  await assert.rejects(f.mod.ensurePrivateDir(f.dir), (e) => e === f.errors.get("aclEntryCount"));
  assert.equal(f.calls.filter((call) => call === "dir-stat").length, 2);
  assert.equal(f.calls.filter((call) => call === "aclEntryCount").length, 2);
});

for (const [platform, query, occurrence] of [["win32", "userSid", 2], ["win32", "readAcl", 2], ["darwin", "aclEntryCount", 3]]) {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    test(`私密文件最终 ${platform}/${query}/${code} 查询失败删除已写文件`, async () => {
      const f = await fixture({ platform, fail: [query], at: { [query]: occurrence } });
      const error = fault(code, "final-acl");
      f.errors.set(query, error);
      await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => e === error);
      assert.deepEqual(f.calls.filter((call) => ["write", "sync", "close", "file-stat", "unlink"].includes(call)), ["write", "sync", "close", "file-stat", "unlink"]);
      assert.equal(f.calls.filter((call) => call === query).length, occurrence);
      assert.equal(f.calls.at(-1), "unlink");
    });
  }
}

for (const operation of ["write", "sync", "close", "open"]) {
  test(`私密文件 ${operation} 失败后的 cleanup ENOENT 保留原错而不聚合`, async () => {
    const f = await fixture({ platform: operation === "open" ? "win32" : "linux", fail: [operation] });
    const primary = f.errors.get(operation);
    f.errors.set("unlink", fault("ENOENT"));
    await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => e === primary);
    assert.equal(f.calls.at(-1), "unlink");
    assert.equal(f.calls.filter((call) => call === "close").length, operation === "open" ? 0 : 1);
  });
}

test("私密文件写入与关闭失败时 cleanup ENOENT 不掩盖两项真实错误", async () => {
  const f = await fixture({ fail: ["write", "close"] });
  f.errors.set("unlink", fault("ENOENT"));
  await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.equal(e.code, f.errors.get("write").code);
    assert.deepEqual(e.errors, [f.errors.get("write"), f.errors.get("close")]);
    return true;
  });
  assert.equal(f.calls.at(-1), "unlink");
});

for (const cleanup of ["close", "unlink", "windows-reopen"]) {
  test(`私密文件 ${cleanup} 聚合错误保留首个错误码`, async () => {
    const windows = cleanup === "windows-reopen";
    const f = await fixture({ platform: windows ? "win32" : "linux", fail: [windows ? "open" : "write", windows ? "unlink" : cleanup] });
    const primary = fault("EIO", "primary");
    f.errors.set(windows ? "open" : "write", primary);
    await assert.rejects(f.mod.writePrivateFile(f.file, Buffer.from("x")), (e) => {
      assert.ok(e instanceof AggregateError);
      assert.equal(e.code, primary.code);
      assert.equal(e.errors[0], primary);
      assert.equal(e.errors[1].code, "EACCES");
      return true;
    });
  });
}
