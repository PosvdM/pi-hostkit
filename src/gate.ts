// Start gate for managed pi processes.
//
// spawnManaged runs `node gate.js <cliEntry> <pi args...>`. The gate waits for
// one release line on stdin before loading pi, so the host can record the
// process identity (and on Windows assign the Job Object) before pi opens any
// session file or starts a child process. When stdin ends or carries anything
// else, the gate exits with code 75 without loading pi. The gate reads one byte
// at a time so that no RPC input after the release line is consumed.

import { readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GATE_REFUSED_EXIT_CODE, GATE_RELEASE_LINE } from "./gate-protocol.js";

const MAX_LINE = 256;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLine(): string | null {
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n: number;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        sleep(5);
        continue;
      }
      if (code === "EOF" || code === "EPIPE") return null;
      throw error;
    }
    if (n === 0) return null;
    if (byte[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(byte[0]!);
    if (bytes.length > MAX_LINE) return null;
  }
}

async function main(): Promise<void> {
  const [cliEntry, ...args] = process.argv.slice(2);
  if (!cliEntry) process.exit(64);
  let line: string | null;
  try {
    line = readLine();
  } catch {
    line = null;
  }
  if (line !== GATE_RELEASE_LINE) process.exit(GATE_REFUSED_EXIT_CODE);
  // pi reads its arguments from process.argv.slice(2).
  process.argv = [process.argv[0]!, cliEntry, ...args];
  await import(pathToFileURL(cliEntry).href);
}

await main();
