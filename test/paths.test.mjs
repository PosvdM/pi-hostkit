import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  canonicalPath,
  canonicalPathSync,
  comparisonKey,
  isAncestorOf,
  isWithin,
  normalizeWindowsShellPath,
  environmentIndependentPathFor,
  resolveReadToolPath,
  resolveToolPath,
} from "../dist/paths.js";
import { isWin, piInstall, tempDir } from "./helpers.mjs";

let root;
let cleanup;
let pi; // pi's own (internal) path functions, for differential checks

before(async () => {
  ({ dir: root, cleanup } = await tempDir("hostkit-paths-"));
  const { packageDir } = await piInstall();
  const utils = await import(pathToFileURL(path.join(packageDir, "dist", "utils", "paths.js")).href);
  const tools = await import(pathToFileURL(path.join(packageDir, "dist", "core", "tools", "path-utils.js")).href);
  pi = { ...utils, ...tools };
});
after(() => cleanup());

const toolInputs = () => [
  "a.txt",
  "./dir/b.txt",
  "../up.txt",
  "dir/../c.txt",
  "@a.txt",
  "@@a.txt",
  "~",
  "~/notes.md",
  "@~/notes.md",
  "a\u00A0b.txt",
  "a\u2003b\u3000c.txt",
  "a\u202Fb.txt",
  " leading-space.txt",
  pathToFileURL(path.join(root, "via-url.txt")).href,
  path.join(root, "abs.txt"),
  "/c/Users/x.txt",
  "/mnt/d/data/y.txt",
  "/cygdrive/e/z.txt",
  "//server/share/x",
  "~\\win.txt",
];

describe("pi path rules (differential against pi 1.5.0 internals)", () => {
  test("resolveToolPath matches pi resolveToCwd", () => {
    for (const cwd of [root, path.join(root, "sub"), "~"]) {
      for (const input of toolInputs()) {
        assert.equal(resolveToolPath(input, cwd), pi.resolveToCwd(input, cwd), `input ${JSON.stringify(input)} cwd ${cwd}`);
      }
    }
  });

  test("resolveReadToolPath matches pi resolveReadPath for macOS screenshot, NFD and curly-quote names", () => {
    const dir = path.join(root, "read");
    mkdirSync(dir, { recursive: true });
    const files = [
      "Screenshot 2026-01-01 at 10.00.00\u202FAM.png",
      "Capture d\u2019\u00E9cran.png".normalize("NFD"),
      "plain.txt",
      "e\u0301.txt", // NFD on disk
    ];
    for (const name of files) writeFileSync(path.join(dir, name), "x");
    const inputs = [
      "Screenshot 2026-01-01 at 10.00.00 AM.png",
      "Capture d'\u00E9cran.png",
      "plain.txt",
      "\u00E9.txt",
      "missing.txt",
    ];
    for (const input of inputs) {
      assert.equal(resolveReadToolPath(input, dir), pi.resolveReadPath(input, dir), input);
    }
  });

  test("normalizeWindowsShellPath matches pi", () => {
    for (const input of ["/c/x", "/C", "/mnt/d/a/b", "/cygdrive/z/q", "/usr/bin", "//unc/x", "/c\\x", "c:/x", "/cc/x"]) {
      assert.equal(normalizeWindowsShellPath(input), pi.normalizeWindowsShellPath(input), input);
    }
  });
});

