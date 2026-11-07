import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { realPathOrPending } from "../dist/paths.js";

async function localfsFor({ statSync = fs.statSync, resolve = (p) => p, fsInfo }) {
  const key = `localfs-${Math.random()}`;
  globalThis[key] = { statSync, realPathOrPending: resolve, native: () => ({ fsInfo }) };
  try {
    const source = (await readFile(new URL("../dist/localfs.js", import.meta.url), "utf8"))
      .replace(/import \{ statSync \} from "node:fs";/, `const { statSync } = globalThis[${JSON.stringify(key)}];`)
      .replace(/import \{ native \} from "\.\/native.js";/, `const { native } = globalThis[${JSON.stringify(key)}];`)
      .replace(/import \{ realPathOrPending \} from "\.\/paths.js";/, `const { realPathOrPending } = globalThis[${JSON.stringify(key)}];`);
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}
const fault = (code) => Object.assign(new Error(`注入 ${code}`), { code });
const mount = path.resolve("virtual-mount");
const target = path.join(mount, "missing", "data");

test("localfs 只在 ENOENT 时上溯，并在远程挂载根停止", async () => {
  const queried = [];
  const mod = await localfsFor({
    statSync(p) { queried.push(p); if (p !== mount) throw fault("ENOENT"); },
    fsInfo(p) { assert.equal(p, mount); return { local: false, type: "nfs" }; },
  });
  assert.deepEqual(mod.filesystemInfo(target), { local: false, type: "nfs", path: mount });
  assert.deepEqual(queried, [target, path.dirname(target), mount]);
  assert.throws(() => mod.assertLocalFilesystem(target), { code: "EHOSTKIT_REMOTE_FS" });
});

test("localfs 查询失败不能跨挂载边界借用本地祖先", async () => {
  for (const code of ["EACCES", "EPERM", "EIO", "ENODEV", "ENOTDIR", "ELOOP"]) {
    const queried = [];
    const mod = await localfsFor({
      statSync(p) { queried.push(p); if (p === target) throw fault("ENOENT"); throw fault(code); },
      fsInfo() { assert.fail("未知路径不能查询本地祖先卷"); },
    });
    assert.throws(() => mod.filesystemInfo(target), { code });
    assert.deepEqual(queried, [target, path.dirname(target)]);
    assert.throws(() => mod.assertLocalFilesystem(target), { code });
  }
});

test("localfs 原生卷查询和真实路径查询失败原样传播", async () => {
  for (const code of ["EACCES", "EIO", "ENOTSUP"]) {
    const mod = await localfsFor({ statSync() {}, fsInfo() { throw fault(code); } });
    assert.throws(() => mod.assertLocalFilesystem(target), { code });
    const broken = await localfsFor({ resolve() { throw fault(code); }, fsInfo() { assert.fail(); } });
    assert.throws(() => broken.assertLocalFilesystem(target), { code });
  }
});

test("localfs 根目录缺失时失败，不推断卷类型", async () => {
  const mod = await localfsFor({ statSync() { throw fault("ENOENT"); }, fsInfo() { assert.fail(); } });
  assert.throws(() => mod.filesystemInfo(path.parse(target).root), { code: "ENOENT" });
});

test("localfs 悬空链接按实际写入目标查询，不按链接所在卷判断", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hostkit-localfs-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote");
  const local = path.join(dir, "local");
  await mkdir(remote);
  await mkdir(local);
  const link = path.join(local, "link");
  await symlink(path.join(remote, "pending"), link, process.platform === "win32" ? "junction" : "dir");
  const actual = realPathOrPending(remote);
  const mod = await localfsFor({ resolve: realPathOrPending, fsInfo(p) {
    assert.equal(p, actual);
    return { local: false, type: "nfs" };
  } });
  assert.throws(() => mod.assertLocalFilesystem(path.join(link, "data")), { code: "EHOSTKIT_REMOTE_FS" });
});
