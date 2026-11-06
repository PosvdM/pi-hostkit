import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  acquireInstanceLock,
  acquireSessionWriterLock,
  checkPrivate,
  comparisonKey,
  currentProcessIdentity,
  isSameProcess,
  isSessionWriterLock,
  probeSessionWriterLock,
  sessionLocksDir,
} from "../dist/index.js";
import { containment, here, isWin, piArgv, piFixture, tempDir, until } from "./helpers.mjs";

const FAST_STOP = { abortTimeoutMs: 2_000, graceMs: 1_000, termGraceMs: 1_000 };
let home;
const cleanups = [];
const children = new Set();

before(async () => {
  // Session locks live under the home directory; keep tests away from the real one.
  home = await tempDir("hostkit-home-");
  process.env.HOME = home.dir;
  process.env.USERPROFILE = home.dir;
  cleanups.push(home.cleanup);
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const host = (app = "pi-agora") => ({ app, identity: currentProcessIdentity("test-host") });

/** Starts test/fixtures/host.mjs and resolves with its first JSON line. */
function startHost(args, env = {}) {
  const child = spawn(process.execPath, [path.join(here, "fixtures", "host.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env, HOSTKIT_TEST_ARGS: JSON.stringify(args) },
  });
  children.add(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const first = new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0]));
    });
    child.once("exit", (code) => reject(new Error(`host exited with ${code} before reporting`)));
  });
  return {
    child,
    first,
    async kill() {
      child.kill("SIGKILL");
      await exited;
      children.delete(child);
    },
  };
}

function recordPath(sessionFile) {
  const key = createHash("sha256").update(comparisonKey(sessionFile)).digest("hex");
  return path.join(sessionLocksDir(), `session-${key}.json`);
}

describe("instance lock", () => {
  test("second acquisition in the same process is refused until release", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const a = await acquireInstanceLock("daemon", dir);
    assert.ok(a);
    assert.equal(await acquireInstanceLock("daemon", dir), null);
    assert.ok(await acquireInstanceLock("other", dir), "different names are independent");
    await a.release();
    const b = await acquireInstanceLock("daemon", dir);
    assert.ok(b);
    await b.release();
  });

  test("a lock held by a killed process is released by the OS", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const holder = startHost({ action: "instance-lock", name: "daemon", dir });
    assert.deepEqual(await holder.first, { held: true });
    assert.equal(await acquireInstanceLock("daemon", dir), null);
    const contender = startHost({ action: "instance-lock", name: "daemon", dir });
    assert.deepEqual(await contender.first, { held: false });
    await contender.kill();
    await holder.kill();
    const lock = await until(() => acquireInstanceLock("daemon", dir), 5_000);
    await lock.release();
  });

  test("rejects names that are not plain file names", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    await assert.rejects(acquireInstanceLock("../x", dir), { code: "EINVAL" });
  });
});

