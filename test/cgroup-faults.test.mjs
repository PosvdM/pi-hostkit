import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { stopCgroup } from "../dist/cgroups.js";

const dir = "/sys/fs/cgroup/pi-hostkit-faults-deadbeef.scope";
const root = { pid: 100, startTime: "root", runId: "r", instanceId: "i" };
const row = (pid) => ({ pid, ppid: 100, startTime: String(pid), zombie: false });
const fault = (code, message = `${code} injected`) => Object.assign(new Error(message), { code });
const once = async (empty) => empty();
const inReport = (report, pid) => report.leftovers.find((entry) => entry.pid === pid);
const scopePath = dir.slice("/sys/fs/cgroup".length);

function fixture(rows = []) {
  const live = new Map([[root.pid, { ...root, ppid: 1, zombie: false }], ...rows.map((entry) => [entry.pid, entry])]);
  const members = new Set(live.keys());
  const sent = [];
  const ops = {
    readFile: (file) => {
      if (file === path.join(dir, "cgroup.events")) return `populated ${[...members].some((pid) => live.has(pid)) ? 1 : 0}\n`;
      if (file === path.join(dir, "cgroup.procs")) return [...members].filter((pid) => live.has(pid)).join("\n");
      if (/^\/proc\/\d+\/cgroup$/.test(file)) return `0::${scopePath}\n`;
      throw fault("ENOENT", `unexpected read ${file}`);
    },
    writeFile: () => {},
    readDirectories: () => [],
    exists: () => true,
    processInfo: (pid) => live.get(pid) ?? null,
    signalProcess: (id, signal) => {
      sent.push([id.pid, signal, id.startTime]);
      const current = ops.processInfo(id.pid);
      if (!current || current.zombie || current.startTime !== id.startTime) return false;
      live.delete(id.pid);
      return true;
    },
  };
  return { live, members, sent, ops };
}

function oldKernel(ops, code = "ENOENT") {
  ops.writeFile = () => { throw fault(code, `${code}: cgroup.kill unavailable`); };
}

test("cgroup fallback EPERM does not skip other PIDs or the independent pi kill", async () => {
  const denied = row(101), other = row(102);
  const { ops, sent } = fixture([denied, other]);
  oldKernel(ops);
  const signal = ops.signalProcess;
  ops.signalProcess = (id, sig) => {
    if (id.pid === denied.pid) {
      sent.push([id.pid, sig, id.startTime]);
      throw fault("EPERM");
    }
    return signal(id, sig);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.equal(report.coverage, "cgroup");
  assert.deepEqual(report.leftovers, [{ pid: denied.pid, startTime: denied.startTime }]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("101: EPERM")));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(sent.filter(([pid]) => pid === root.pid).length >= 2, "pi gets an independent attempt after fallback");
});

test("cgroup fallback query failure keeps an unknown PID and continues other PIDs and pi", async () => {
  const denied = row(101), other = row(102);
  const { ops, sent } = fixture([denied, other]);
  oldKernel(ops);
  const query = ops.processInfo;
  ops.processInfo = (pid) => {
    if (pid === denied.pid) throw fault("EACCES", "query denied");
    return query(pid);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, [{ pid: denied.pid, startTime: "" }]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("query denied")));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(sent.some(([pid]) => pid === root.pid));
});

test("cgroup fallback retains a known identity when later PID queries fail", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  oldKernel(ops);
  const query = ops.processInfo;
  let reads = 0;
  ops.processInfo = (pid) => {
    if (pid === child.pid && ++reads > 1) throw fault("EIO", "later identity query failed");
    return query(pid);
  };
  // The first identity was recorded before signalProcess rechecks it.
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, [{ pid: child.pid, startTime: child.startTime }]);
  assert.ok(sent.some(([pid]) => pid === root.pid));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("later identity query failed")));
});

test("a final readdir failure preserves readable PIDs and adds the unknown scope sentinel", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  ops.readDirectories = () => { throw fault("EIO", "final readdir failed"); };
  const report = await stopCgroup(dir, root, once, ops);
  assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
  assert.deepEqual(inReport(report, 0), { pid: 0, startTime: "", exe: `cgroup ${dir}` });
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("final readdir failed")));
  assert.ok(sent.some(([pid]) => pid === root.pid));
});

