#!/usr/bin/env node
// Exercise the final stdio proxy against production MCP without a model or browser.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  artifacts,
  Effect,
  Resources,
  json,
  memory,
  stack,
} from "./runtime.mjs";

await Effect.runPromise(
  Effect.tryPromise(async () => {
    const directory = path.join(artifacts, "transport-check");
    await mkdir(directory, { recursive: true });
    const initialMemory = memory();
    const temporary = await mkdtemp(
      path.join(tmpdir(), "contingency-transport-")
    );
    const resources = new Resources(directory);
    try {
      const mcp = await stack({
        directory: temporary,
        iface: "native",
        resources,
      });
      const child = resources.start(process.execPath, [
        path.join(import.meta.dirname, "proxy.mjs"),
        mcp.url,
      ]);
      const pending = new Map();
      const output = createInterface({ input: child.stdout });
      output.on("line", (line) => {
        const message = JSON.parse(line);
        pending.get(message.id)?.resolve(message);
      });
      const request = (id, method, params) => {
        const result = Promise.withResolvers();
        pending.set(id, result);
        child.stdin.write(
          `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`
        );
        return result.promise;
      };
      await request("client-init", "initialize", {
        capabilities: {},
        clientInfo: { name: "transport-check", version: "1" },
        protocolVersion: "2024-11-05",
      });
      const [tools, sessions] = await Promise.all([
        request("client-tools", "tools/list", {}),
        request("client-read", "tools/call", {
          arguments: {},
          name: "agent_sessions_get",
        }),
      ]);
      assert.equal(tools.id, "client-tools");
      assert.equal(sessions.id, "client-read");
      assert.equal(tools.result.tools.length, 37);
      assert.ok(!sessions.error);
      const closed = once(child, "close");
      child.stdin.end();
      await closed;
      output.close();
      json(path.join(directory, "result.json"), {
        initialMemory,
        ok: true,
        requests: mcp.journal,
      });
      process.stdout.write(
        "Production stdio transport check passed without a model or browser\n"
      );
    } finally {
      await resources.cleanup();
      await rm(temporary, { force: true, recursive: true });
    }
  })
);
