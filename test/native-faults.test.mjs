import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFaultBinding } from "./fixtures/native-fault-build.mjs";

test("原生系统边界故障注入：专用构建、逐项报告与资源回收", { timeout: 180_000 }, (t) => {
  const built = buildFaultBinding();
  try {
    const env = { ...process.env, HOSTKIT_TEST_NATIVE_ADDON: built.addonPath };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ["--test", fileURLToPath(new URL("./fixtures/native-fault-worker.mjs", import.meta.url))], {
      timeout: 60_000, encoding: "utf8", windowsHide: true, env,
    });
    t.diagnostic(output);
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  } finally {
    built.cleanup();
  }
});
