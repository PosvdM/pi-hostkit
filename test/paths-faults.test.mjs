import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { boundaryModule, fault } from "./fixtures/boundary-module.mjs";

for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
  test(`读取路径变体遇到 ${code} 不得换成另一个文件`, async () => {
    let calls = 0;
    const error = fault(code);
    const mod = await boundaryModule("paths", { imports: { "node:fs": {
      ...fs, accessSync() { calls++; if (calls === 1) throw error; },
    } } });
    assert.throws(() => mod.resolveReadToolPath("capture's.txt", path.resolve("root")), (e) => e === error);
    assert.equal(calls, 1);
  });
}

test("读取路径仅在 ENOENT 时继续尝试拼写变体", async () => {
  const seen = [];
  const mod = await boundaryModule("paths", { imports: { "node:fs": {
    ...fs, accessSync(p) { seen.push(p); if (seen.length === 1) throw fault("ENOENT"); },
  } } });
  const expected = path.resolve("capture’s.txt");
  assert.equal(mod.resolveReadToolPath("capture's.txt", process.cwd()), expected);
  assert.deepEqual(seen, [path.resolve("capture's.txt"), expected]);
});

for (const operation of ["realpath", "lstat", "readlink"]) {
  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
    test(`待创建路径的 ${operation}/${code} 不得被当成缺失`, async () => {
      const error = fault(code);
      const seen = [];
      const mod = await boundaryModule("paths", { imports: { "node:fs": {
        ...fs,
        realpathSync: { native(p) { seen.push(p); throw operation === "realpath" ? error : fault("ENOENT"); } },
        lstatSync() { if (operation === "lstat") throw error; return { isSymbolicLink: () => true }; },
        readlinkSync() { throw error; },
      } } });
      assert.throws(() => mod.realPathOrPending(path.resolve("missing")), (e) => e === error);
      assert.equal(seen.length, 1);
    });
  }
}

for (const operation of ["statSync", "realpath", "readdirSync", "original", "alias", "parent"]) {
  test(`macOS 大小写探测的 ${operation} 查询失败拒绝生成比较键`, async () => {
    const dir = path.resolve("case-volume");
    const parent = path.dirname(dir);
    let lstats = 0;
    const info = { dev: 1n, ino: 2n, isDirectory: () => true };
    const mod = await boundaryModule("paths", { platform: "darwin", imports: { "node:fs": {
      ...fs,
      statSync(p) { if (operation === "statSync" || (operation === "parent" && p === parent)) throw fault(); return info; },
      realpathSync: { native(p) { if (operation === "realpath") throw fault(); return p; } },
      readdirSync() { if (operation === "readdirSync") throw fault(); return operation === "parent" ? [] : ["Probe"]; },
      lstatSync() { lstats++; if (operation === "original" || (operation === "alias" && lstats === 2)) throw fault(); return info; },
    } } });
    assert.throws(() => mod.comparisonKey(dir), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  });
}

for (const kind of ["directory", "file"]) {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    test(`macOS ${kind} 的第二次目录 stat/${code} 失败不得继续枚举或借父卷作结论`, async () => {
      const dir = path.resolve("case-volume");
      const target = kind === "directory" ? dir : path.join(dir, "item");
      const calls = [];
      let stats = 0;
      const mod = await boundaryModule("paths", { platform: "darwin", imports: { "node:fs": {
        ...fs,
        statSync(p) {
          calls.push({ operation: "stat", path: p });
          if (++stats === 1) {
            assert.equal(p, target);
            return { dev: 1n, ino: 2n, isDirectory: () => kind === "directory" };
          }
          assert.equal(stats, 2);
          assert.equal(p, dir);
          throw fault(code);
        },
        realpathSync: { native(p) { calls.push({ operation: "realpath", path: p }); return p; } },
        readdirSync() { assert.fail("第二次 stat 失败后不得枚举目录"); },
        lstatSync() { assert.fail("第二次 stat 失败后不得读取大小写别名"); },
      } } });
      assert.throws(() => mod.comparisonKey(target), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
      assert.deepEqual(calls, [{ operation: "stat", path: target }, { operation: "realpath", path: target }, { operation: "stat", path: dir }]);
    });
  }
}
