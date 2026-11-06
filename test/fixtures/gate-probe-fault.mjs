// A readable candidate must not hide another gate whose protocol probe is unknown.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import * as processes from "../../dist/process.js";
import * as table from "../../dist/proctable.js";

const sessionFile = path.join(process.env.HOSTKIT_TEST_ROOT, "recovery.jsonl");
const deniedDir = path.join(process.env.HOSTKIT_TEST_ROOT, "denied-gate");
fs.mkdirSync(deniedDir);
const deniedProtocol = path.join(deniedDir, "gate-protocol.js");
fs.writeFileSync(deniedProtocol, "// fixture\n");
const ids = [2 ** 30 - 1, 2 ** 30 - 2].map((pid) => ({ pid, ppid: 1, startTime: "1", zombie: false }));
const stopped = new Set();
mock.module(new URL("../../dist/process.js", import.meta.url), {
  namedExports: {
    ...processes,
    isSameProcess: async (id) => stopped.has(id.pid) ? "gone" : "alive",
    stopByIdentity: async (id) => {
      stopped.add(id.pid);
      return { coverage: "snapshot_visible", steps: [], leftovers: [] };
    },
  },
});
mock.module(new URL("../../dist/proctable.js", import.meta.url), {
  namedExports: {
    ...table, listProcesses: () => ids,
    processCommandLine: (pid) => [
      process.execPath,
      pid === ids[0].pid ? path.join(deniedDir, "gate.js") : fileURLToPath(new URL("../../dist/gate.js", import.meta.url)),
      "pi-entry.js", "--mode", "rpc", "--session", sessionFile,
    ],
  },
});
const locks = await import("../../dist/locks.js");
const host = { app: "pi-pane", identity: processes.currentProcessIdentity("gate-probe-test") };
const first = await locks.acquireSessionWriterLock(sessionFile, host);
await first.recoverPreviousWriter();
const recordFile = path.join(locks.sessionLocksDir(), fs.readdirSync(locks.sessionLocksDir()).find((f) => f.endsWith(".json")));
const starting = fs.readFileSync(recordFile, "utf8");
await first.release();
fs.writeFileSync(recordFile, starting);
const original = fs.statSync;
fs.statSync = (target, ...args) => {
  if (target === deniedProtocol) throw Object.assign(new Error("protocol probe denied"), { code: "EACCES" });
  return original(target, ...args);
};
syncBuiltinESMExports();
try {
  const lock = await locks.acquireSessionWriterLock(sessionFile, host);
  assert.equal(await lock.recoverPreviousWriter({ termGraceMs: 0 }), "failed");
  assert.ok(stopped.has(ids[1].pid), "the independently identified writer is still cleaned up");
  assert.ok(!stopped.has(ids[0].pid), "an unverified gate is not signalled");
  assert.equal(fs.readFileSync(recordFile, "utf8"), starting);
  const again = await locks.acquireSessionWriterLock(sessionFile, host);
  assert.ok(locks.isSessionWriterLock(again));
  await again.release();
} finally {
  fs.statSync = original;
  syncBuiltinESMExports();
}
