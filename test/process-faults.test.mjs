import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const fixture of ["process-faults.mjs", "proctable-faults.mjs"]) {
  test(`${fixture}：隔离系统查询与信号故障测试`, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, [
      "--test", "--test-reporter=tap", "--experimental-test-module-mocks", fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)),
    ], { timeout: 30_000, encoding: "utf8", stdio: "pipe", env });
    assert.match(output, /# fail 0/);
  });
}
