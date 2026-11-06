// Module mocking is confined to this explicitly opted-in test subprocess.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import * as processes from "../../dist/process.js";

mock.module(new URL("../../dist/process.js", import.meta.url), {
  namedExports: {
    ...processes,
    isSameProcess: async () => { throw new Error("injected process query failure"); },
  },
});
const locks = await import("../../dist/locks.js");
const host = { app: "pi-pane", identity: processes.currentProcessIdentity("fault-test") };
const lock = await locks.acquireSessionWriterLock(path.join(process.env.HOSTKIT_TEST_ROOT, "query.jsonl"), host);
await lock.recoverPreviousWriter();
await lock.update({ writer: host.identity, state: "running" });
const recordFile = path.join(locks.sessionLocksDir(), readdirSync(locks.sessionLocksDir()).find((f) => f.endsWith(".json")));
const before = readFileSync(recordFile, "utf8");
await assert.rejects(lock.release(), { code: "EHOSTKIT_LOCK_STATE" });
assert.equal(readFileSync(recordFile, "utf8"), before);
assert.equal((await locks.probeSessionWriterLock(lock.sessionFile)).held, true);
await lock.release({ writerSwitchedAway: true });
assert.equal((await locks.probeSessionWriterLock(lock.sessionFile)).held, false);
