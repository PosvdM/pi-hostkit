import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readIdentity, isSameProcess, stopByIdentity, linuxCgroupSupport } from "../dist/process.js";
import { containment, until } from "./helpers.mjs";

const enabled = process.platform === "linux" && containment === "auto" && !!(await linuxCgroupSupport());
if (process.platform === "linux" && containment === "auto" && process.env.HOSTKIT_TEST_REQUIRE_CGROUP === "1") {
  assert.ok(enabled, "CI 必须真实执行子 cgroup 测试");
}
async function subtree(t) {
  const child = spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--property=Delegate=yes",
    `--unit=pi-hostkit-subtree-${randomUUID().slice(0, 8)}`, "--", process.execPath,
    fileURLToPath(new URL("./fixtures/cgroup-subtree.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let diagnostic = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { diagnostic += data; });
  let info;
  // 即使现场准备失败，也回收 scope，避免测试辅助进程残留。
  t.after(async () => {
    if (info) {
      try { fs.writeFileSync(path.join(info.dir, "cgroup.kill"), "1"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } else if (child.pid) child.kill("SIGKILL");
  });
  await until(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`委派 scope 退出 ${child.exitCode}: ${diagnostic}`);
    const line = output.split("\n").find((row) => row.startsWith("{"));
    if (line) info = JSON.parse(line);
    return info;
  }, 15_000);
  const identity = readIdentity(info.pid, "subtree", "subtree");
  assert.ok(identity);
  identity.cgroup = info.dir;
  const descendants = info.children.map((row) => ({ ...row, identity: readIdentity(row.pid, "child", "subtree") }));
  assert.ok(descendants.every((row) => row.identity));
  return { identity, descendants, dir: info.dir };
}

test("真实子 cgroup 中的残留由 scope 整体清理", { skip: !enabled && "仅 Linux auto 执行", timeout: 40_000 }, async (t) => {
  const fixture = await subtree(t);
  const report = await stopByIdentity(fixture.identity, { termGraceMs: 0 });
  assert.equal(report.coverage, "cgroup");
  assert.deepEqual(report.leftovers, []);
  for (const row of fixture.descendants) assert.equal(await isSameProcess(row.identity), "gone");
});

test("真实子 cgroup 部分查询失败仍清理独立子树，未知分支写入报告", { skip: !enabled && "仅 Linux auto 执行", timeout: 40_000 }, async (t) => {
  const fixture = await subtree(t);
  const originals = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
  fs.readFileSync = (file, ...args) => {
    if (String(file) === path.join(fixture.descendants[0].dir, "cgroup.procs")) {
      throw Object.assign(new Error("注入真实子 cgroup 的 EIO"), { code: "EIO" });
    }
    return originals.readFileSync(file, ...args);
  };
  fs.writeFileSync = (file, ...args) => {
    if (String(file) === path.join(fixture.dir, "cgroup.kill")) {
      throw Object.assign(new Error("注入缺失的 cgroup.kill"), { code: "ENOENT" });
    }
    return originals.writeFileSync(file, ...args);
  };
  syncBuiltinESMExports();
  let report;
  try {
    report = await stopByIdentity(fixture.identity, { termGraceMs: 0 });
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  assert.equal(report.coverage, "cgroup");
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("注入真实子 cgroup 的 EIO")));
  assert.ok(report.leftovers.some((row) => row.pid === 0 && row.exe === `cgroup ${fixture.dir}`));
  assert.equal(await isSameProcess(fixture.descendants[1].identity), "gone");
  assert.equal(await isSameProcess(fixture.descendants[0].identity), "alive");
  assert.equal(await isSameProcess(fixture.identity), "gone");
});