test("a final cgroup.procs failure returns a scope sentinel instead of rejecting", async () => {
  const { ops, sent } = fixture([row(101)]);
  const read = ops.readFile;
  ops.readFile = (file) => {
    if (file === path.join(dir, "cgroup.procs")) throw fault("EIO", "final procs failed");
    return read(file);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, [{ pid: 0, startTime: "", exe: `cgroup ${dir}` }]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("final procs failed")));
  assert.ok(sent.some(([pid]) => pid === root.pid));
});

test("a final processInfo failure keeps the listed unknown PID instead of treating it as gone", async () => {
  const child = row(101);
  const { ops } = fixture([child]);
  const query = ops.processInfo;
  ops.processInfo = (pid) => {
    if (pid === child.pid) throw fault("EIO", "final identity query failed");
    return query(pid);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, [{ pid: child.pid, startTime: "" }]);
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("final identity query failed")));
});

test("an incomplete final listing retains fallback identities and the scope sentinel together", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  oldKernel(ops);
  const read = ops.readFile;
  const signal = ops.signalProcess;
  let final = false;
  ops.signalProcess = (id, sig) => {
    if (id.pid === child.pid) {
      sent.push([id.pid, sig, id.startTime]);
      throw fault("EPERM");
    }
    return signal(id, sig);
  };
  ops.readFile = (file) => {
    if (final && file === path.join(dir, "cgroup.procs")) throw fault("EIO", "late listing failed");
    return read(file);
  };
  const report = await stopCgroup(dir, root, async (empty) => { final = true; return empty(); }, ops);
  assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
  assert.ok(inReport(report, 0));
  assert.equal(report.leftovers.length, 2);
});

test("partial child-scope reads retain successful PIDs and continue other subtrees", async () => {
  const unreadable = path.join(dir, "a-unreadable");
  const belowUnreadable = path.join(unreadable, "readable-child");
  const sibling = path.join(dir, "z-readable");
  const hidden = row(101), nested = row(102), other = row(103);
  const { ops, sent } = fixture([hidden, nested, other]);
  oldKernel(ops);
  const read = ops.readFile;
  const visited = [];
  ops.readDirectories = (current) => {
    visited.push(current);
    if (current === dir) return ["z-readable", "a-unreadable"];
    if (current === unreadable) return ["readable-child"];
    return [];
  };
  ops.readFile = (file) => {
    if (file === path.join(dir, "cgroup.procs")) return "100\n";
    if (file === path.join(unreadable, "cgroup.procs")) throw fault("EACCES", "child procs denied");
    if (file === path.join(belowUnreadable, "cgroup.procs")) return "102\n";
    if (file === path.join(sibling, "cgroup.procs")) return "103\n";
    return read(file);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.ok(visited.includes(sibling));
  assert.ok(visited.includes(belowUnreadable));
  assert.ok(sent.some(([pid]) => pid === nested.pid));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(inReport(report, 0), "the unreadable subtree must not look empty");
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("child procs denied")));
});

test("a child readdir failure keeps its own PIDs and continues sibling cleanup", async () => {
  const bad = path.join(dir, "a-bad");
  const good = path.join(dir, "z-good");
  const denied = row(101), other = row(102);
  const { ops, sent } = fixture([denied, other]);
  oldKernel(ops);
  const read = ops.readFile;
  const signal = ops.signalProcess;
  ops.readFile = (file) => {
    if (file === path.join(dir, "cgroup.procs")) return "100\n";
    if (file === path.join(bad, "cgroup.procs")) return "101\n";
    if (file === path.join(good, "cgroup.procs")) return "102\n";
    return read(file);
  };
  ops.readDirectories = (current) => {
    if (current === dir) return ["z-good", "a-bad"];
    if (current === bad) throw fault("EACCES", "child readdir denied");
    return [];
  };
  ops.signalProcess = (id, sig) => {
    if (id.pid === denied.pid) { sent.push([id.pid, sig, id.startTime]); throw fault("EPERM"); }
    return signal(id, sig);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.equal(inReport(report, denied.pid)?.startTime, denied.startTime);
  assert.ok(inReport(report, 0));
  assert.ok(sent.some(([pid]) => pid === other.pid));
});

test("population and listing failures cannot skip pi even when pi's query also fails", async () => {
  const { ops, sent } = fixture();
  const read = ops.readFile;
  ops.readFile = (file) => {
    if (file === path.join(dir, "cgroup.events")) throw fault("EIO", "population failed");
    if (file === path.join(dir, "cgroup.procs")) throw fault("EACCES", "listing failed");
    return read(file);
  };
  ops.readDirectories = () => { throw fault("EIO", "readdir failed"); };
  ops.processInfo = () => { throw fault("EIO", "pi query failed"); };
  const report = await stopCgroup(dir, root, once, ops);
  assert.ok(sent.some(([pid, signal, startTime]) => pid === root.pid && signal === "SIGKILL" && startTime === root.startTime));
  assert.equal(inReport(report, root.pid)?.startTime, root.startTime);
  assert.ok(inReport(report, 0));
  for (const message of ["population failed", "listing failed", "readdir failed", "pi query failed"]) {
    assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes(message)), message);
  }
});

