// This child explicitly enables module mocks; production does not expose a hook.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as table from "../../dist/proctable.js";

mock.module(new URL("../../dist/proctable.js", import.meta.url), {
  namedExports: { ...table, listProcesses: () => { throw new Error("injected final snapshot failure"); } },
});
const { spawnManaged, isSameProcess } = await import("../../dist/process.js");
const proc = await spawnManaged({
  argv: [fileURLToPath(new URL("./nonreading-entry.mjs", import.meta.url))],
  cwd: process.env.HOSTKIT_TEST_ROOT,
  env: { ...process.env },
  runId: "capture-fault", instanceId: "capture-fault", containment: "snapshot", startHeld: true,
});
const a = proc.stop({ abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
const b = proc.stop();
assert.equal(a, b);
const report = await a;
assert.equal(await proc.stop(), report);
assert.ok(report.steps.some((s) => s.step === "snapshot" && !s.ok && s.detail.includes("injected final snapshot failure")));
assert.equal(await isSameProcess(proc.identity), "gone");
