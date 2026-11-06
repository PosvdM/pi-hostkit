import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// 只替换隔离副本里的加载器路径；生产 native.ts 没有测试开关。
async function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "hostkit-loader-fault-"));
  const key = `hostkit-test-${path.basename(dir)}`;
  const state = { calls: 0, fail: false, binding: {} };
  globalThis[key] = state;
  const loader = path.join(dir, "loader.cjs");
  writeFileSync(loader, `module.exports = function(root) {
    const state = globalThis[${JSON.stringify(key)}]; state.calls++; state.root = root;
    if (state.fail) throw Object.assign(new Error("原生加载失败"), { code: "ELOAD" });
    return state.binding;
  };`);
  const source = readFileSync(new URL("../dist/native.js", import.meta.url), "utf8");
  assert.ok(source.includes('require("node-gyp-build")'));
  writeFileSync(path.join(dir, "native.mjs"), source.replace('require("node-gyp-build")', `require(${JSON.stringify(loader)})`));
  try { await run(await import(pathToFileURL(path.join(dir, "native.mjs")).href), state); }
  finally { delete globalThis[key]; rmSync(dir, { recursive: true, force: true }); }
}

test("native：模块导入不查询系统，首次使用加载一次并缓存", () => fixture((m, state) => {
  assert.equal(state.calls, 0);
  assert.equal(m.native(), state.binding);
  assert.equal(m.native(), state.binding);
  assert.equal(state.calls, 1);
  assert.ok(path.isAbsolute(state.root));
}));

test("native：加载失败可见，不缓存失败，下一次允许重试", () => fixture((m, state) => {
  state.fail = true;
  assert.throws(() => m.native(), { code: "ELOAD" });
  state.fail = false;
  assert.equal(m.native(), state.binding);
  assert.equal(state.calls, 2);
}));

test("nativeFn：平台缺失函数抛 ENOTSUP，调用失败保持可见且保留接收者", () => fixture((m, state) => {
  assert.throws(() => m.nativeFn("pidfdOpen"), { code: "ENOTSUP" });
  state.binding.value = 17;
  state.binding.fsInfo = function() { assert.equal(this, state.binding); return this.value; };
  assert.equal(m.nativeFn("fsInfo")(), 17);
  state.binding.fsInfo = function() { throw Object.assign(new Error("系统查询失败"), { code: "EIO" }); };
  assert.throws(() => m.nativeFn("fsInfo")(), { code: "EIO" });
  assert.equal(state.calls, 1);
}));
