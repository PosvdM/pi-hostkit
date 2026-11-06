// Verify the recorded-scope decision without sending any real process signals.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import * as table from "../../dist/proctable.js";

const dir = "/sys/fs/cgroup/pi-hostkit-selection-deadbeef.scope";
const root = { pid: 2 ** 30, startTime: "1", runId: "r", instanceId: "i", cgroup: dir };
mock.module(new URL("../../dist/proctable.js", import.meta.url), {
  namedExports: { ...table, processInfo: () => null, listProcesses: () => [], signalProcess: () => false },
});
const { stopByIdentity } = await import("../../dist/process.js");
const originals = { statSync: fs.statSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, readdirSync: fs.readdirSync };
let code = "EACCES";
const fault = () => Object.assign(new Error(`injected scope probe ${code}`), { code });
fs.statSync = (target, ...args) => {
  if (String(target) === dir) throw fault();
  return originals.statSync(target, ...args);
};
fs.readFileSync = (target, ...args) => {
  if (String(target).startsWith(`${dir}/`)) throw fault();
  return originals.readFileSync(target, ...args);
};
fs.readdirSync = (target, ...args) => {
  if (String(target) === dir) throw fault();
  return originals.readdirSync(target, ...args);
};
fs.writeFileSync = (target, ...args) => {
  if (String(target).startsWith(`${dir}/`)) throw fault();
  return originals.writeFileSync(target, ...args);
};
syncBuiltinESMExports();
try {
  const report = await stopByIdentity(root, { termGraceMs: 0 });
  assert.equal(report.coverage, "cgroup");
  assert.ok(report.leftovers.some((row) => row.pid === 0 && row.exe === `cgroup ${dir}`));
  assert.ok(report.steps.some((s) => s.step === "check cgroup directory" && !s.ok && s.detail.includes("EACCES")));
  for (code of ["ENOENT", "ENODEV"]) {
    const missing = await stopByIdentity(root, { termGraceMs: 0 });
    assert.equal(missing.coverage, "snapshot_visible");
    assert.deepEqual(missing.leftovers, []);
  }
} finally {
  Object.assign(fs, originals);
  syncBuiltinESMExports();
}
