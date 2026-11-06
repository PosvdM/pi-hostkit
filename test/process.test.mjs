import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  currentProcessIdentity,
  isSameProcess,
  linuxCgroupSupport,
  spawnManaged,
  stopByIdentity,
  GATE_REFUSED_EXIT_CODE,
} from "../dist/index.js";
import { containment, delay, here, isWin, pidExists, piArgv, piFixture, until, waitForEvent } from "./helpers.mjs";

const FAST_STOP = { abortTimeoutMs: 2_000, graceMs: 1_000, termGraceMs: 1_000 };
const fixtures = [];
after(async () => {
  for (const f of fixtures) await f.cleanup();
});

async function fixture(script) {
  const f = await piFixture(script);
  fixtures.push(f);
  return f;
}

function spec(f, extra = {}) {
  return { cwd: f.cwd, env: f.env, runId: `run-${Date.now()}`, instanceId: "test-instance", containment, ...extra };
}

/** Bash command that leaves a background process which escapes pi's own cleanup (new session). */
function escapingCommand(pidFile) {
  const target = pidFile.replaceAll("\\", "/");
  if (isWin) return `sleep 300 & echo $! > "${target}"; sleep 300`;
  // perl's setsid puts the sleeper in its own session and process group, out of pi's tracked tree.
  return `perl -e 'use POSIX; setsid(); open(F, ">", "${target}"); print F $$; close F; exec "sleep", "300"' & sleep 300`;
}

describe("spawnManaged", () => {
  test("starts pi and answers get_state", async () => {
    const f = await fixture();
    const proc = await spawnManaged({ argv: await piArgv(), ...spec(f) });
    try {
      assert.equal(proc.held, false);
      assert.equal(await isSameProcess(proc.identity), "alive");
      const state = await proc.rpc.send({ type: "get_state" }, { timeoutMs: 20_000 });
      assert.equal(state.success, true);
      const cgroup = containment === "auto" && (await linuxCgroupSupport());
      const expected = isWin ? "job_object" : cgroup ? "cgroup" : "snapshot_visible";
      assert.equal(proc.coverage, expected);
    } finally {
      const report = await proc.stop(FAST_STOP);
      assert.deepEqual(report.leftovers, []);
    }
    assert.equal(await isSameProcess(proc.identity), "gone");
  });

  test("held process does not load pi until release", async () => {
    const f = await fixture();
    const sessionFile = f.sessionPath("held");
    const proc = await spawnManaged({ argv: await piArgv(["--session", sessionFile]), ...spec(f), startHeld: true });
    try {
      assert.equal(proc.held, true);
      await assert.rejects(proc.rpc.send({ type: "get_state" }), /start gate/);
      await delay(500);
      assert.equal(existsSync(sessionFile), false, "pi must not touch the session before release");
      assert.equal(await isSameProcess(proc.identity), "alive");
      proc.release();
      const state = await proc.rpc.send({ type: "get_state" }, { timeoutMs: 20_000 });
      assert.equal(state.success, true);
      assert.equal(state.data.sessionFile, sessionFile);
    } finally {
      await proc.stop(FAST_STOP);
    }
  });

  test("stopping a held process makes the gate exit without loading pi", async () => {
    const f = await fixture();
    const proc = await spawnManaged({ argv: await piArgv(), ...spec(f), startHeld: true });
    const report = await proc.stop(FAST_STOP);
    const exit = await proc.exited;
    assert.deepEqual(report.leftovers, []);
    // Windows: the job may terminate the gate before it reads EOF.
    if (!isWin) assert.equal(exit.code, GATE_REFUSED_EXIT_CODE);
    assert.equal(report.steps[0].detail, "process held at the start gate");
  });

  test("stop removes a running bash tool and a background process that left pi's process group", async () => {
    const f = await fixture();
    const pidFile = path.join(f.root, "escaped.pid");
    await f.setScript({
      turns: [
        { segments: [{ type: "toolCall", name: "bash", arguments: { command: escapingCommand(pidFile) } }] },
        { segments: [{ type: "text", text: "done" }] },
      ],
    });
    const proc = await spawnManaged({ argv: await piArgv(), ...spec(f), snapshotIntervalMs: 200 });
    let escaped;
    try {
      const started = waitForEvent(proc.rpc, (e) => e.type === "tool_execution_start");
      const accepted = await proc.rpc.send({ type: "prompt", message: "run" }, { timeoutMs: 20_000 });
      assert.equal(accepted.success, true);
      await started;
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, 20_000);
      escaped = Number(readFileSync(pidFile, "utf8").trim());
      await delay(600); // at least two snapshots while the tool runs
    } finally {
      const report = await proc.stop(FAST_STOP);
      assert.deepEqual(report.leftovers, [], JSON.stringify(report, null, 2));
    }
    if (!isWin) await until(() => !pidExists(escaped), 3_000);
  });

  test("abort that times out still ends in a full stop", async () => {
    const f = await fixture({ turns: [{ ignoreAbort: true, segments: [{ type: "hang" }] }] });
    const proc = await spawnManaged({ argv: await piArgv(), ...spec(f) });
    const started = waitForEvent(proc.rpc, (e) => e.type === "message_start" || e.type === "turn_start");
    await proc.rpc.send({ type: "prompt", message: "hang" }, { timeoutMs: 20_000 });
    await started;
    const report = await proc.stop({ abortTimeoutMs: 300, graceMs: 300, termGraceMs: 300 });
    assert.equal(report.steps.find((s) => s.step === "abort").ok, false);
    assert.deepEqual(report.leftovers, []);
    assert.equal(await isSameProcess(proc.identity), "gone");
  });

  test("stop is idempotent", async () => {
    const f = await fixture();
    const proc = await spawnManaged({ argv: await piArgv(), ...spec(f) });
    const [a, b] = await Promise.all([proc.stop(FAST_STOP), proc.stop(FAST_STOP)]);
    assert.equal(a, b);
  });
});

