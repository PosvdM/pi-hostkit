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
