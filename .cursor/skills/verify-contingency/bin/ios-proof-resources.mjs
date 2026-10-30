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
  const result = await execute("ps", ["-axo", "pid=,ppid=,command="]);
  const processes = result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+(?<command>.*)$/u.exec(
        line
      )?.groups;
      assert.ok(match);
      return {
        command: match.command,
        parent: Number(match.parent),
        pid: Number(match.pid),
      };
    });
  const parents = new Map(processes.map(({ pid, parent }) => [pid, parent]));
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
  const descendantIds = new Set(descendants.map(({ pid }) => pid));
  const helpers = processes.filter(
    (entry) =>
      descendantIds.has(entry.pid) &&
      entry.command.includes("/dist/ios/framebuffer/framebuffer ")
  );
  assert.equal(
    helpers.length,
    1,
    "Expected one framebuffer owned by this MCP instance"
  );
  const [helper] = helpers;
  const boundUdid = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu.exec(
    helper.command
  )?.[0];
  assert.equal(
    boundUdid,
    udid,
    "The live framebuffer must bind the selected simulator"
  );
  return {
    descendants,
    observedAt: new Date().toISOString(),
    owner: instance.mcpPid,
    pid: helper.pid,
    udid: boundUdid,
  };
};
