import { spawn } from "node:child_process";

// Starts the interpreter, then waits to be killed. The interpreter shares this
// process's stdin, stdout, and fd 3, so whoever spawned this process feeds it
// a program, keeps its stdin open after this process dies, and sees its
// output end only once the interpreter itself has exited.
const [entry] = process.argv.slice(2);
const interpreter = spawn(
  process.execPath,
  [entry, JSON.stringify({ intervalMs: 5, rssCeilingBytes: 2 ** 30 })],
  { stdio: ["inherit", "inherit", "ignore", "inherit"] }
);
// The referenced child keeps this process alive until it is killed. It never
// reads stdin, which would take the program.
process.stderr.write(`${interpreter.pid}\n`);
