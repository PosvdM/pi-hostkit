import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, test } from "node:test";
import { parsePiArgs, rpcSessionFile, hasOnlyExplicitSession } from "../dist/piargs.js";
import { piInstall } from "./helpers.mjs";

let piParse;
before(async () => {
  const { packageDir } = await piInstall();
  ({ parseArgs: piParse } = await import(pathToFileURL(path.join(packageDir, "dist", "cli", "args.js")).href));
});

const abs = path.resolve("/tmp/s/a.jsonl");
const cases = [
  ["--mode", "rpc", "--session", abs],
  ["--mode", "rpc", "--continue", "--", "--session", abs],
  ["--mode", "rpc", "--session", abs, "--continue"],
  ["--mode", "rpc", `--session=${abs}`],
  ["--mode=rpc", "--session", abs],
  ["--mode", "rpc", "--session"],
  ["--mode", "--session", abs],
  ["--mode", "json", "--session", abs],
  ["--mode", "rpc", "--model", "--session", abs],
  ["--mode", "rpc", "--x-flag", "--session", abs],
  ["--mode", "rpc", "--x-flag", "value", "--session", abs],
  ["--mode", "rpc", "--x-flag", "@file", "--session", abs],
  ["--mode", "rpc", "-p", "--session", abs],
  ["--mode", "rpc", "-p", "message", "--session", abs],
  ["--mode", "rpc", "-p", "---x", "--session", abs],
  ["--mode", "rpc", "--list-models", "--session", abs],
  ["--mode", "rpc", "--list-models", "gpt", "--session", abs],
  ["--mode", "rpc", "--use-theme", "--session", abs],
  ["--mode", "rpc", "--tui-mode", "odd", "--session", abs],
  ["--mode", "rpc", "-n", "--session", abs],
  ["--mode", "rpc", "--session-id", "abc", "--session", abs],
  ["--mode", "rpc", "--fork", abs],
  ["--mode", "rpc", "--no-session", "--session", abs],
  ["--mode", "rpc", "-r", "-c", "-h", "-v", "--export", "out.html"],
  ["--mode", "rpc", "-zz", "--session", abs],
  ["--mode", "rpc", "-e", "--session", abs],
  ["--mode", "rpc", "--offline", "-ne", "-ns", "-np", "--no-themes", "-e", "/x/ext.ts", "--session", abs],
  ["--session", abs, "--mode"],
  ["--mode", "rpc", "--thinking", "bogus", "--session", abs],
  ["--mode", "rpc", "--tools", "+bash,read", "--session", abs],
  ["--mode", "rpc", "-t", "+bash,-read", "--session", abs],
  ["--mode", "rpc", "--tools", "+ba*", "--session", abs],
  ["--mode", "rpc", "--tools", "read, grep ,", "--session", abs],
  ["--mode", "rpc", "--exclude-tools", "+bash,read", "--session", abs],
  ["--mode", "rpc", "@notes.md", "--session", abs],
  ["--mode", "rpc", "--session", abs, "--", "@a", "b"],
  ["--mode", "rpc", "--session-id", "x", "--session", abs],
];

describe("parsePiArgs (differential against pi 1.5.0 parseArgs)", () => {
  test("session-related fields and errors match pi", () => {
    for (const args of cases) {
      const mine = parsePiArgs(args);
      const theirs = piParse(args);
      const label = JSON.stringify(args);
      for (const key of ["mode", "session", "sessionId", "fork", "continue", "resume", "noSession", "help", "version", "print", "export", "listModels"]) {
        assert.equal(mine[key], theirs[key], `${key} for ${label}`);
      }
      assert.equal(mine.errors.length > 0, theirs.diagnostics.some((d) => d.type === "error"), `errors for ${label}`);
      assert.equal(mine.fileArgs, theirs.fileArgs.length, `fileArgs for ${label}`);
    }
  });
});

describe("rpcSessionFile", () => {
  test("only an effective --session path in RPC mode counts", () => {
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", abs]), { file: abs });
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--continue", "--", "--session", abs]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", `--session=${abs}`]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "json", "--session", abs]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", "abc123"]), {}, "a session id, not a path");
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--no-session", "--session", abs]), {});
  });

  test("pi exits before opening the session: tool list errors, @file in RPC mode, --session-id with --session", () => {
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--tools", "+bash,read", "--session", abs]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "@notes.md", "--session", abs]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", abs, "--", "@a"]), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session-id", "x", "--session", abs]), {});
  });

  test("paths that depend on the pi process are uncertain", () => {
    for (const value of ["rel/a.jsonl", "~/a.jsonl", "a.jsonl", ...(process.platform === "win32" ? ["\\s\\a.jsonl", "/c/s/a.jsonl"] : [])]) {
      assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", value]), { uncertain: true }, value);
    }
  });

  test("--session wins over --continue in pi, but spawnWriter refuses the combination", () => {
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", abs, "--continue"]), { file: abs });
    assert.equal(hasOnlyExplicitSession(["--mode", "rpc", "--session", abs, "--continue"]), false);
    assert.equal(hasOnlyExplicitSession(["--mode", "rpc", "--session", abs]), true);
  });
});
