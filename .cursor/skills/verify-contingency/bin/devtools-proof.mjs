// Prove observation through agent_code_execute and the matching Workspace panels.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const cliRoot = path.resolve(import.meta.dirname, "../../../../packages/cli");
const { Effect } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("effect", { paths: [cliRoot] })
  ).href
);
const io = (action) => Effect.tryPromise(action);
const execute = promisify(execFile);
const control = path.join(import.meta.dirname, "control-contingency");
const artifacts = path.resolve(
  import.meta.dirname,
  "../artifacts/devtools-observe"
);
const screenshots = process.env.CONTINGENCY_DEVTOOLS_EVIDENCE ?? artifacts;
assert.ok(
  process.env.CONTINGENCY_VERIFY_DIR,
  "Launch an isolated verification instance first."
);
const journal = [];
const command = (...args) =>
  io(async () => {
    const { stdout, stderr } = await execute("nub", [control, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    journal.push({ args, exitCode: 0, stderr, stdout });
    return stdout.trim();
  });
const program = (name, code) =>
  Effect.gen(function* executeProgram() {
    const result = JSON.parse(
      yield* command(
        "mcp",
        "call",
        "--tool",
        "agent_code_execute",
        "--params",
        JSON.stringify({ code, timeoutMs: 30_000 })
      )
    );
    yield* io(() =>
      writeFile(
        path.join(artifacts, `${name}.json`),
        JSON.stringify({ code, result }, null, 2)
      )
    );
    assert.equal(result.status, "completed", JSON.stringify(result));
    return result.value;
  });
await Effect.runPromise(
  Effect.gen(function* proveDevtools() {
    yield* io(() => mkdir(artifacts, { recursive: true }));
    yield* io(() => mkdir(screenshots, { recursive: true }));

    try {
      const instance = JSON.parse(
        yield* io(() =>
          readFile(
            path.join(process.env.CONTINGENCY_VERIFY_DIR, "instance.json"),
            "utf-8"
          )
        )
      );
      assert.ok(
        instance.ecommerceUrl && instance.mcpUrl,
        "Start ecommerce and MCP first."
      );
      const signatures = yield* program(
        "search",
        'return search({ query: "devtools" });'
      );
      assert.ok(JSON.stringify(signatures).includes("agent_browser_devtools"));
      const url = new URL("devtools-observe.html", instance.ecommerceUrl).href;
      const run = yield* program(
        "start",
        `const session = await tools.agent_run_start({ inputs: [], referencedSkills: [], requestedTask: "Find the fixture's failing request and read its console error", url: ${JSON.stringify(url)}, operationId: "devtools-proof-start", view: "compact" }); return { id: session.id, viewUrl: session.viewUrl };`
      );
      yield* command("browser", "goto", "--url", run.viewUrl);
      yield* command(
        "browser",
        "wait",
        "--role",
        "region",
        "--name",
        "Workspace dock"
      );
      yield* program(
        "capture-start",
        `return tools.agent_browser_devtools({ sessionId: ${JSON.stringify(run.id)}, command: { action: "har_start", operationId: "devtools-proof-capture" } });`
      );
      yield* program(
        "trigger",
        `const sessionId = ${JSON.stringify(run.id)}; const snapshot = await tools.agent_browser_snapshot({ sessionId, format: "structured" }); const button = snapshot.nodes.find(node => node.role === "button" && node.name === "Load failing request"); if (!button) throw new Error("Missing fixture button"); return tools.agent_browser_act({ sessionId, operationId: "devtools-proof-trigger", action: { type: "click", ref: button.ref } });`
      );
      const failed = yield* program(
        "find-500",
        `return tools.agent_browser_devtools({ sessionId: ${JSON.stringify(run.id)}, command: { action: "requests", url: "/devtools-failure", method: "GET", statusMin: 500, statusMax: 599, resourceType: "fetch" } });`
      );
      assert.equal(failed.requests.length, 1);
      assert.equal(failed.requests[0].status, 500);
      const detail = yield* program(
        "request-body",
        `return tools.agent_browser_devtools({ sessionId: ${JSON.stringify(run.id)}, command: { action: "request", requestId: ${JSON.stringify(failed.requests[0].requestId)} } });`
      );
      assert.equal(detail.responseBody, "Fixture service unavailable");
      const consoleRead = yield* program(
        "console",
        `return tools.agent_browser_devtools({ sessionId: ${JSON.stringify(run.id)}, command: { action: "console" } });`
      );
      assert.ok(
        consoleRead.entries.some((entry) =>
          entry.text.includes("Fixture request failed: 500")
        )
      );
      const har = yield* program(
        "har-stop",
        `return tools.agent_browser_devtools({ sessionId: ${JSON.stringify(run.id)}, command: { action: "har_stop", operationId: "devtools-proof-stop" } });`
      );
      const root = path.join(
        process.env.CONTINGENCY_VERIFY_DIR,
        "state/catalog"
      );
      assert.ok(har.path.startsWith(`${root}${path.sep}`));
      assert.equal(
        JSON.parse(yield* io(() => readFile(har.path, "utf-8"))).log.entries[0]
          .response.status,
        500
      );
      for (const panel of ["Network", "Console"]) {
        yield* command("browser", "click", "--role", "button", "--name", panel);
        yield* command("browser", "wait", "--role", "region", "--name", panel);
        if (panel === "Network") {
          yield* command(
            "browser",
            "click",
            "--role",
            "button",
            "--name",
            "Refresh network requests"
          );
        }
        const name = panel.toLowerCase();
        const ariaPath = yield* command(
          "browser",
          "snapshot",
          "--aria",
          "--path",
          `devtools-observe/${name}.aria.txt`
        );
        yield* command(
          "browser",
          "screenshot",
          "--path",
          path.join(screenshots, `${name}.png`)
        );
        const aria = yield* io(() => readFile(ariaPath, "utf-8"));
        assert.ok(aria.includes(panel));
      }
      yield* io(() =>
        writeFile(
          path.join(artifacts, "result.json"),
          JSON.stringify(
            { failed, har, ok: true, screenshots, sessionId: run.id },
            null,
            2
          )
        )
      );
      process.stdout.write(
        `${JSON.stringify({ artifacts, ok: true, screenshots })}\n`
      );
    } finally {
      yield* io(() =>
        writeFile(
          path.join(artifacts, "commands.json"),
          JSON.stringify(journal, null, 2)
        )
      );
    }
  })
);
