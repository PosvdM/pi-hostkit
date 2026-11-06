import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { pathExistsStrict } from "../dist/fs-probe.js";
import { here, isWin, tempDir } from "./helpers.mjs";

test("existence probes return false only for confirmed ENOENT or ENODEV", () => {
  const original = fs.statSync;
  let code;
  fs.statSync = () => {
    if (code) throw Object.assign(new Error(`injected ${code}`), { code });
    return {};
  };
  syncBuiltinESMExports();
  try {
    assert.equal(pathExistsStrict("target"), true);
    for (code of ["ENOENT", "ENODEV"]) assert.equal(pathExistsStrict("target"), false);
    for (code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) assert.throws(() => pathExistsStrict("target"), { code });
  } finally {
    fs.statSync = original;
    syncBuiltinESMExports();
  }
});

test("an unreadable recorded scope retains cgroup coverage and an unknown scope report", { skip: isWin }, async (t) => {
  const f = await tempDir("hostkit-scope-probe-");
  t.after(f.cleanup);
  execFileSync(process.execPath, ["--experimental-test-module-mocks", path.join(here, "fixtures", "scope-selection-fault.mjs")], {
    timeout: 30_000, env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, HOSTKIT_TEST_ROOT: f.dir }, stdio: "pipe",
  });
});

test("an unknown gate protocol probe cannot be hidden by another recovered writer", async (t) => {
  const f = await tempDir("hostkit-gate-probe-");
  t.after(f.cleanup);
  execFileSync(process.execPath, ["--experimental-test-module-mocks", path.join(here, "fixtures", "gate-probe-fault.mjs")], {
    timeout: 30_000, env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, HOSTKIT_TEST_ROOT: f.dir }, stdio: "pipe",
  });
});
