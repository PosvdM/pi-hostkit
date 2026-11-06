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
    }
  });
});

describe("rpcSessionFile", () => {
  test("only an effective --session path in RPC mode counts", () => {
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", abs], undefined), { file: abs });
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--continue", "--", "--session", abs], undefined), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", `--session=${abs}`], undefined), {});
    assert.deepEqual(rpcSessionFile(["--mode", "json", "--session", abs], undefined), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", "abc123"], undefined), {}, "a session id, not a path");
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--no-session", "--session", abs], undefined), {});
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", "rel/a.jsonl"], undefined), { relative: true });
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", "rel/a.jsonl"], path.resolve("/w")), {
      file: path.resolve("/w", "rel/a.jsonl"),
    });
  });

  test("--session wins over --continue in pi, but spawnWriter refuses the combination", () => {
    assert.deepEqual(rpcSessionFile(["--mode", "rpc", "--session", abs, "--continue"], undefined), { file: abs });
    assert.equal(hasOnlyExplicitSession(["--mode", "rpc", "--session", abs, "--continue"]), false);
    assert.equal(hasOnlyExplicitSession(["--mode", "rpc", "--session", abs]), true);
  });
});