describe("session writer lock", () => {
  test("acquire, record, busy result and release", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("a");
    const lock = await acquireSessionWriterLock(sessionFile, host());
    assert.ok(isSessionWriterLock(lock));
    assert.equal(lock.previous, undefined);
    assert.equal(await lock.recoverPreviousWriter(), "none");
    const me = currentProcessIdentity("x");
    await lock.update({ writer: { ...me, runId: "r1" }, state: "running" });
    const record = JSON.parse(readFileSync(recordPath(lock.sessionFile), "utf8"));
    assert.equal(record.state, "running");
    assert.equal(record.writer.runId, "r1");
    assert.equal(record.host.app, "pi-agora");
    assert.equal(record.sessionFile, lock.sessionFile);

    const busy = await acquireSessionWriterLock(sessionFile, host("pi-pane"));
    assert.equal(isSessionWriterLock(busy), false);
    assert.equal(busy.heldBy.state, "running");
    assert.equal((await probeSessionWriterLock(sessionFile)).held, true);

    await lock.release();
    const probe = await probeSessionWriterLock(sessionFile);
    assert.equal(probe.held, false);
    assert.equal(probe.record.state, "released");
    if (!isWin) assert.equal((await checkPrivate(sessionLocksDir())).ok, true);
  });

  test("update before recoverPreviousWriter is refused", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const lock = await acquireSessionWriterLock(f.sessionPath("b"), host());
    await assert.rejects(lock.update({ state: "running" }), { code: "EHOSTKIT_LOCK_STATE" });
    await lock.release();
  });

  test("paths that name the same file share one lock", { skip: process.platform !== "darwin" }, async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const lock = await acquireSessionWriterLock(f.sessionPath("Case"), host());
    const other = await acquireSessionWriterLock(f.sessionPath("case"), host());
    assert.equal(isSessionWriterLock(other), false);
    await lock.release();
  });

  test("next host stops the writer left by a killed host (pane -> agora)", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("cross");
    const pane = startHost(
      { action: "session-host", app: "pi-pane", sessionFile, argv: await piArgv(["--session", sessionFile]), cwd: f.cwd, env: f.env, containment, runId: "pane-run", instanceId: "pane" },
      { HOME: home.dir, USERPROFILE: home.dir },
    );
    const { result, identity } = await pane.first;
    assert.equal(result, "none");
    assert.equal(await isSameProcess(identity), "alive");
    assert.equal(isSessionWriterLock(await acquireSessionWriterLock(sessionFile, host())), false);
    await pane.kill();

    const lock = await until(async () => {
      const l = await acquireSessionWriterLock(sessionFile, host());
      return isSessionWriterLock(l) ? l : null;
    }, 5_000);
    assert.equal(lock.previous.host.app, "pi-pane");
    assert.equal(lock.previous.state, "running");
    assert.equal(lock.previous.writer.pid, identity.pid);
    const recovered = await lock.recoverPreviousWriter(FAST_STOP);
    // Windows: the pane's Job Object ends pi when the pane dies, possibly a moment after the mutex is abandoned.
    if (isWin) assert.ok(recovered === "none" || recovered === "stopped", recovered);
    else assert.equal(recovered, "stopped");
    assert.equal(await isSameProcess(identity), "gone");
    const record = JSON.parse(readFileSync(recordPath(lock.sessionFile), "utf8"));
    assert.equal(record.state, "starting");
    assert.equal(record.host.app, "pi-agora");
    await lock.release();
  });

  /** Leaves a `starting` record without a writer, as a host that died right after spawning would. */
  async function leaveStartingRecord(sessionFile) {
    const first = await acquireSessionWriterLock(sessionFile, host("pi-agora"));
    await first.recoverPreviousWriter();
    const recordFile = recordPath(first.sessionFile);
    const saved = readFileSync(recordFile, "utf8");
    await first.release();
    writeFileSync(recordFile, saved);
    return recordFile;
  }

  async function acquireWhenFree(sessionFile, app) {
    return until(async () => {
      const l = await acquireSessionWriterLock(sessionFile, host(app));
      return isSessionWriterLock(l) ? l : null;
    }, 5_000);
  }

  test("a host killed while pi waits at the gate leaves no writer; recovery still fails closed", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("held");
    const agora = startHost(
      { action: "session-held", app: "pi-agora", sessionFile, argv: await piArgv(["--session", sessionFile]), cwd: f.cwd, env: f.env, containment, runId: "agora-run", instanceId: "agora" },
      { HOME: home.dir, USERPROFILE: home.dir },
    );
    const { identity } = await agora.first;
    await agora.kill();
    // The gate reads EOF when its host dies and exits without loading pi.
    await until(async () => (await isSameProcess(identity)) === "gone", 5_000);
    assert.equal(existsSync(sessionFile), false);
    const lock = await acquireWhenFree(sessionFile, "pi-pane");
    assert.equal(lock.previous.state, "starting");
    assert.equal(lock.previous.writer, undefined);
    assert.equal(await lock.recoverPreviousWriter(FAST_STOP), "failed");
    const again = await acquireWhenFree(sessionFile, "pi-pane");
    assert.equal(await again.recoverPreviousWriter({ assumeNoWriter: true }), "none");
    await again.release();
  });

  test("an unrecorded process still at the gate is found by its command line and stopped", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("orphan-gate");
    await leaveStartingRecord(sessionFile);
    // A gate whose stdin stays open (held by this test), so it does not exit on its own.
    const gate = spawn(process.execPath, [path.join(here, "..", "dist", "gate.js"), ...(await piArgv(["--session", sessionFile]))], {
      cwd: f.cwd,
      env: f.env,
      stdio: ["pipe", "ignore", "ignore"],
      detached: !isWin,
    });
    children.add(gate);
    await new Promise((resolve) => gate.once("spawn", resolve));
    const lock = await acquireWhenFree(sessionFile, "pi-pane");
    assert.equal(await lock.recoverPreviousWriter(FAST_STOP), "stopped");
    assert.equal(lock.recoveryReports.length, 1);
    await until(() => gate.exitCode !== null || gate.signalCode !== null, 5_000);
    await lock.release();
  });

  test("a released pi that was never recorded cannot be ruled out: fail closed", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("unrecorded");
    const rogue = startHost(
      { action: "session-unrecorded", app: "pi-agora", sessionFile, argv: await piArgv(["--session", sessionFile]), cwd: f.cwd, env: f.env, containment, runId: "rogue", instanceId: "rogue" },
      { HOME: home.dir, USERPROFILE: home.dir },
    );
    const { identity } = await rogue.first;
    await rogue.kill();
    const lock = await acquireWhenFree(sessionFile, "pi-pane");
    const result = await lock.recoverPreviousWriter(FAST_STOP);
    if (isWin) {
      // The Job Object ended pi with its host; nothing is found, which is still not proof.
      assert.equal(result, "failed");
    } else if (result === "failed") {
      // pi overwrote its command line with process.title: not findable, so recovery refuses.
      assert.equal(await isSameProcess(identity), "alive");
      const { stopByIdentity } = await import("../dist/index.js");
      await stopByIdentity(identity, FAST_STOP);
    } else {
      assert.equal(result, "stopped");
    }
    assert.equal(await isSameProcess(identity), "gone");
  });

  test("an undeterminable previous writer fails closed and keeps the record", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("unknown");
    const first = await acquireSessionWriterLock(sessionFile, host());
    await first.recoverPreviousWriter();
    await first.update({ state: "starting" }); // no writer recorded
    // Simulate the first host dying: drop the lock without writing "released".
    const recordFile = recordPath(first.sessionFile);
    const saved = readFileSync(recordFile, "utf8");
    await first.release();
    writeFileSync(recordFile, saved);

    const second = await acquireSessionWriterLock(sessionFile, host("pi-pane"));
    assert.equal(await second.recoverPreviousWriter(FAST_STOP), "failed");
    assert.equal(readFileSync(recordFile, "utf8"), saved, "the record must stay for the next attempt");
    assert.equal((await probeSessionWriterLock(sessionFile)).held, false, "failed recovery releases the lock");
    await assert.rejects(second.update({ state: "running" }), { code: "EHOSTKIT_LOCK_STATE" });

    const third = await acquireSessionWriterLock(sessionFile, host("pi-pane"));
    assert.equal(await third.recoverPreviousWriter({ assumeNoWriter: true }), "none");
    await third.release();
  });

  test("release during recovery wins: recovery cannot write or spawn afterwards", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("race");
    const lock = await acquireSessionWriterLock(sessionFile, host());
    const recovering = lock.recoverPreviousWriter();
    const releasing = lock.release();
    // Operations run in call order: recovery completes first, then release.
    assert.equal(await recovering, "none");
    await releasing;
    assert.equal(JSON.parse(readFileSync(recordPath(lock.sessionFile), "utf8")).state, "released");
    await assert.rejects(lock.spawnWriter({ argv: await piArgv(["--session", sessionFile]), cwd: f.cwd, env: f.env, runId: "r", instanceId: "i" }), {
      code: "EHOSTKIT_LOCK_STATE",
    });
    await assert.rejects(lock.update({ state: "running" }), { code: "EHOSTKIT_LOCK_STATE" });

    const second = await acquireSessionWriterLock(sessionFile, host());
    const released = second.release();
    await released;
    await assert.rejects(second.recoverPreviousWriter(), { code: "EHOSTKIT_LOCK_STATE" });
  });

  test("spawnWriter requires this lock's --session and one running writer at a time", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("single");
    const lock = await acquireSessionWriterLock(sessionFile, host());
    await lock.recoverPreviousWriter();
    const base = { cwd: f.cwd, env: f.env, containment, runId: "w", instanceId: "i" };
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv() }), { code: "EINVAL" });
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv(["--session", f.sessionPath("other")]) }), { code: "EINVAL" });
    // pi would continue another session: --session after -- is a message.
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv(["--continue", "--", "--session", sessionFile]) }), { code: "EINVAL" });
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv([`--session=${sessionFile}`]) }), { code: "EINVAL" });
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv(["--session", sessionFile, "--continue"]) }), { code: "EINVAL" });
    const writer = await lock.spawnWriter({ ...base, argv: await piArgv(["--session", sessionFile]) });
    await assert.rejects(lock.spawnWriter({ ...base, argv: await piArgv(["--session", sessionFile]) }), { code: "EHOSTKIT_LOCK_STATE" });
    await writer.stop(FAST_STOP);
    await lock.release();
  });

  test("gates for other sessions or with relative --session are not stopped; recovery fails closed", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("prefix");
    await leaveStartingRecord(sessionFile);
    const startGate = async (sessionArg) => {
      const gate = spawn(process.execPath, [path.join(here, "..", "dist", "gate.js"), ...(await piArgv(["--session", sessionArg]))], {
        cwd: f.cwd,
        env: f.env,
        stdio: ["pipe", "ignore", "ignore"],
        detached: !isWin,
      });
      children.add(gate);
      await new Promise((resolve) => gate.once("spawn", resolve));
      return gate;
    };
    const startGateArgs = async (extra) => {
      const gate = spawn(process.execPath, [path.join(here, "..", "dist", "gate.js"), ...(await piArgv(extra))], {
        cwd: f.cwd,
        env: f.env,
        stdio: ["pipe", "ignore", "ignore"],
        detached: !isWin,
      });
      children.add(gate);
      await new Promise((resolve) => gate.once("spawn", resolve));
      return gate;
    };
    const other = await startGate(`${sessionFile}.bak`);
    // Not a writer of this file by pi's rules: the --session after -- is a message.
    const afterDashes = await startGateArgs(["--continue", "--", "--session", sessionFile]);
    const lock = await acquireWhenFree(sessionFile, "pi-pane");
    assert.equal(await lock.recoverPreviousWriter(FAST_STOP), "failed");
    assert.equal(lock.recoveryReports.length, 0);
    assert.equal(other.exitCode, null, "a gate for a.jsonl.bak must not be stopped");
    assert.equal(afterDashes.exitCode, null, "a gate whose --session is only a message must not be stopped");

    const relative = await startGate(path.basename(sessionFile));
    const again = await acquireWhenFree(sessionFile, "pi-pane");
    assert.equal(await again.recoverPreviousWriter(FAST_STOP), "failed");
    assert.equal(relative.exitCode, null);
    other.kill("SIGKILL");
    afterDashes.kill("SIGKILL");
    relative.kill("SIGKILL");
  });

  test("a record with valid JSON but invalid content fails closed", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("semantic");
    const first = await acquireSessionWriterLock(sessionFile, host());
    const recordFile = recordPath(first.sessionFile);
    await first.release();
    const bad = JSON.stringify({ version: 1, state: "running", writer: {} });
    writeFileSync(recordFile, bad);
    const lock = await acquireSessionWriterLock(sessionFile, host());
    assert.equal(await lock.recoverPreviousWriter(), "failed");
    assert.equal(readFileSync(recordFile, "utf8"), bad);
  });

  test("a corrupt record fails closed", async () => {
    const f = await piFixture();
    cleanups.push(f.cleanup);
    const sessionFile = f.sessionPath("corrupt");
    const first = await acquireSessionWriterLock(sessionFile, host());
    const recordFile = recordPath(first.sessionFile);
    await first.release();
    writeFileSync(recordFile, "{not json");
    const lock = await acquireSessionWriterLock(sessionFile, host());
    assert.equal(await lock.recoverPreviousWriter(), "failed");
    assert.ok(existsSync(recordFile));
  });
});
