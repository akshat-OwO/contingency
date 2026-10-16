/* oxlint-disable no-await-in-loop -- Process exit checks and server shutdown are ordered lifecycle operations. */
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const root = path.resolve(import.meta.dirname, "../../../../..");
export const cliRoot = path.join(root, "packages/cli");
export const { Effect, Predicate } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("effect", { paths: [cliRoot] })
  ).href
);
export const artifacts = path.resolve(
  import.meta.dirname,
  "../../artifacts/interface-eval"
);
export const json = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const lines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
export const memory = () => {
  const vm = execFileSync("vm_stat", { encoding: "utf-8" });
  const swap = execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf-8" });
  const page = Number(vm.match(/page size of (?<count>\d+)/u)?.groups?.count);
  const free = Number(vm.match(/Pages free:\s+(?<count>\d+)/u)?.groups?.count);
  const inactive = Number(
    vm.match(/Pages inactive:\s+(?<count>\d+)/u)?.groups?.count
  );
  const used = Number(swap.match(/used = (?<count>[\d.]+)/u)?.groups?.count);
  const available = (free + inactive) * page;
  if (
    !Number.isFinite(available) ||
    !Number.isFinite(used) ||
    used > 0 ||
    available < 3 * 1024 ** 3
  ) {
    throw new Error(
      `Memory guard refused run: ${available} available bytes; ${swap.trim()}`
    );
  }
  return { at: new Date().toISOString(), available, swap, vm };
};
const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line
        .trim()
        .match(
          /^(?<pid>\d+)\s+(?<parent>\d+)\s+(?<started>.{24})\s+(?<command>.*)$/u
        );
      return match
        ? [
            {
              command: match.groups.command,
              parent: Number(match.groups.parent),
              pid: Number(match.groups.pid),
              started: match.groups.started,
            },
          ]
        : [];
    });
export const closeServer = async (server) => {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await promisify(server.close.bind(server))();
};

const alive = (row, table) =>
  table.some((entry) => entry.pid === row.pid && entry.started === row.started);
