// Prove scale changes through Workspace and the code-only agent operation.
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
  "../artifacts/emulation-scale"
);
const screenshots = process.env.CONTINGENCY_SCALE_EVIDENCE ?? artifacts;
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
    if (name === "teaching-start") {
      assert.equal(result.status, "intervention", JSON.stringify(result));
      assert.deepEqual(result.intervention.reasons, ["user_control"]);
    } else {
      assert.equal(result.status, "completed", JSON.stringify(result));
    }
    return result.value;
  });
await Effect.runPromise(
  Effect.gen(function* proveScale() {
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
      const url = new URL("emulation-scale.html", instance.ecommerceUrl).href;
      const teaching = yield* program(
        "teaching-start",
        `const session = await tools.agent_session_start({ activity: "teaching", clientName: "scale-proof", clientVersion: "1", name: "scale-proof", viewport: {width:1280,height:800,deviceScaleFactor:1}, url: ${JSON.stringify(url)}, operationId: "scale-proof-start" }); await tools.agent_teaching_setup_handoff({sessionId: session.id, operationId: "scale-proof-handoff"}); return {id:session.id,viewUrl:session.viewUrl};`
      );
      yield* command("browser", "goto", "--url", teaching.viewUrl);
      yield* command(
        "browser",
        "wait",
        "--role",
        "region",
        "--name",
        "Workspace dock"
      );
      yield* command(
        "browser",
        "click",
        "--role",
        "button",
        "--name",
        "Emulation"
      );
      const capture = (name) =>
        Effect.gen(function* captureScale() {
          yield* command(
            "browser",
            "snapshot",
            "--aria",
            "--path",
            `emulation-scale/${name}.aria.txt`
          );
          yield* command(
            "browser",
            "screenshot",
            "--path",
            path.join(screenshots, `${name}.png`)
          );
        });
      const apply = (field, label, value) =>
        Effect.gen(function* applyScale() {
          yield* command(
            "browser",
            "fill",
            "--role",
            "spinbutton",
            "--name",
            label,
            "--value",
            String(value)
          );
          yield* command(
            "browser",
            "click",
            "--role",
            "button",
            "--name",
            `Apply ${label.toLowerCase()}`
          );
          yield* command(
            "browser",
            "wait",
            "--text",
            field === "pageZoom"
              ? `Applied: page zoom ${value}%, text scale 100%.`
              : `Applied: page zoom 100%, text scale ${value}%.`
          );
          const applied = yield* program(
            `read-${field}-${value}`,
            `return tools.agent_browser_devtools({sessionId:${JSON.stringify(teaching.id)},command:{action:"emulation_get"}});`
          );
          assert.equal(applied[field], value);
        });
      yield* capture("text-100");
      yield* apply("textScale", "Text scale", 200);
      yield* capture("text-200");
      yield* apply("textScale", "Text scale", 100);
      yield* capture("zoom-100");
      yield* apply("pageZoom", "Page zoom", 400);
      yield* capture("zoom-400");
      // Reopen the view to prove it reads the session's applied values.
      yield* command("browser", "goto", "--url", teaching.viewUrl);
      yield* command(
        "browser",
        "click",
        "--role",
        "button",
        "--name",
        "Emulation"
      );
      yield* command(
        "browser",
        "wait",
        "--text",
        "Applied: page zoom 400%, text scale 100%."
      );
      const run = yield* program(
        "run-start",
        `const session = await tools.agent_run_start({inputs:[], referencedSkills:[], requestedTask:"Check text and zoom reflow", url:${JSON.stringify(url)}, operationId:"scale-run-start",view:"compact"}); return {id:session.id,viewUrl:session.viewUrl};`
      );
      const changed = yield* program(
        "agent-change",
        `return tools.agent_browser_devtools({sessionId:${JSON.stringify(run.id)},command:{action:"emulation_set",pageZoom:400,textScale:200,operationId:"scale-run-change"}});`
      );
      assert.equal(changed.pageZoom, 400);
      assert.equal(changed.textScale, 200);
      const summary = yield* program(
        "run-complete",
        `return tools.agent_run_complete({sessionId:${JSON.stringify(run.id)},operationId:"scale-run-complete"});`
      );
      assert.equal(summary.emulationChanges.length, 1);
      assert.equal(summary.emulationChanges[0].after.textScale, 200);
      const reopened = yield* program(
        "summary-read",
        `return tools.open_run({runId:${JSON.stringify(summary.runId)}});`
      );
      assert.equal(reopened.summary.emulationChanges[0].after.pageZoom, 400);
      yield* command("browser", "goto", "--url", reopened.viewUrl);
      yield* command(
        "browser",
        "wait",
        "--role",
        "region",
        "--name",
        "Emulation"
      );
      yield* capture("run-summary");
      const result = {
        ok: true,
        runId: summary.runId,
        screenshots,
        sessionId: teaching.id,
      };
      yield* io(() =>
        writeFile(
          path.join(artifacts, "result.json"),
          JSON.stringify(result, null, 2)
        )
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
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
