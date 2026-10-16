/* oxlint-disable no-await-in-loop -- Workspace commands and seed capture are ordered user gestures. */
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { json, root } from "./runtime.mjs";

// Reuse control-contingency's driver-serve and its browser command dispatcher.
// POSTing here is the same path used by `control-contingency browser`.
export const workspace = async ({ mcp, resources, temporary, directory }) => {
  const profile = path.join(temporary, "workspace-driver");
  await mkdir(profile);
  const ready = path.join(profile, "driver-url.txt");
  const { promise: readyEvent, resolve, reject } = Promise.withResolvers();
  {
    const readiness = {};
    readiness.timer = setTimeout(() => {
      readiness.watcher.close();
      reject(new Error("Workspace driver did not publish its URL"));
    }, 60_000);
    readiness.watcher = watch(profile, async () => {
      try {
        const contents = await readFile(ready, "utf-8");
        const url = contents.trim();
        readiness.watcher.close();
        clearTimeout(readiness.timer);
        resolve(url);
      } catch (error) {
        if (error.code !== "ENOENT") {
          readiness.watcher.close();
          clearTimeout(readiness.timer);
          reject(error);
        }
      }
    });
  }
  resources.start(process.execPath, [
    path.join(
      root,
      ".cursor/skills/verify-contingency/bin/control-contingency"
    ),
    "driver-serve",
    `http://127.0.0.1:${mcp.port}/`,
    profile,
  ]);
  const url = await readyEvent;
  resources.ports.push({
    owner: process.pid,
    port: Number(new URL(url).port),
    purpose: "Workspace command driver",
    stop: "terminate owned driver",
  });
  const commands = [];
  const command = async (action, flags = {}, privateValue = false) => {
    commands.push({
      action,
      at: new Date().toISOString(),
      flags: privateValue ? { ...flags, value: "[REDACTED]" } : flags,
    });
    json(path.join(directory, "workspace-commands.json"), commands);
    const response = await fetch(url, {
      body: JSON.stringify({ action, flags }),
      method: "POST",
    });
    const body = await response.json();
    // Never include a private request or a reflected private error in evidence.
    assert.ok(
      body.ok,
      privateValue ? "Private Workspace supply failed" : JSON.stringify(body)
    );
    return body.output;
  };
  const click = (name) => command("click", { name, role: "button" });
  const open = (viewUrl) => command("goto", { url: viewUrl });
  const capture = async (name) => {
    await command("snapshot", {
      aria: true,
      path: path.join(directory, `${name}.aria.txt`),
    });
    await command("screenshot", { path: path.join(directory, `${name}.png`) });
  };
  return { capture, click, command, open };
};