export class Resources {
  constructor(directory) {
    this.directory = directory;
    this.servers = [];
    this.ports = [];
    this.owned = new Map();
    this.roots = new Set();
    this.timer = setInterval(() => this.inspect(), 1000);
    this.timer.unref();
  }
  inspect() {
    const table = processTable();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table) {
        if (
          !this.owned.has(row.pid) &&
          (this.roots.has(row.pid) || this.owned.has(row.parent))
        ) {
          this.owned.set(row.pid, {
            ...row,
            observed: new Date().toISOString(),
            owner: process.pid,
            stop: "SIGTERM, then SIGKILL if still alive with identical start time",
          });
          changed = true;
        }
      }
    }
    json(path.join(this.directory, "processes.json"), [...this.owned.values()]);
    return table;
  }
  start(command, args, options = {}) {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
      detached: true,
    });
    this.roots.add(child.pid);
    this.inspect();
    child.on("error", (error) => {
      this.error = String(error);
    });
    return child;
  }
  trackServer(server, purpose) {
    this.servers.push(server);
    this.ports.push({
      owner: process.pid,
      port: server.address().port,
      purpose,
      started: new Date().toISOString(),
      stop: "server.close",
    });
    json(path.join(this.directory, "ports.json"), this.ports);
  }
  async cleanup() {
    for (const server of this.servers) {
      await closeServer(server);
    }
    clearInterval(this.timer);
    const before = this.inspect();
    const owned = [...this.owned.values()].toReversed();
    for (const row of owned) {
      if (alive(row, before)) {
        try {
          process.kill(row.pid, "SIGTERM");
        } catch {
          // The process exited between inspection and signaling.
        }
      }
    }
    // This is a bounded process-exit guard, not a product readiness wait.
    const deadline = AbortSignal.timeout(10_000);
    while (true) {
      const table = processTable();
      if (!owned.some((row) => alive(row, table)) || deadline.aborted) {
        break;
      }
      await delay(100);
    }
    const remaining = processTable();
    for (const row of owned) {
      if (alive(row, remaining)) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {
          // The process exited between inspection and signaling.
        }
      }
    }
    const killDeadline = AbortSignal.timeout(5000);
    while (
      owned.some((row) => alive(row, processTable())) &&
      !killDeadline.aborted
    ) {
      await delay(100);
    }
    const after = processTable();
    const survivors = owned.filter((row) => alive(row, after));
    const listeners = this.ports.flatMap(({ port }) => {
      try {
        return [
          execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
            encoding: "utf-8",
          }),
        ];
      } catch (error) {
        if (error.status === 1) {
          return [];
        }
        throw error;
      }
    });
    json(path.join(this.directory, "cleanup.json"), {
      at: new Date().toISOString(),
      listeners,
      ports: this.ports,
      processes: owned,
      survivors,
    });
    if (survivors.length || listeners.length) {
      throw new Error(
        `Owned processes survived cleanup: ${survivors.map((row) => row.pid)}`
      );
    }
  }
}
export const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
export const fixture = async (resources) => {
  const directory = path.resolve(
    import.meta.dirname,
    "../../fixtures/ecommerce"
  );
  const server = createServer(async (request, response) => {
    const name =
      new URL(request.url, "http://localhost").pathname.slice(1) || "shop.html";
    if (!/^[a-z\d-]+\.html$/u.test(name)) {
      response.writeHead(204).end();
      return;
    }
    try {
      response.setHeader("content-type", "text/html");
      response.end(await readFile(path.join(directory, name)));
    } catch {
      response.writeHead(404).end();
    }
  });
  const url = `${await listen(server)}/shop.html`;
  resources.trackServer(server, "ecommerce fixture");
  return { server, url };
};
export const redact = (value) => {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:value|values|secret|password|token|authorization)$/iu.test(key)
          ? "[REDACTED]"
          : redact(item),
      ])
    );
  }
  // Code and encoded text may contain Variable literals. Redact embedded JSON too.
  if (Predicate.isString(value)) {
    try {
      const parsed = JSON.parse(value);
      if (Predicate.isObject(parsed) || Array.isArray(parsed)) {
        return JSON.stringify(redact(parsed));
      }
    } catch {
      // Plain text is not encoded JSON.
    }
    return value.replaceAll(
      /(?<prefix>\b(?:value|password|secret)\s*[:=]\s*)(?<literal>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/giu,
      '$<prefix>"[REDACTED]"'
    );
  }
  return value;
};
// Keep application outputs named `value` intact unless they are Variable values.
const scrubVariables = (value) => {
  if (Array.isArray(value)) {
    return value.map(scrubVariables);
  }
  if (Predicate.isObject(value)) {
    if (("name" in value && "value" in value) || value.secret === true) {
      return redact(value);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubVariables(item)])
    );
  }
  if (Predicate.isString(value)) {
    try {
      const parsed = JSON.parse(value);
      if (Predicate.isObject(parsed) || Array.isArray(parsed)) {
        return JSON.stringify(scrubVariables(parsed));
      }
    } catch {
      // Plain text is not encoded JSON.
    }
    return value.replaceAll(
      /(?<prefix>\b(?:value|password|secret)\s*[:=]\s*)(?<literal>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/giu,
      '$<prefix>"[REDACTED]"'
    );
  }
  return value;
};
export const logMessage = (message) => {
  if (
    message?.params?.arguments?.code &&
    /agent_variable_/u.test(message.params.arguments.code)
  ) {
    return scrubVariables({
      ...message,
      params: {
        ...message.params,
        arguments: {
          ...message.params.arguments,
          code: "[REDACTED Variable program]",
        },
      },
    });
  }
  if (
    message?.method === "tools/call" &&
    /variable/iu.test(message.params?.name ?? "")
  ) {
    return redact(message);
  }
  return scrubVariables(message);
};
export const unpack = (result) => {
  if (result?.error) {
    throw new Error(JSON.stringify(result.error));
  }
  const body = result?.result ?? result;
  if (body?.isError) {
    throw new Error(JSON.stringify(body));
  }
  if (body?.structuredContent) {
    return body.structuredContent;
  }
  const text = body?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return body;
};
export const stack = async ({ directory, iface, resources }) => {
  const hooks = {};
  await mkdir(directory, { recursive: true });
  const portServer = createServer();
  const portUrl = await listen(portServer);
  const { port } = new URL(portUrl);
  await closeServer(portServer);
  const child = resources.start(
    process.execPath,
    [path.join(cliRoot, "dist/index.js"), "mcp"],
    {
      cwd: directory,
      env: {
        ...process.env,
        CONTINGENCY_CATALOG_ROOT: path.join(directory, "catalog"),
        CONTINGENCY_MCP_INTERFACE: iface,
        CONTINGENCY_MCP_PORT: port,
        NODE_ENV: "production",
      },
    }
  );
  child.stderr.on("data", (data) =>
    appendFileSync(path.join(directory, "server.stderr"), data)
  );
  const pending = new Map();
  const modelIds = new Map();
  const journal = [];
  let nextId = 0;
  let buffer = "";
  const record = (direction, message, owner, bytes, elapsedMs) => {
    const entry = {
      at: new Date().toISOString(),
      bytes,
      direction,
      elapsedMs,
      message: logMessage(hooks.inspect?.(message) ?? message),
      owner,
    };
    journal.push(entry);
    appendFileSync(
      path.join(directory, "proxy.jsonl"),
      `${JSON.stringify(entry)}\n`
    );
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      record(
        "answer",
        message,
        waiter?.owner ?? "server",
        Buffer.byteLength(line) + 1,
        waiter ? performance.now() - waiter.start : undefined
      );
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited ${code} ${signal}`));
    }
    pending.clear();
  });
  const rpc = (message, owner = "harness") => {
    const request = { ...message };
    if (owner === "model" && message.method === "notifications/cancelled") {
      request.params = {
        ...message.params,
        requestId:
          modelIds.get(message.params.requestId) ?? message.params.requestId,
      };
    }
    if (message.id !== undefined) {
      nextId += 1;
      request.id = nextId;
      if (owner === "model") {
        modelIds.set(message.id, nextId);
      }
    }
    const raw = `${JSON.stringify(request)}\n`;
    record("request", request, owner, Buffer.byteLength(raw));
    if (message.id === undefined) {
      child.stdin.write(raw);
      return Promise.resolve(null);
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new Error(`MCP hang: ${request.method}`));
      }, 120_000);
      pending.set(request.id, {
        owner,
        reject,
        resolve,
        start: performance.now(),
        timer,
      });
      child.stdin.write(raw);
    }
    return promise;
  };
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const original = JSON.parse(body);
      const userAction = async (hook, ...args) => {
        try {
          await hook?.(...args);
        } catch (error) {
          hooks.error = String(error);
          throw error;
        }
      };
      await userAction(hooks.before, original);
      const result = await rpc(original, "model");
      await userAction(hooks.after, original, result);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(result ? { ...result, id: original.id } : null)
      );
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  const url = await listen(server);
  resources.trackServer(server, "MCP logging bridge");
  resources.ports.push({
    owner: child.pid,
    port: Number(port),
    purpose: "production Workspace",
    stop: "terminate owned MCP process",
  });
  await rpc({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "interface-eval", version: "1" },
      protocolVersion: "2024-11-05",
    },
  });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = async (name, args = {}) =>
    unpack(
      await rpc({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      })
    );
  const operation = async (name, args = {}) => {
    if (iface === "native") {
      return call(name, args);
    }
    const result = await call("agent_code_execute", {
      code: `return await tools.${name}(${JSON.stringify(args)});`,
    });
    const successfulIntervention =
      result.status === "intervention" &&
      result.receipts?.length === 1 &&
      result.receipts[0].operation === name &&
      result.receipts[0].outcome === "succeeded" &&
      (result.value !== undefined || result.valueResource);
    if (result.status !== "completed" && !successfulIntervention) {
      throw new Error(JSON.stringify(result));
    }
    if (result.valueResource) {
      const resource = unpack(
        await rpc({
          id: 1,
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: result.valueResource.uri },
        })
      );
      return JSON.parse(resource.contents[0].text);
    }
    return result.value;
  };
  return {
    child,
    directory,
    hooks,
    journal,
    operation,
    port: Number(port),
    rpc,
    server,
    url,
  };
};