test("a confirmed empty scope clears scope leftovers but still verifies pi independently", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  oldKernel(ops);
  const signal = ops.signalProcess;
  const read = ops.readFile;
  let empty = false;
  ops.signalProcess = (id, sig) => {
    if (id.pid === child.pid || id.pid === root.pid) {
      sent.push([id.pid, sig, id.startTime]);
      throw fault("EPERM");
    }
    return signal(id, sig);
  };
  ops.readFile = (file) => {
    if (empty && file === path.join(dir, "cgroup.events")) return "populated 0\n";
    return read(file);
  };
  const report = await stopCgroup(dir, root, async (check) => { empty = true; return check(); }, ops);
  assert.deepEqual(report.leftovers, [{ pid: root.pid, startTime: root.startTime }]);
  assert.ok(sent.filter(([pid]) => pid === root.pid).length >= 2);
});

test("pi outside an already empty scope still receives an identity-checked SIGKILL", async () => {
  const { ops, members, sent } = fixture();
  members.clear();
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, []);
  assert.deepEqual(sent, [[root.pid, "SIGKILL", root.startTime]]);
});

test("a reused pi PID is never killed by the independent root fallback", async () => {
  const { ops, live, members, sent } = fixture();
  members.clear();
  live.set(root.pid, { ...row(root.pid), startTime: "replacement" });
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, []);
  assert.equal(live.get(root.pid)?.startTime, "replacement");
  assert.deepEqual(sent, [[root.pid, "SIGKILL", root.startTime]]);
});

test("cgroup fallback is bounded to five rounds when population never clears", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  oldKernel(ops, "EPERM");
  ops.signalProcess = (id, sig) => { sent.push([id.pid, sig, id.startTime]); return false; };
  const report = await stopCgroup(dir, root, once, ops);
  assert.equal(sent.filter(([pid]) => pid === child.pid).length, 5);
  assert.equal(sent.filter(([pid]) => pid === root.pid).length, 6);
  assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
  assert.equal(inReport(report, root.pid)?.startTime, root.startTime);
});

test("unexpected cgroup.kill errors and rejected settle waits become report data", async () => {
  const { ops, sent } = fixture([row(101)]);
  oldKernel(ops, "EIO");
  const report = await stopCgroup(dir, root, async () => { throw fault("EIO", "settle failed"); }, ops);
  assert.ok(sent.some(([pid]) => pid === root.pid));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("cgroup.kill unavailable")));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("settle failed")));
  assert.equal(inReport(report, 101)?.startTime, "101");
});

test("successful cgroup.kill does not enter the per-PID fallback", async () => {
  const { ops, live, sent } = fixture([row(101)]);
  ops.writeFile = (file, value) => {
    assert.equal(file, path.join(dir, "cgroup.kill"));
    assert.equal(value, "1");
    live.clear();
  };
  ops.readDirectories = () => { throw new Error("fallback or final listing must not run after confirmed empty"); };
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, []);
  assert.deepEqual(sent, [[root.pid, "SIGKILL", root.startTime]]);
  assert.ok(report.steps.some((step) => step.ok && step.detail === "cgroup.kill"));
  assert.ok(!report.steps.some((step) => step.step === "list cgroup"));
});

