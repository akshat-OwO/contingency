// Announces itself with a property the protocol does not declare.
process.stdout.write(
  `${JSON.stringify({ extra: true, heapLimitBytes: 1, type: "ready" })}\n`
);
process.stdin.resume();
