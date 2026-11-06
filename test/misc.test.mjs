import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  assertLocalFilesystem,
  checkPrivate,
  ensurePrivateDir,
  filesystemInfo,
  isSupportedPiVersion,
  locatePi,
  writePrivateFile,
} from "../dist/index.js";
import { isWin, piInstall, tempDir } from "./helpers.mjs";

let root;
let cleanup;
before(async () => {
  ({ dir: root, cleanup } = await tempDir("hostkit-misc-"));
});
after(() => cleanup());

describe("secrets", () => {
  test("ensurePrivateDir creates and tightens; writePrivateFile is exclusive and private", async () => {
    const dir = path.join(root, "secret", "nested");
    await ensurePrivateDir(dir);
    assert.deepEqual(await checkPrivate(dir), { ok: true });
    if (!isWin) {
      chmodSync(dir, 0o755);
      assert.equal((await checkPrivate(dir)).ok, false);
      await ensurePrivateDir(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
    const file = path.join(dir, "host.key");
    await writePrivateFile(file, Buffer.from("secret"));
    assert.deepEqual(await checkPrivate(file), { ok: true });
    if (!isWin) assert.equal(statSync(file).mode & 0o777, 0o600);
    await assert.rejects(writePrivateFile(file, Buffer.from("again")), { code: "EEXIST" });
  });

  test("checkPrivate reports a readable file", async () => {
    const file = path.join(root, "open.txt");
    writeFileSync(file, "x");
    if (isWin) {
      // Default ACLs in the temp directory inherit from the parent.
      assert.equal((await checkPrivate(file)).ok, false);
    } else {
      chmodSync(file, 0o644);
      const check = await checkPrivate(file);
      assert.equal(check.ok, false);
      assert.match(check.problem, /wider than 600/);
    }
  });
});

describe("secrets: extra rules", () => {
  test("writePrivateFile refuses a parent directory that is not private", async () => {
    const dir = path.join(root, "public-parent");
    mkdirSync(dir, { recursive: true });
    if (!isWin) chmodSync(dir, 0o755);
    await assert.rejects(writePrivateFile(path.join(dir, "k"), Buffer.from("x")), { code: "EHOSTKIT_NOT_PRIVATE" });
  });

  test("macOS: an extended ACL makes a 0600 file not private; ensurePrivateDir removes it from the directory", { skip: process.platform !== "darwin" }, async () => {
    const dir = path.join(root, "acl");
    await ensurePrivateDir(dir);
    const file = path.join(dir, "k");
    await writePrivateFile(file, Buffer.from("x"));
    execFileSync("chmod", ["+a", "everyone allow read", file]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const check = await checkPrivate(file);
    assert.equal(check.ok, false);
    assert.match(check.problem, /extended ACL/);
    execFileSync("chmod", ["+a", "everyone allow list,search", dir]);
    assert.equal((await checkPrivate(dir)).ok, false);
    await ensurePrivateDir(dir);
    assert.deepEqual(await checkPrivate(dir), { ok: true });
  });
});

describe("local file system", () => {
  test("temp directory is local; missing paths use the nearest ancestor", () => {
    assert.equal(filesystemInfo(root).local, true);
    assert.equal(filesystemInfo(path.join(root, "missing", "deeper")).path, root);
    assertLocalFilesystem(path.join(root, "x"));
  });
});

describe("locatePi", () => {
  test("version range is >=1.5.0 <1.6.0 without prereleases", () => {
    for (const v of ["1.5.0", "1.5.9", "1.5.12"]) assert.equal(isSupportedPiVersion(v), true, v);
    for (const v of ["1.4.9", "1.6.0", "2.0.0", "1.5.0-rc.1", "1.5", ""]) assert.equal(isSupportedPiVersion(v), false, v);
  });

  test("piPath accepts the package directory or cli.js", async () => {
    const pi = await piInstall();
    assert.equal(pi.supported, true, `tests need pi 1.5.x, found ${pi.version}`);
    const byDir = await locatePi({ piPath: pi.packageDir });
    const byCli = await locatePi({ piPath: pi.cliEntry });
    assert.deepEqual(byDir, pi);
    assert.deepEqual(byCli, pi);
    assert.match(pi.cliEntry, /dist[\\/]bundle[\\/]cli\.js$/);
  });

  test("rejects a directory that is not the pi package", async () => {
    const dir = path.join(root, "not-pi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "other" }));
    await assert.rejects(locatePi({ piPath: dir }), { code: "EHOSTKIT_PI_NOT_FOUND" });
    await assert.rejects(locatePi({ piPath: path.join(root, "nope") }), { code: "EHOSTKIT_PI_NOT_FOUND" });
  });

  test("finds the global installation through npm root -g", { skip: !!process.env.PI_PACKAGE }, async () => {
    const pi = await locatePi();
    assert.equal(pi.supported, true);
  });
});
