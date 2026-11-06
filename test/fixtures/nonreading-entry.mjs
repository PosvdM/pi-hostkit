// A pi stand-in that keeps running without reading stdin or writing RPC replies.
process.stdout.write(`${JSON.stringify({ type: "nonreading_ready" })}\n`);
setInterval(() => {}, 1_000);