test("a recorded cgroup path that is not a pi-hostkit scope is never killed", { skip: process.platform !== "linux" }, async () => {
  const me = currentProcessIdentity("test");
  const report = await stopByIdentity({ ...me, startTime: "0:0", cgroup: "/sys/fs/cgroup/user.slice" }, FAST_STOP);
  assert.equal(report.coverage, "snapshot_visible");
  assert.equal(await isSameProcess(me), "alive");
});

test("Linux CI provides cgroup v2 user scopes", { skip: !process.env.HOSTKIT_TEST_REQUIRE_CGROUP }, async () => {
  assert.ok(await linuxCgroupSupport(), "systemd-run --user --scope is not usable");
});

describe("process identity", () => {
  test("a recorded identity with a different start time is gone", async () => {
    const me = currentProcessIdentity("test");
    assert.equal(await isSameProcess(me), "alive");
    assert.equal(await isSameProcess({ ...me, startTime: `${me.startTime}0` }), "gone");
    assert.equal(await isSameProcess({ ...me, pid: 2 ** 30 }), "gone");
  });

  test("stopByIdentity refuses a mismatched start time and stops a pi left by a killed host", async () => {
    const f = await fixture();
    const host = spawn(process.execPath, [path.join(here, "fixtures", "host.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, HOSTKIT_TEST_ARGS: JSON.stringify({ action: "spawn", argv: await piArgv(), ...spec(f) }) },
    });
    const line = await new Promise((resolve, reject) => {
      let buf = "";
      host.stdout.on("data", (c) => {
        buf += c;
        if (buf.includes("\n")) resolve(buf.split("\n")[0]);
      });
      host.once("exit", (code) => reject(new Error(`host exited ${code}`)));
    });
    const { identity } = JSON.parse(line);
    host.kill("SIGKILL");
    await new Promise((resolve) => host.once("exit", resolve));
    if (isWin) {
      // The Job Object closes with the host and takes pi with it.
      await until(async () => (await isSameProcess(identity)) === "gone", 5_000);
      return;
    }
    assert.equal(await isSameProcess(identity), "alive");
    // Without the cgroup field: a recorded scope is killed as a whole by design.
    const wrong = await stopByIdentity({ ...identity, startTime: `${identity.startTime}9`, cgroup: undefined }, FAST_STOP);
    assert.equal(wrong.steps.find((s) => s.step === "identity").detail, "gone");
    assert.equal(await isSameProcess(identity), "alive", "a mismatched identity must not be signalled");
    const report = await stopByIdentity(identity, FAST_STOP);
    assert.deepEqual(report.leftovers, []);
    assert.equal(await isSameProcess(identity), "gone");
  });
});
