// Stand-in for pi's cli.js in gate tests: records that it was loaded, its
// arguments, and the first stdin line it receives after the gate.
import { writeFileSync } from "node:fs";

const marker = process.env.MARKER_FILE;
writeFileSync(marker, JSON.stringify({ loaded: true, argv: process.argv.slice(1) }));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lf = buf.indexOf("\n");
  if (lf >= 0) {
    writeFileSync(marker, JSON.stringify({ loaded: true, argv: process.argv.slice(1), firstLine: buf.slice(0, lf) }));
    process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
