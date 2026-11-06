// Inject filesystem faults only after a real managed user scope has started.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnManaged, isSameProcess } from "../../dist/process.js";

const proc = await spawnManaged({
  argv: [fileURLToPath(new URL("./nonreading-entry.mjs", import.meta.url))],
  cwd: process.env.HOSTKIT_TEST_ROOT,
  env: { ...process.env }, runId: "cgroup-verify-fault", instanceId: "cgroup-verify-fault",
  containment: "auto", startHeld: true,
});
assert.equal(proc.coverage, "cgroup");
const dir = proc.identity.cgroup;
const originals = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.readFileSync = (target, ...args) => {
  if (String(target).startsWith(`${dir}/`) && /cgroup\.(events|procs)$/.test(String(target))) {
    throw Object.assign(new Error("injected cgroup verification I/O failure"), { code: "EIO" });
  }
  return originals.readFileSync(target, ...args);
};
fs.writeFileSync = (target, ...args) => {
  if (String(target) === `${dir}/cgroup.kill`) throw Object.assign(new Error("injected legacy kernel"), { code: "EINVAL" });
  return originals.writeFileSync(target, ...args);
};
syncBuiltinESMExports();
try {
  const first = proc.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
  assert.equal(proc.stop(), first);
  const report = await first;
  assert.equal(await proc.stop(), report);
  assert.equal(report.coverage, "cgroup");
  assert.ok(report.steps.some((s) => !s.ok && s.detail?.includes("injected cgroup verification I/O failure")));
  assert.ok(report.leftovers.some((row) => row.pid === 0 && row.exe === `cgroup ${dir}`));
} finally {
  Object.assign(fs, originals);
  syncBuiltinESMExports();
  await proc.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
}
assert.equal(await isSameProcess(proc.identity), "gone");
