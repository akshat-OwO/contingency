// A child for the supervision module's tests. argv[2] picks what it does:
//
// - `write <code>`: prints a secret on both streams, then exits with <code>.
// - `chatty`: prints 20 KiB of numbered stderr lines, then exits 1.
// - `flood`: prints stdout until it is killed.
// - `hang`: prints `ready <pid>` and runs until a signal stops it, with or
//   without a stdin to wait on.
// - `stubborn`: as `hang`, but ignores SIGTERM.
const [mode = "write", argument = "0"] = process.argv.slice(2);
const SECRET = "hunter2";

/** Keeps the process running until a signal ends it, as a hung tool would. */
const stayAlive = () => {
  // oxlint-disable-next-line contingency/no-test-wait -- Models a hung child; the tests end it by signal, never by waiting on this timer.
  setInterval(() => {
    // Nothing to do; the interval only holds the event loop open.
  }, 1_000_000_000);
};

switch (mode) {
  case "write": {
    process.stdout.write(`stdout says ${SECRET}\n`);
    process.stderr.write(`stderr says ${SECRET}\n`);
    process.exitCode = Number(argument);
    break;
  }
  case "chatty": {
    for (let line = 0; line < 1024; line += 1) {
      process.stderr.write(`line ${String(line).padStart(14, "0")}\n`);
    }
    process.exitCode = 1;
    break;
  }
  case "flood": {
    const chunk = "x".repeat(64 * 1024);
    const write = () => {
      while (process.stdout.write(chunk)) {
        // Fill the pipe; resume on drain.
      }
      process.stdout.once("drain", write);
    };
    write();
    break;
  }
  case "stubborn": {
    process.on("SIGTERM", () => {
      // Ignored, so only SIGKILL ends it.
    });
    process.stdout.write(`ready ${process.pid}\n`);
    stayAlive();
    break;
  }
  default: {
    process.stdout.write(`ready ${process.pid}\n`);
    stayAlive();
  }
}
