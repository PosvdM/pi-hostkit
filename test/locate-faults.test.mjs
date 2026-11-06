import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { boundaryModule, fault } from "./fixtures/boundary-module.mjs";

const root = path.resolve("managed-fixture");
const pkg = { name: "@earendil-works/pi-coding-agent", version: "1.5.0", bin: { pi: "cli.js" } };
const marker = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };

async function fixture({ operation, code = "EIO", npm = false, explicit = false, malformed } = {}) {
  const error = fault(code, operation);
  const calls = [];
  const mod = await boundaryModule("locate", { imports: {
    "node:os": { homedir: () => root },
    "node:child_process": { execFile(_file, _args, _options, callback) { calls.push("npm"); callback(null, root); } },
    "node:fs/promises": {
      async realpath(p) { calls.push("realpath"); if (operation === "realpath") throw error; return p; },
      async readFile(p) {
        const name = path.basename(p);
        const at = name === "package.json" ? "package" : name === "current-version" ? "version" : "marker";
        calls.push(at);
        if (operation === at) throw error;
        if (npm && at === "marker") throw fault("ENOENT");
        if (malformed && at === "marker") return malformed;
        return at === "marker" ? JSON.stringify(marker) : at === "version" ? "1.5.0" : JSON.stringify(pkg);
      },
      async stat(p) {
        const at = explicit && p === root ? "explicit" : "entry";
        calls.push(at);
        if (operation === at) throw error;
        return { isDirectory: () => at === "explicit", isFile: () => at === "entry" };
      },
    },
  } });
  return { mod, calls, error, options: explicit ? { piPath: root } : {} };
}

for (const mode of ["managed", "npm", "explicit"]) {
  for (const operation of (mode === "managed" ? ["marker", "version", "realpath", "package", "entry"] : mode === "npm" ? ["realpath", "package", "entry"] : ["explicit", "realpath", "package", "entry"])) {
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      test(`${mode} 的 ${operation}/${code} 保留查询错误且不选择后备安装`, async () => {
        const f = await fixture({ operation, code, npm: mode === "npm", explicit: mode === "explicit" });
        await assert.rejects(f.mod.locatePi(f.options), (e) => e === f.error);
        assert.equal(f.calls.filter((c) => c === "npm").length, mode === "npm" ? 1 : 0);
      });
    }
  }
}

for (const malformed of ["null", "{", "[]", "1"]) {
  test(`损坏的安装标记 ${malformed} 可回退且不伪装成系统错误`, async () => {
    const f = await fixture({ malformed });
    assert.equal((await f.mod.locatePi()).version, "1.5.0");
    assert.equal(f.calls.filter((c) => c === "npm").length, 1);
  });
}

test("npm 命令失败可重试，拒绝的缓存不污染下一次定位", async () => {
  let calls = 0;
  const error = fault("EACCES");
  const mod = await boundaryModule("locate", { platform: "linux", imports: {
    "node:os": { homedir: () => root },
    "node:fs/promises": { readFile: async () => { throw fault("ENOENT"); }, realpath: async () => { throw fault("ENOENT"); } },
    "node:child_process": { execFile(_file, _args, _options, callback) { calls++; callback(error, ""); } },
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(mod.locatePi(), { code: "EHOSTKIT_PI_NOT_FOUND" });
  assert.equal(calls, 2);
});

async function cliFixture({ failure, depth, code = "EIO" } = {}) {
  const packageDir = path.resolve("ancestry-fixture", "package");
  const parts = ["one", "two", "three", "four", "five", "cli.js"];
  const cli = path.join(packageDir, ...parts);
  const dirs = [path.dirname(cli)];
  for (let i = 1; i < 6; i++) dirs.push(path.dirname(dirs.at(-1)));
  const calls = [];
  const error = fault(code, failure);
  let rootReads = 0;
  const mod = await boundaryModule("locate", { imports: {
    "node:child_process": { execFile() { assert.fail("显式 CLI 定位失败不得回退 npm"); } },
    "node:os": { homedir() { assert.fail("显式 CLI 定位不得查询托管安装目录"); } },
    "node:fs/promises": {
      async stat(p) { calls.push({ operation: "stat", path: p }); assert.equal(p, cli); return { isDirectory: () => false, isFile: () => true }; },
      async realpath(p) {
        calls.push({ operation: "realpath", path: p });
        assert.ok(p === cli || p === packageDir);
        if (failure === "cli-realpath" && p === cli) throw error;
        return p;
      },
      async readFile(p) {
        calls.push({ operation: "readFile", path: p });
        const index = dirs.findIndex((dir) => p === path.join(dir, "package.json"));
        assert.ok(index >= 0, "只查询当前文件的六层祖先");
        if (failure === "parent-package" && index === depth) throw error;
        if (index < 5) throw fault("ENOENT");
        rootReads++;
        if (failure === "package-reread" && rootReads === 2) throw error;
        return JSON.stringify({ ...pkg, bin: { pi: parts.join("/") } });
      },
    },
  } });
  return { mod, cli, packageDir, dirs, calls, error };
}

for (const code of ["EACCES", "EPERM", "EIO"]) {
  test(`显式 CLI 文件 realpath/${code} 失败不得进入父包查询或回退`, async () => {
    const f = await cliFixture({ failure: "cli-realpath", code });
    await assert.rejects(f.mod.locatePi({ piPath: f.cli }), (e) => e === f.error);
    assert.deepEqual(f.calls, [{ operation: "stat", path: f.cli }, { operation: "realpath", path: f.cli }]);
  });
}

for (let depth = 0; depth < 6; depth++) {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    test(`显式 CLI 向上第 ${depth + 1} 层父包读取 ${code} 失败立即停止`, async () => {
      const f = await cliFixture({ failure: "parent-package", depth, code });
      await assert.rejects(f.mod.locatePi({ piPath: f.cli }), (e) => e === f.error);
      assert.deepEqual(f.calls.filter((call) => call.operation === "readFile").map((call) => call.path),
        f.dirs.slice(0, depth + 1).map((dir) => path.join(dir, "package.json")));
      assert.deepEqual(f.calls.filter((call) => call.operation === "realpath").map((call) => call.path), [f.cli]);
      assert.equal(f.calls.at(-1).operation, "readFile");
    });
  }
}

for (const code of ["EACCES", "EPERM", "EIO"]) {
  test(`显式 CLI 找到包根后重新读取 package.json/${code} 失败不得使用旧结果`, async () => {
    const f = await cliFixture({ failure: "package-reread", code });
    await assert.rejects(f.mod.locatePi({ piPath: f.cli }), (e) => e === f.error);
    assert.equal(f.calls.filter((call) => call.operation === "readFile" && call.path === path.join(f.packageDir, "package.json")).length, 2);
    assert.deepEqual(f.calls.filter((call) => call.operation === "realpath").map((call) => call.path), [f.cli, f.packageDir]);
    assert.equal(f.calls.filter((call) => call.operation === "stat").length, 1);
  });
}

test("显式 CLI 前五层包文件确认为 ENOENT 时仍能定位第六层包根", async () => {
  const f = await cliFixture();
  const install = await f.mod.locatePi({ piPath: f.cli });
  assert.equal(install.packageDir, f.packageDir);
  assert.equal(install.cliEntry, f.cli);
  assert.deepEqual(f.calls.filter((call) => call.operation === "readFile").map((call) => call.path),
    [...f.dirs, f.packageDir].map((dir) => path.join(dir, "package.json")));
});
