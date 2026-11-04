import { writeSync } from "node:fs";
import readline from "node:readline";

// Dies as soon as it receives a program.
const lines = readline.createInterface({ input: process.stdin });
process.stdout.write(
  `${JSON.stringify({ heapLimitBytes: 1, type: "ready" })}\n`
);
lines.on("line", () => {
  for (let index = 0; index < 128; index += 1) {
    writeSync(2, Buffer.alloc(65_536, 120));
  }
  writeSync(2, "final fatal child diagnostic");
  process.exit(7);
});
