import readline from "node:readline";

// Requests an operation the server never offered, then reports its answer.
const lines = readline.createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ heapLimitBytes: 1, type: "ready" });
let step = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  step += 1;
  if (step === 1) {
    write({ id: 1, input: {}, operation: "agent_session_close", type: "call" });
    return;
  }
  write({
    memory: { arrayBuffersBytes: 0, heapUsedBytes: 0, rssBytes: 0 },
    ok: true,
    type: "done",
    value: message.outcome,
  });
  process.exit(0);
});
