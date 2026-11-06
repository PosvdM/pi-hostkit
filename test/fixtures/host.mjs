// Minimal host process for tests: performs one action, prints one JSON line,
// then stays alive until killed (or until stdin closes).
import {
  acquireInstanceLock,
  acquireSessionWriterLock,
  currentProcessIdentity,
  isSessionWriterLock,
  spawnManaged,
} from "../../dist/index.js";

const args = JSON.parse(process.env.HOSTKIT_TEST_ARGS);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (args.action === "spawn") {
  const proc = await spawnManaged(args);
  print({ identity: proc.identity });
} else if (args.action === "instance-lock") {
  const lock = await acquireInstanceLock(args.name, args.dir);
  print({ held: lock !== null });
} else if (args.action.startsWith("session-")) {
  const host = { app: args.app ?? "pi-pane", identity: currentProcessIdentity("child-host") };
  const lock = await acquireSessionWriterLock(args.sessionFile, host);
  if (!isSessionWriterLock(lock)) {
    print({ busy: lock.heldBy ?? null });
  } else {
    const result = await lock.recoverPreviousWriter();
    if (args.action === "session-host") {
      const proc = await lock.spawnWriter(args);
      await proc.rpc.send({ type: "get_state" }, { timeoutMs: 20_000 });
      print({ result, identity: proc.identity });
    } else if (args.action === "session-held") {
      // Dies (when killed) between spawning pi and recording it; pi stays at the gate.
      const proc = await spawnManaged({ ...args, startHeld: true });
      print({ result, identity: proc.identity });
    } else if (args.action === "session-unrecorded") {
      // Does not follow the protocol: releases pi without recording it.
      const proc = await spawnManaged(args);
      await proc.rpc.send({ type: "get_state" }, { timeoutMs: 20_000 });
      print({ result, identity: proc.identity });
    }
  }
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
