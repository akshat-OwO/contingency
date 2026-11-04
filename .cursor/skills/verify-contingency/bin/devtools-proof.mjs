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
const { NodeSocket } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("@effect/platform-node", {
      paths: [cliRoot],
    })
  ).href
);
const phase = process.env.CONTINGENCY_PERFORMANCE_PHASE ?? "candidate";
const rpc = (url, tag, payload) =>
  Effect.callback((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(
      new URL("/ws", url).href.replace("http", "ws"),
      { origin: new URL(url).origin }
    );
    const finish = (result) => {
      socket.close();
      resume(result);
    };
    socket.addEventListener("error", () =>
      finish(Effect.fail(new Error(`RPC failed: ${tag}`)))
    );
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({ _tag: "Request", headers: [], id: "1", payload, tag })
      )
    );
    socket.addEventListener("message", (event) => {
      for (const message of [JSON.parse(String(event.data))].flat()) {
        if (message._tag === "Exit") {
          finish(
            message.exit._tag === "Success"
              ? Effect.succeed(message.exit.value)
              : Effect.fail(new Error(JSON.stringify(message.exit)))
          );
        }
      }
    });
    return Effect.sync(() => socket.close());
  }).pipe(Effect.timeout("30 seconds"));
const execute = promisify(execFile);
const control = path.join(import.meta.dirname, "control-contingency");
const artifacts = path.resolve(
  import.meta.dirname,
  `../artifacts/devtools-observe-${phase}`
);
const screenshots = process.env.CONTINGENCY_DEVTOOLS_EVIDENCE ?? artifacts;
assert.ok(
  process.env.CONTINGENCY_VERIFY_DIR,
  "Launch an isolated verification instance first."
);
const journal = [];
const command = (...args) =>
  io(async () => {
    const { stdout, stderr } = await execute(
      process.execPath,
      [control, ...args],
      {
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    journal.push({ args, exitCode: 0, stderr, stdout });
    return stdout.trim();
  });
const program = (name, code, expectedStatus = "completed") =>
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
    assert.equal(result.status, expectedStatus, JSON.stringify(result));
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
        `const session = await tools.agent_run_start({ inputs: [], referencedFlows: [], requestedTask: "Find the fixture's failing request and read its console error", url: ${JSON.stringify(url)}, operationId: "devtools-proof-start", view: "compact" }); return { id: session.id, viewUrl: session.viewUrl };`
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
      yield* program(
        "history",
        `for (let i = 0; i < 20; i++) await tools.agent_browser_act({ sessionId: ${JSON.stringify(run.id)}, operationId: "perf-history-" + i, action: { type: "wait_for_text", text: "Observe a failing request" } }); return null;`
      );
      const defaultView = yield* program(
        "session-default",
        `return tools.agent_session_get({ sessionId: ${JSON.stringify(run.id)} });`
      );
      const fullView = yield* program(
        "session-full",
        `return tools.agent_session_get({ sessionId: ${JSON.stringify(run.id)}, view: "full" });`
      );
      assert.equal(defaultView.id, fullView.id);
      assert.deepEqual(defaultView.pendingDecisions, fullView.pendingDecisions);
      if (phase !== "baseline") {
        assert.equal(defaultView.view, "compact");
      }
      const tabs = yield* rpc(run.viewUrl, "agent.browser.tabs.get", {
        sessionId: run.id,
      });
      const active = tabs.tabs.find((tab) => tab.active);
      assert.ok(active);
      const network = yield* rpc(
        run.viewUrl,
        "agent.browser.network.requests.get",
        { sessionId: run.id, tabId: active.tabId }
      );
      assert.ok(
        network.requests.some((row) => row.url.includes("devtools-failure"))
      );
      if (phase !== "baseline") {
        for (const row of network.requests) {
          for (const field of [
            "headers",
            "responseHeaders",
            "postData",
            "responseBody",
          ]) {
            assert.ok(!(field in row));
          }
        }
      }
      const metrics = {
        historyEntries: fullView.timeline.length,
        networkListBytes: Buffer.byteLength(JSON.stringify(network)),
        networkRows: network.requests.length,
        phase,
        sessionDefaultBytes: Buffer.byteLength(JSON.stringify(defaultView)),
        sessionFullBytes: Buffer.byteLength(JSON.stringify(fullView)),
      };
      yield* io(() =>
        writeFile(
          path.join(artifacts, "performance.json"),
          JSON.stringify(metrics, null, 2)
        )
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
        if (panel === "Network") {
          yield* command(
            "browser",
            "snapshot",
            "--aria",
            "--path",
            `devtools-observe-${phase}/before-request.aria.txt`
          );
          yield* command(
            "browser",
            "click",
            "--role",
            "button",
            "--name",
            "devtools-failure",
            "--partial"
          );
          yield* command("browser", "wait", "--text", "x-fixture-padding");
          yield* command(
            "browser",
            "screenshot",
            "--path",
            path.join(screenshots, "request-headers.png")
          );
          yield* command(
            "browser",
            "click",
            "--role",
            "radio",
            "--name",
            "Response",
            "--partial"
          );
          yield* command(
            "browser",
            "wait",
            "--text",
            "Fixture service unavailable"
          );
          yield* command(
            "browser",
            "screenshot",
            "--path",
            path.join(screenshots, "request-response.png")
          );
          yield* command(
            "browser",
            "click",
            "--role",
            "button",
            "--name",
            "Close request details"
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
      if (phase !== "baseline") {
        const teaching = yield* program(
          "teaching-start",
          `const session = await tools.agent_session_start({ activity: "teaching", clientName: "performance-proof", clientVersion: "1", group: "", name: "performance-teaching", url: ${JSON.stringify(url)}, viewport: { deviceScaleFactor: 1, height: 480, width: 640 }, operationId: "performance-teaching-start" }); if (!session.recordingId || !Array.isArray(session.teaching.instructions)) throw new Error("Teaching start lost full state"); return { id: session.id, recordingId: session.recordingId, viewUrl: session.viewUrl };`
        );
        yield* program(
          "teaching-handoff",
          `return tools.agent_teaching_setup_handoff({ sessionId: ${JSON.stringify(teaching.id)}, operationId: "performance-teaching-handoff" });`,
          "intervention"
        );
        yield* command("browser", "goto", "--url", teaching.viewUrl);
        yield* command(
          "browser",
          "wait",
          "--role",
          "button",
          "--name",
          "Start recording"
        );
        yield* command(
          "browser",
          "click",
          "--role",
          "button",
          "--name",
          "Start recording"
        );
        yield* command(
          "browser",
          "wait",
          "--role",
          "button",
          "--name",
          "Stop recording"
        );
        yield* program(
          "teaching-defaults",
          `const sessionId = ${JSON.stringify(teaching.id)};
const recorded = await tools.agent_teaching_instruction_record({ sessionId, operationId: "performance-teaching-instruction", text: "Inspect the failing request before retrying." });
const current = await tools.agent_session_get({ sessionId });
const listed = (await tools.agent_sessions_get({})).sessions.find(session => session.id === sessionId);
for (const session of [recorded, current, listed]) {
  if (session.recordingId !== ${JSON.stringify(teaching.recordingId)} || session.teaching.instructions[0].text !== "Inspect the failing request before retrying.") throw new Error("Teaching default lost identity or instructions");
}
const waited = await tools.agent_session_get({ sessionId, afterCursor: current.eventCursor, waitMs: 0, view: "full" });
if (waited.view !== "compact" || waited.teaching.instructionCount !== 1) throw new Error("Cursor wait must stay compact");
return { recordingId: current.recordingId, instruction: current.teaching.instructions[0].text, listMatched: true, mutationMatched: true, waitView: waited.view };`
        );
        yield* command(
          "browser",
          "click",
          "--role",
          "button",
          "--name",
          "Stop recording"
        );
        yield* command(
          "browser",
          "wait",
          "--role",
          "button",
          "--name",
          "Start recording"
        );
        yield* command(
          "browser",
          "screenshot",
          "--path",
          path.join(screenshots, "teaching-stopped.png")
        );
      }
      yield* io(() =>
        writeFile(
          path.join(artifacts, "result.json"),
          JSON.stringify(
            { failed, har, metrics, ok: true, screenshots, sessionId: run.id },
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
