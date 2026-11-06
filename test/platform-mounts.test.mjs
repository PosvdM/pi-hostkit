import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalPathSync, comparisonKey, isWithin } from "../dist/paths.js";
import { assertLocalFilesystem, filesystemInfo } from "../dist/localfs.js";

const sensitive = process.env.HOSTKIT_TEST_APFS;
const remote = process.env.HOSTKIT_TEST_REMOTE;
if (process.env.CI && process.platform === "darwin") assert.ok(sensitive, "macOS CI 必须提供真实敏感 APFS 测试卷");
if (process.env.HOSTKIT_TEST_REQUIRE_CGROUP === "1" && process.platform === "linux") {
  assert.ok(remote, "Linux auto CI 必须提供真实 SSHFS 测试卷");
}

test("真实大小写敏感 APFS 拒绝路径比较和会话锁", { skip: !sensitive && "需要 CI 创建 APFSX 磁盘映像" }, async (t) => {
  assert.equal(process.platform, "darwin");
  const root = await mkdtemp(path.join(sensitive, "hostkit-case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Probe"), "A");
  await writeFile(path.join(root, "probe"), "B");
  assert.equal(await readFile(path.join(root, "Probe"), "utf8"), "A", "测试卷必须真实区分大小写");
  assert.equal(await readFile(path.join(root, "probe"), "utf8"), "B");
  assert.throws(() => comparisonKey(root), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  assert.throws(() => canonicalPathSync("pending/session.jsonl", root, "write"), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  assert.throws(() => isWithin(tmpdir(), root), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  const home = await mkdtemp(path.join(tmpdir(), "hostkit-apfs-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { acquireSessionWriterLock, currentProcessIdentity } from './dist/index.js';
    await assert.rejects(acquireSessionWriterLock(process.env.HOSTKIT_TEST_SESSION,
      { app: 'pi-agora', identity: currentProcessIdentity('apfs') }),
      { code: 'EHOSTKIT_CASE_SENSITIVE_FS' });
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url), timeout: 15_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, HOSTKIT_TEST_SESSION: path.join(root, "session.jsonl") },
  });
});

test("真实 SSHFS 远程挂载被拒绝，权限查询失败不借用本地祖先", { skip: !remote && "需要 CI 的本机 SSHFS 远程挂载" }, async (t) => {
  assert.equal(process.platform, "linux");
  assert.equal(filesystemInfo(remote).local, false);
  assert.throws(() => assertLocalFilesystem(path.join(remote, "new", "data")), { code: "EHOSTKIT_REMOTE_FS" });
  const blocked = path.join(remote, "blocked");
  await mkdir(blocked);
  await writeFile(path.join(blocked, "exists"), "secret");
  t.after(async () => { await chmod(blocked, 0o700); await rm(blocked, { recursive: true, force: true }); });
  await chmod(blocked, 0);
  assert.throws(() => filesystemInfo(path.join(blocked, "exists")), { code: "EACCES" });
  assert.throws(() => assertLocalFilesystem(path.join(blocked, "missing", "data")), { code: "EACCES" });
});
