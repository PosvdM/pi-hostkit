import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GATE_RELEASE_LINE } from "../dist/gate-protocol.js";

for (const code of ["EAGAIN", "EOF", "EPIPE", "EIO", "EACCES"]) {
  test(`gate 的 readSync 注入 ${code}：只重试暂不可读，其余拒绝加载`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hostkit-gate-fault-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "loaded.json");
    const source = (await readFile(new URL("../dist/gate.js", import.meta.url), "utf8"))
      .replace('import { readSync } from "node:fs";', `
        import { readSync as actualRead } from "node:fs";
        let injected = false;
        function readSync(...args) {
          if (!injected) { injected = true; throw Object.assign(new Error('注入读取失败'), { code: ${JSON.stringify(code)} }); }
          return actualRead(...args);
        }
      `);
    const gate = path.join(root, "gate.mjs");
    await writeFile(gate, source);
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await copyFile(new URL("../dist/gate-protocol.js", import.meta.url), path.join(root, "gate-protocol.js"));
    const entry = fileURLToPath(new URL("./fixtures/marker-entry.mjs", import.meta.url));
    const result = await new Promise((resolve) => {
      const child = execFile(process.execPath, [gate, entry], { timeout: 10_000, env: { ...process.env, MARKER_FILE: marker } },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(`${GATE_RELEASE_LINE}\nnext\n`);
    });
    assert.equal(result.error?.code ?? 0, code === "EAGAIN" ? 0 : 75, result.stderr);
    assert.equal(existsSync(marker), code === "EAGAIN");
  });
}
