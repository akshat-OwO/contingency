import readline from "node:readline";

// Dies as soon as it receives a program.
const lines = readline.createInterface({ input: process.stdin });
process.stdout.write(
  `${JSON.stringify({ heapLimitBytes: 1, type: "ready" })}\n`
);
lines.on("line", () => {
  process.exit(7);
});
