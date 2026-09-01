#!/usr/bin/env node
// One MCP client, held open for a verification run.
//
// Agent Sessions live inside the MCP process that owns them, and that process
// speaks MCP over its own stdio. A one-shot client would create a session in a
// process that then exits, so this broker keeps a single stdio conversation
// alive and lends it to `control-contingency mcp call` over loopback HTTP.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const cli = flag("cli");
const port = Number(flag("port"));
if (cli === undefined || !Number.isInteger(port)) {
  process.stderr.write("mcp-broker needs --cli <path> --port <n>\n");
  process.exit(1);
}

const child = spawn(process.execPath, [cli, "mcp"], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 0;
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.length === 0) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  }
});

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = (nextId += 1);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after 60s`));
    }, 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
  });

const notify = (method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const respond = (response, status, payload) => {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(text),
    "content-type": "application/json",
  });
  response.end(text);
};

const initialized = send("initialize", {
  capabilities: {},
  clientInfo: { name: "verify-contingency", version: "1.0.0" },
  protocolVersion: "2025-06-18",
}).then((message) => {
  if (message.error !== undefined) {
    throw new Error(`initialize failed: ${JSON.stringify(message.error)}`);
  }
  notify("notifications/initialized", {});
  return message.result;
});

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    initialized.then(
      () => respond(response, 200, { ok: true }),
      (error) => respond(response, 503, { error: String(error) })
    );
    return;
  }
  if (request.method !== "POST" || request.url !== "/call") {
    respond(response, 404, { error: "POST /call or GET /health" });
    return;
  }
  readBody(request)
    .then(async (body) => {
      await initialized;
      const { params = {}, tool } = JSON.parse(body);
      if (typeof tool !== "string") {
        respond(response, 400, { error: "call needs a tool name" });
        return;
      }
      const message = await send("tools/call", {
        arguments: params,
        name: tool,
      });
      if (message.error !== undefined) {
        respond(response, 502, { error: message.error });
        return;
      }
      respond(response, 200, message.result);
    })
    .catch((error) => {
      respond(response, 500, { error: String(error) });
    });
});

const shutdown = () => {
  server.close();
  child.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
child.on("exit", (code) => {
  process.stderr.write(`mcp server exited with code ${code}\n`);
  process.exit(code ?? 1);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`broker listening on ${port}\n`);
});
