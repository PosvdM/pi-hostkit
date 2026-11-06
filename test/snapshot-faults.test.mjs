import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotRecords, stopSnapshot } from "../dist/snapshots.js";

const root = { pid: 100, startTime: "root", runId: "r", instanceId: "i" };
const row = (pid) => ({ pid, ppid: 100, pgid: pid, startTime: String(pid), zombie: false });

test("one descendant EPERM does not skip other descendants or the pi group", async () => {
  const denied = row(101), other = row(102);
  const live = new Map([[100, { ...root, pgid: 100, zombie: false }], [101, denied], [102, other]]);
  const sent = [];
  const records = new SnapshotRecords(root, {
    processInfo: (pid) => live.get(pid) ?? null,
    signalProcess: (id, signal, group) => {
      sent.push([id.pid, signal, group]);
      if (id.pid === denied.pid) throw Object.assign(new Error("EPERM injected"), { code: "EPERM" });
      live.delete(id.pid);
      return true;
    },
  });
  records.remember(denied);
  records.remember(other);
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.deepEqual(report.leftovers.map((r) => r.pid), [denied.pid]);
  assert.ok(report.steps.some((s) => !s.ok && s.detail?.includes("EPERM")));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(sent.some(([pid, , pgid]) => pid === root.pid && pgid === root.pid));
  assert.deepEqual(records.alive().map((r) => r.pid), [denied.pid]);
  assert.match(records.failures.join("\n"), /101: EPERM/);
});

test("failed exit queries remain in leftovers and do not block cleanup", async () => {
  const denied = row(101), other = row(102);
  const sent = [];
  const records = new SnapshotRecords(root, {
    processInfo: (pid) => {
      if (pid === denied.pid) throw new Error("query denied");
      return null;
    },
    signalProcess: (id) => { sent.push(id.pid); return true; },
  });
  records.remember(denied);
  records.remember(other);
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.deepEqual(report.leftovers.map((r) => r.pid), [denied.pid]);
  assert.ok(report.steps.some((s) => !s.ok && s.detail?.includes("query denied")));
  assert.ok(sent.includes(root.pid));
  assert.deepEqual(records.alive().map((r) => r.pid), [denied.pid]);
  assert.match(records.failures.join("\n"), /query denied/);
});