test("fallback membership query errors do not skip other PIDs or pi", async () => {
  const child = row(101), other = row(102);
  const { ops, sent } = fixture([child, other]);
  oldKernel(ops);
  const read = ops.readFile;
  ops.readFile = (file) => {
    if (file === `/proc/${child.pid}/cgroup`) throw fault("EACCES", "membership denied");
    return read(file);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, [{ pid: child.pid, startTime: child.startTime }]);
  assert.ok(!sent.some(([pid]) => pid === child.pid));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(sent.some(([pid]) => pid === root.pid));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("membership denied")));
});

test("malformed populated data stays unknown without suppressing fallback or pi cleanup", async () => {
  const child = row(101), other = row(102);
  const { ops, sent } = fixture([child, other]);
  oldKernel(ops);
  const read = ops.readFile;
  const signal = ops.signalProcess;
  ops.readFile = (file) => file === path.join(dir, "cgroup.events") ? "invalid events\n" : read(file);
  ops.signalProcess = (id, sig) => {
    if (id.pid === child.pid) { sent.push([id.pid, sig, id.startTime]); throw fault("EPERM"); }
    return signal(id, sig);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
  assert.ok(inReport(report, 0));
  assert.ok(sent.some(([pid]) => pid === other.pid));
  assert.ok(sent.some(([pid]) => pid === root.pid));
  assert.equal(sent.filter(([pid]) => pid === child.pid).length, 5);
});

test("a removed scope does not suppress the independent pi kill", async () => {
  const { ops, sent } = fixture();
  oldKernel(ops);
  ops.exists = () => false;
  const report = await stopCgroup(dir, root, once, ops);
  assert.deepEqual(report.leftovers, []);
  assert.deepEqual(sent, [[root.pid, "SIGKILL", root.startTime]]);
  assert.ok(report.steps.some((step) => step.detail === "scope already removed"));
});

for (const code of ["ENOENT", "ENODEV"]) {
  test(`missing cgroup.events (${code}) in an existing scope retains known PIDs and a sentinel`, async () => {
    const child = row(101);
    const { ops, sent } = fixture([child]);
    oldKernel(ops);
    const read = ops.readFile;
    const signal = ops.signalProcess;
    let final = false;
    ops.readFile = (file) => {
      if (final && file === path.join(dir, "cgroup.events")) throw fault(code, "events missing in existing scope");
      return read(file);
    };
    ops.signalProcess = (id, sig) => {
      if (id.pid === child.pid) { sent.push([id.pid, sig, id.startTime]); throw fault("EPERM"); }
      return signal(id, sig);
    };
    const report = await stopCgroup(dir, root, async (empty) => { final = true; return empty(); }, ops);
    assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
    assert.ok(inReport(report, 0));
    assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("events missing in existing scope")));
    assert.ok(sent.some(([pid]) => pid === root.pid));
  });
}

test("missing cgroup.events with a failed existence query cannot confirm scope exit", async () => {
  const child = row(101);
  const { ops, sent } = fixture([child]);
  oldKernel(ops, "EINVAL");
  const read = ops.readFile;
  const signal = ops.signalProcess;
  let final = false;
  ops.exists = () => { throw fault("EIO", "directory query failed"); };
  ops.readFile = (file) => {
    if (final && file === path.join(dir, "cgroup.events")) throw fault("ENOENT", "events missing");
    return read(file);
  };
  ops.signalProcess = (id, sig) => {
    if (id.pid === child.pid) { sent.push([id.pid, sig, id.startTime]); throw fault("EPERM"); }
    return signal(id, sig);
  };
  const report = await stopCgroup(dir, root, async (empty) => { final = true; return empty(); }, ops);
  assert.equal(inReport(report, child.pid)?.startTime, child.startTime);
  assert.ok(inReport(report, 0));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("directory query failed")));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("events missing")));
});

test("missing cgroup.procs in an existing scope is incomplete enumeration", async () => {
  const { ops } = fixture([row(101)]);
  const read = ops.readFile;
  ops.readFile = (file) => {
    if (file === path.join(dir, "cgroup.procs")) throw fault("ENOENT", "missing procs in existing scope");
    return read(file);
  };
  const report = await stopCgroup(dir, root, once, ops);
  assert.ok(inReport(report, 0));
  assert.ok(report.steps.some((step) => !step.ok && step.detail?.includes("missing procs in existing scope")));
});
