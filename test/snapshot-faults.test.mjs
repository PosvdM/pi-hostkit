import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotRecords, stopSnapshot } from "../dist/snapshots.js";
import { verifiedDescendants } from "../dist/proctable.js";

const root = { pid: 100, startTime: "root", runId: "r", instanceId: "i" };

test("a failed parent query keeps independently verified snapshot branches and reports the failure", async () => {
  const pi = { ...root, startTime: "1", pgid: 100, ppid: 1, zombie: false };
  const denied = { pid: 101, ppid: 100, pgid: 101, startTime: "2", zombie: false };
  const deniedChild = { pid: 103, ppid: 101, pgid: 103, startTime: "3", zombie: false };
  const good = { pid: 102, ppid: 100, pgid: 102, startTime: "2", zombie: false };
  const goodChild = { pid: 104, ppid: 102, pgid: 104, startTime: "3", zombie: false };
  const table = [pi, denied, deniedChild, good, goodChild];
  const live = new Map(table.map((r) => [r.pid, r]));
  let capturing = true;
  const signalled = [];
  const records = new SnapshotRecords(pi, {
    listProcesses: () => table,
    verifiedDescendants,
    processInfo: (pid) => {
      if (capturing && pid === denied.pid) throw new Error("parent identity query failed");
      return live.get(pid) ?? null;
    },
    signalProcess: (id) => { signalled.push(id.pid); live.delete(id.pid); return true; },
  });
  records.capture();
  assert.ok(records.records.has("102:2"));
  assert.ok(records.records.has("104:3"));
  assert.ok(!records.records.has("103:3"), "a child attributed through the unverified parent is excluded");
  capturing = false;
  live.delete(pi.pid); // pi exits after the only snapshot; recorded escaped children remain reachable.
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.ok(signalled.includes(goodChild.pid));
  assert.ok(report.steps.some((s) => s.step === "snapshot" && !s.ok && s.detail.includes("parent identity query failed")));
  assert.deepEqual(report.leftovers, []);
});

test("a failed final snapshot is reported even without any earlier descendant records", async () => {
  const records = new SnapshotRecords(root, {
    listProcesses: () => { throw new Error("last snapshot denied"); },
    processInfo: () => null,
    signalProcess: () => false,
    verifiedDescendants,
  });
  records.capture();
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.deepEqual(report.leftovers, []);
  assert.ok(report.steps.some((s) => s.step === "snapshot" && !s.ok && s.detail.includes("last snapshot denied")));
});
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
