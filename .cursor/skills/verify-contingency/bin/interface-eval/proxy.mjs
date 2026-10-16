#!/usr/bin/env node
// The runner retains the production conversation after the driver exits.
// Forward requests concurrently so cancellation is not held behind a long wait.
import { createInterface } from "node:readline";

const [endpoint] = process.argv.slice(2);
const pending = [];
const forward = async (line) => {
  try {
    const message = JSON.parse(line);
    const response = await fetch(endpoint, {
      body: JSON.stringify(message),
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Proxy HTTP ${response.status}: ${await response.text()}`
      );
    }
    const answer = await response.json();
    if (answer !== null) {
      process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) {
    continue;
  }
  pending.push(forward(line));
}
await Promise.all(pending);
