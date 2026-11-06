import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

// Only the isolated test copy exposes a detector seam; the package exports stay unchanged.
async function pathsFor(platform, { detector, filesystem = fs } = {}) {
  const key = `hostkit-paths-test-${Math.random()}`;
  globalThis[key] = filesystem;
  try {
    const source = (await readFile(new URL("../dist/paths.js", import.meta.url), "utf8"))
      .replaceAll("process.platform", JSON.stringify(platform))
      .replace(/import \{([^}]+)\} from "node:fs";/, `const {$1} = globalThis[${JSON.stringify(key)}];`);
    const seam = "\nexport { detectCaseSensitivity as probeCaseSensitivity };\nexport function injectDetector(detector) { detectCaseSensitivity = detector; }\n";
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source + seam).toString("base64")}`);
    if (detector) mod.injectDetector(detector);
    return mod;
  } finally {
    delete globalThis[key];
  }
}

function probeFilesystem({ sensitive = false, entries = ["Probe"], childDevice = 10n, parentDevice = 20n, denied = false } = {}) {
  const dir = path.resolve("hostkit-case-volume");
  const parent = path.dirname(dir);
  const info = (dev, ino = 1n) => ({ dev, ino, isDirectory: () => true });
  return {
    dir,
    filesystem: {
      ...fs,
      realpathSync: Object.assign((p) => p, { native: (p) => p }),
      statSync(p) {
        if (p === dir) return info(10n);
        if (p === parent) return info(parentDevice);
        throw missing();
      },
      readdirSync(p) {
        assert.equal(p, dir, "the probe must not inspect the parent volume");
        if (denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return entries;
      },
      lstatSync(p) {
        const name = path.basename(p);
        if (entries.includes(name)) return info(childDevice, 30n);
        if (name === "probe" && !sensitive) return info(childDevice, 30n);
        throw missing();
      },
    },
  };
}

test("macOS keeps NFC/case folding only after an insensitive result", async () => {
  const seen = [];
  const paths = await pathsFor("darwin", { detector: (p) => { seen.push(p); return false; } });
  assert.equal(paths.comparisonKey("/Users/X/Caf\u00e9"), paths.comparisonKey("/users/x/cafe\u0301"));
  assert.equal(paths.isWithin("/Users/X", "/users/x/y"), true);
  assert.equal(paths.isWithin("/Users/X", "/users/xy"), false);
  assert.ok(seen.includes("/Users/X"));
  assert.ok(seen.includes("/users/x/y"));
});

test("macOS refuses sensitive, unknown, and failed detection for keys, roots, and sessions", async () => {
  for (const detector of [() => true, () => undefined, () => { throw new Error("probe failed"); }]) {
    const paths = await pathsFor("darwin", { detector });
    const expected = { code: "EHOSTKIT_CASE_SENSITIVE_FS" };
    assert.throws(() => paths.comparisonKey("/volume/session.jsonl"), expected);
    assert.throws(() => paths.isWithin("/volume/root", "/volume/root/file"), expected);
    assert.throws(() => paths.isAncestorOf("/volume/root", "/volume/root/file"), expected);
    assert.throws(() => paths.canonicalPathSync("new/session.jsonl", tmpdir(), "write"), expected);
    await assert.rejects(paths.canonicalPath("new/session.jsonl", tmpdir(), "read"), expected);
  }
});

test("macOS checks both comparison volumes, including an outside target", async () => {
  const paths = await pathsFor("darwin", { detector: (p) => p.startsWith("/sensitive") ? true : false });
  assert.throws(() => paths.isWithin("/safe/root", "/sensitive/session"), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  assert.throws(() => paths.isWithin("/sensitive/root", "/safe/session"), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
});

test("macOS checks the resolved symlink destination before returning a canonical path", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hostkit-case-link-")));
  try {
    const target = path.join(root, "sensitive");
    const link = path.join(root, "safe-link");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const seen = [];
    const paths = await pathsFor("darwin", { detector: (p) => { seen.push(p); return p.startsWith(target); } });
    assert.throws(() => paths.canonicalPathSync("safe-link/new/session.jsonl", root, "write"), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
    assert.deepEqual(seen, [path.join(target, "new", "session.jsonl")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows and Linux never invoke the macOS detector", async () => {
  const detector = () => { throw new Error("must not run"); };
  const linux = await pathsFor("linux", { detector });
  assert.notEqual(linux.comparisonKey("/x/A"), linux.comparisonKey("/x/a"));
  const windows = await pathsFor("win32", { detector });
  assert.equal(windows.comparisonKey("C:/X/A"), windows.comparisonKey("c:/x/a"));
});

test("read-only detection distinguishes aliases and uses the nearest existing ancestor", async () => {
  for (const sensitive of [true, false]) {
    const fixture = probeFilesystem({ sensitive });
    const paths = await pathsFor("darwin", fixture);
    assert.equal(paths.probeCaseSensitivity(path.join(fixture.dir, "missing", "session.jsonl")), sensitive);
  }
});

test("read-only detection cannot infer a mounted file's rules from its parent directory", async () => {
  const fixture = probeFilesystem();
  const file = path.join(fixture.dir, "mounted-file");
  const originalStat = fixture.filesystem.statSync;
  fixture.filesystem.statSync = (p) => p === file
    ? { dev: 99n, ino: 50n, isDirectory: () => false }
    : originalStat(p);
  const paths = await pathsFor("darwin", fixture);
  assert.equal(paths.probeCaseSensitivity(file), undefined);
  assert.throws(() => paths.comparisonKey(file), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
});

test("read-only detection fails closed at mount boundaries, hard-link aliases, and permission errors", async () => {
  for (const options of [{ entries: [] }, { entries: ["Probe", "probe"] }, { childDevice: 99n }, { denied: true }]) {
    const fixture = probeFilesystem(options);
    const paths = await pathsFor("darwin", fixture);
    assert.equal(paths.probeCaseSensitivity(fixture.dir), undefined);
    assert.throws(() => paths.comparisonKey(fixture.dir), { code: "EHOSTKIT_CASE_SENSITIVE_FS" });
  }
});

test("the paths entry works with native loading disabled and has no public injection API", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hostkit-paths-home-"));
  try {
    const script = `
      process.dlopen = () => { throw new Error("native loading forbidden"); };
      const paths = await import("pi-hostkit/paths");
      if ("injectDetector" in paths || "probeCaseSensitivity" in paths) throw new Error("public test seam");
      paths.comparisonKey(paths.canonicalPathSync("new/session.jsonl", process.env.HOME, "write"));
    `;
    await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 10_000,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
