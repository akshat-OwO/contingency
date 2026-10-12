import { spawn } from "node:child_process";

// Starts the interpreter on a program, then waits to be killed. The
// interpreter's stdout and fd 3 are this process's own, so whoever spawned
// this process sees them end only when the interpreter itself has exited.
const [entry, code] = process.argv.slice(2);
const interpreter = spawn(
  process.execPath,
  [entry, JSON.stringify({ intervalMs: 5, rssCeilingBytes: 2 ** 30 })],
  { stdio: ["pipe", "inherit", "ignore", "inherit"] }
);
process.stderr.write(`${interpreter.pid}\n`);
interpreter.stdin.write(
  `${JSON.stringify({
    code,
    limits: { maxOutputBytes: 1000, maxToolCalls: 1, timeoutMs: 600_000 },
    operations: [],
    type: "execute",
  })}\n`
);