describe("canonicalPath", () => {
  test("resolves symbolic links and keeps missing components", async () => {
    const real = path.join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = path.join(root, "link");
    symlinkSync(real, link, isWin ? "junction" : "dir");
    assert.equal(await canonicalPath("link/new/deep.txt", root, "write"), path.join(real, "new", "deep.txt"));
    assert.equal(canonicalPathSync(path.join(link, "x"), root, "read"), path.join(real, "x"));
  });

  test("follows a dangling symbolic link to where a write would land", { skip: isWin }, () => {
    const target = path.join(root, "elsewhere", "file.txt");
    mkdirSync(path.dirname(target), { recursive: true });
    const dangling = path.join(root, "dangling.txt");
    symlinkSync(target, dangling);
    assert.equal(canonicalPathSync("dangling.txt", root, "write"), target);
  });

  test("detects link loops", { skip: isWin }, () => {
    const a = path.join(root, "loop-a");
    const b = path.join(root, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    assert.throws(() => canonicalPathSync("loop-a/x", root, "write"), (e) => e.code === "ELOOP");
  });

  test("applies pi's input rules before resolving", () => {
    mkdirSync(path.join(root, "rules"), { recursive: true });
    assert.equal(canonicalPathSync("@rules/a\u00A0b.txt", root, "write"), path.join(root, "rules", "a b.txt"));
  });
});

describe("environment-independent --session paths", () => {
  test("Windows: drive letters and complete UNC paths only", () => {
    const ok = {
      "C:\\s\\a.jsonl": "C:\\s\\a.jsonl",
      "c:/s/a.jsonl": "c:\\s\\a.jsonl",
      "\\\\srv\\share\\a.jsonl": "\\\\srv\\share\\a.jsonl",
      "//srv/share/a.jsonl": "\\\\srv\\share\\a.jsonl",
      "\\\\srv/share\\a.jsonl": "\\\\srv\\share\\a.jsonl",
    };
    for (const [input, expected] of Object.entries(ok)) {
      assert.equal(environmentIndependentPathFor(input, "win32"), expected, input);
    }
    const uncertain = [
      "\\\\a.jsonl", // no share: Node resolves it against the current drive
      "\\\\srv\\", // trailing separator, no share
      "//srv",
      "\\\\?\\C:\\a.jsonl",
      "\\\\.\\pipe\\x",
      "\\s\\a.jsonl", // current drive
      "/c/s/a.jsonl", // Git Bash form
      "C:a.jsonl", // drive-relative
      "~/a.jsonl",
      "a.jsonl",
    ];
    for (const input of uncertain) assert.equal(environmentIndependentPathFor(input, "win32"), undefined, input);
  });

  test("POSIX: paths starting with / only", () => {
    assert.equal(environmentIndependentPathFor("/s/../a.jsonl", "linux"), "/a.jsonl");
    for (const input of ["~/a.jsonl", "a.jsonl", "./a.jsonl"]) assert.equal(environmentIndependentPathFor(input, "darwin"), undefined, input);
  });
});

describe("comparison", () => {
  test("isWithin rejects sibling prefixes and accepts the root itself", () => {
    const base = path.join(root, "a", "b");
    assert.equal(isWithin(base, base), true);
    assert.equal(isWithin(base, path.join(base, "c")), true);
    assert.equal(isWithin(base, path.join(root, "a", "bc")), false);
    assert.equal(isWithin(base, path.join(root, "a")), false);
    assert.equal(isAncestorOf(path.join(root, "a"), base), true);
    assert.equal(isAncestorOf(base, path.join(root, "a")), false);
    assert.equal(isWithin(path.parse(root).root, root), true);
  });

  test("macOS folds case and Unicode normalization", { skip: process.platform !== "darwin" }, () => {
    assert.equal(comparisonKey("/Users/X/Caf\u00E9"), comparisonKey("/users/x/cafe\u0301"));
    assert.equal(isWithin("/Users/X", "/users/x/y"), true);
  });

  test("Linux compares exactly", { skip: process.platform !== "linux" }, () => {
    assert.notEqual(comparisonKey("/home/X"), comparisonKey("/home/x"));
  });

  test("Windows folds case, separators and the \\\\?\\ prefix", { skip: !isWin }, () => {
    assert.equal(comparisonKey("\\\\?\\C:\\Users\\X"), comparisonKey("c:/users/x"));
    assert.equal(comparisonKey("\\\\?\\UNC\\srv\\share\\a"), comparisonKey("\\\\srv\\share\\A"));
    assert.equal(isWithin("C:\\Users\\X", "c:\\users\\x\\y"), true);
  });
});
