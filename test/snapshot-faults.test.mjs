import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotRecords, stopSnapshot } from "../dist/snapshots.js";
import { ProcessTableError, verifiedDescendants } from "../dist/proctable.js";

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

test("快照的部分进程表失败保留可读分支，错误必须写入报告", async () => {
  const pi = { ...root, startTime: "1", ppid: 1, pgid: 100, zombie: false };
  const child = { ...row(101), startTime: "2" };
  const live = new Map([[pi.pid, pi], [child.pid, child]]);
  const records = new SnapshotRecords(pi, {
    listProcesses: () => { throw new ProcessTableError([new Error("另一行不可读")], [pi, child]); },
    verifiedDescendants,
    processInfo: (pid) => live.get(pid) ?? null,
    signalProcess: (id) => { live.delete(id.pid); return true; },
  });
  records.capture();
  assert.ok(records.records.has("101:2"));
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.deepEqual(report.leftovers, []);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("另一行不可读")));
});

test("快照 settle 拒绝仍返回报告，并在最终查询继续保留未知身份", async () => {
  const child = row(101);
  const records = new SnapshotRecords(root, {
    processInfo: () => { throw new Error("退出状态未知"); },
    signalProcess: () => false,
  });
  records.remember(child);
  const report = await stopSnapshot(records, async () => { throw new Error("等待失败"); });
  assert.deepEqual(report.leftovers.map((entry) => entry.pid), [101, 100]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("等待失败")));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("退出状态未知")));
});

test("pi 组信号失败继续逐成员尝试并独立终止 pi 本身", async () => {
  const pi = { ...root, pgid: 100, zombie: false };
  const child = { ...row(101), pgid: 100 };
  const live = new Map([[100, pi], [101, child]]);
  const sent = [];
  const records = new SnapshotRecords(root, {
    processInfo: (pid) => live.get(pid) ?? null,
    signalProcess: (id, signal, group) => {
      sent.push([id.pid, group]);
      if (group !== undefined) throw new Error(`组失败 ${id.pid}`);
      live.delete(id.pid); return true;
    },
  });
  records.remember(child);
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.ok(sent.some(([pid, group]) => pid === 100 && group === undefined));
  assert.ok(sent.some(([pid, group]) => pid === 101 && group === 100));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("组失败 100")));
  assert.deepEqual(report.leftovers, []);
});

test("后代组信号失败仍尝试单进程；后代查询失败不影响其余目标", async () => {
  const first = row(101), denied = row(102), other = row(103);
  const live = new Map([[101, first], [102, denied], [103, other]]);
  const sent = [];
  const records = new SnapshotRecords(root, {
    processInfo: (pid) => { if (pid === 102) throw "身份字符串异常"; return live.get(pid) ?? null; },
    signalProcess: (id, signal, group) => {
      sent.push([id.pid, group]);
      if (group === 101) throw new Error("后代组失败");
      if (group === undefined) live.delete(id.pid);
      return true;
    },
  });
  for (const entry of [first, denied, other]) records.remember(entry);
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.ok(sent.some(([pid, group]) => pid === 101 && group === undefined));
  assert.ok(sent.some(([pid]) => pid === 103));
  assert.deepEqual(report.leftovers.map((entry) => entry.pid), [102]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("后代组失败")));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("身份字符串异常")));
});

test("快照根身份复查失败不记入不确定新行，已有记录不丢失", async () => {
  const pi = { ...root, startTime: "1", ppid: 1, zombie: false };
  const child = { ...row(101), startTime: "2" };
  const records = new SnapshotRecords(pi, {
    listProcesses: () => [pi, child], verifiedDescendants,
    processInfo: () => { throw new Error("根复查失败"); },
    signalProcess: () => false,
  });
  records.remember(row(102));
  records.capture();
  assert.equal(records.records.size, 1);
  const report = await stopSnapshot(records, async (empty) => empty());
  assert.deepEqual(report.leftovers.map((entry) => entry.pid), [102, 100]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("根复查失败")));
});
