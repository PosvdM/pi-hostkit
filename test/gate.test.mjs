import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { GATE_REFUSED_EXIT_CODE, GATE_RELEASE_LINE } from "../dist/index.js";
import { here, tempDir } from "./helpers.mjs";

const gate = path.join(here, "..", "dist", "gate.js");
const entry = path.join(here, "fixtures", "marker-entry.mjs");
let root;
let cleanup;
before(async () => {
  ({ dir: root, cleanup } = await tempDir("hostkit-gate-"));
});
after(() => cleanup());

let n = 0;
/** Runs the gate with the marker entry, writes `input` (then ends stdin unless `keepOpen`). */
async function runGate(input, { end = true } = {}) {
  const marker = path.join(root, `marker-${++n}.json`);
  const child = spawn(process.execPath, [gate, entry, "--mode", "rpc", "--session", "/x y/z.jsonl"], {
    env: { ...process.env, MARKER_FILE: marker },
    stdio: ["pipe", "ignore", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  if (input) child.stdin.write(input);
  if (end) child.stdin.end();
  const code = await exited;
  return { code, marker: existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null };
}

describe("start gate", () => {
  test("EOF before the release line: exit 75, entry not loaded", async () => {
    const { code, marker } = await runGate("");
    assert.equal(code, GATE_REFUSED_EXIT_CODE);
    assert.equal(marker, null);
  });

  test("a wrong line: exit 75, entry not loaded", async () => {
    const { code, marker } = await runGate("hello\n");
    assert.equal(code, GATE_REFUSED_EXIT_CODE);
    assert.equal(marker, null);
  });

  test("an oversized line without LF: exit 75, entry not loaded", async () => {
    const { code, marker } = await runGate("x".repeat(10_000));
    assert.equal(code, GATE_REFUSED_EXIT_CODE);
    assert.equal(marker, null);
  });

  test("release followed by RPC input in one write: the entry gets argv and the next line intact", async () => {
    const { code, marker } = await runGate(`${GATE_RELEASE_LINE}\n{"type":"get_state","id":"1"}\n`);
    assert.equal(code, 0);
    assert.equal(marker.loaded, true);
    assert.deepEqual(marker.argv, [entry, "--mode", "rpc", "--session", "/x y/z.jsonl"]);
    assert.equal(marker.firstLine, '{"type":"get_state","id":"1"}');
  });

  test("CRLF release line is accepted", async () => {
    const { code, marker } = await runGate(`${GATE_RELEASE_LINE}\r\nnext\n`);
    assert.equal(code, 0);
    assert.equal(marker.firstLine, "next");
  });
});
