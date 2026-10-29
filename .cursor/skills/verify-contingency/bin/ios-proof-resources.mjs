import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const simulatorInventory = async (excluding) => {
  const result = await execute("xcrun", [
    "simctl",
    "list",
    "devices",
    "--json",
  ]);
  const inventory = JSON.parse(result.stdout);
  return Object.values(inventory.devices)
    .flat()
    .filter((device) => device.udid !== excluding)
    .map(({ udid, state }) => ({ state, udid }))
    .toSorted((a, b) => a.udid.localeCompare(b.udid));
};
export const selectedSimulatorResource = async (instance, udid) => {
  assert.ok(udid);
  const result = await execute("ps", ["-axo", "pid=,ppid="]);
  const parents = new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number))
  );
  const descendants = [...parents]
    .filter(([candidate]) => {
      const seen = new Set();
      let pid = candidate;
      while (pid && !seen.has(pid)) {
        if (pid === instance.mcpPid) {
          return true;
        }
        seen.add(pid);
        pid = parents.get(pid);
      }
      return false;
    })
    .map(([pid, parent]) => ({ parent, pid }));
  return {
    descendants,
    observedAt: new Date().toISOString(),
    owner: instance.mcpPid,
    udid,
  };
};
