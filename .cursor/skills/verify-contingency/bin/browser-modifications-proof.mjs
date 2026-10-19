// Prove Browser Modification badges and persisted activity through Workspace.
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
  "../artifacts/browser-modifications"
);
const screenshots = process.env.CONTINGENCY_MODIFICATIONS_EVIDENCE ?? artifacts;
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
const capture = (name) =>
  Effect.gen(function* captureWorkspace() {
    yield* command(
      "browser",
      "snapshot",
      "--aria",
      "--path",
      `browser-modifications/${name}.aria.txt`
    );
    yield* command(
      "browser",
      "screenshot",
      "--path",
      `browser-modifications/${name}.png`
    );
    yield* io(async () => {
      const source = await readFile(path.join(artifacts, `${name}.png`));
      await writeFile(path.join(screenshots, `${name}.png`), source);
    });
  });
await Effect.runPromise(
  Effect.gen(function* proveModifications() {
    yield* io(() => mkdir(artifacts, { recursive: true }));
    yield* io(() => mkdir(screenshots, { recursive: true }));
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
    const url = new URL("shop.html", instance.ecommerceUrl).href;
    const run = yield* program(
      "start",
      `const session = await tools.agent_run_start({inputs:[],referencedSkills:[],requestedTask:"Inspect browser modifications",url:${JSON.stringify(url)},operationId:"modifications-start",view:"compact"}); return {id:session.id,viewUrl:session.viewUrl};`
    );
    const sid = JSON.stringify(run.id);
    yield* command("browser", "goto", "--url", run.viewUrl);
    yield* command(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      "Workspace dock"
    );
    yield* capture("before");
    const changed = yield* program(
      "change",
      `const sessionId=${sid};
      await tools.agent_browser_devtools({sessionId,command:{action:"route_add",pattern:"**/mock-first",response:{action:"mock",status:200,contentType:"application/json",body:'{"fixture":"first"}'},operationId:"modifications-first"}});
      await tools.agent_browser_devtools({sessionId,command:{action:"route_add",pattern:"**/mock-second",response:{action:"mock",status:200,contentType:"text/plain",body:"second fixture response"},operationId:"modifications-second"}});
      await tools.agent_browser_devtools({sessionId,command:{action:"emulation_set",textScale:200,operationId:"modifications-scale"}});
      return tools.agent_browser_devtools({sessionId,command:{action:"modifications_list"}});`
    );
    assert.equal(changed.modifications.length, 3);
    yield* command("browser", "wait", "--text", "2 mocked routes · 200% text");
    yield* capture("active");
    yield* program(
      "remove",
      `return tools.agent_browser_devtools({sessionId:${sid},command:{action:"modification_remove",id:"modification-modifications-second",operationId:"modifications-remove"}});`
    );
    yield* command("browser", "wait", "--text", "1 mocked route · 200% text");
    yield* capture("removed");
    const summary = yield* program(
      "complete",
      `return tools.agent_run_complete({sessionId:${sid},operationId:"modifications-complete"});`
    );
    assert.equal(summary.browserModifications.length, 3);
    assert.ok(summary.browserModifications.every((entry) => entry.at));
    assert.ok(
      summary.browserModifications.find(
        (entry) => entry.id === "modification-modifications-second"
      ).removedAt
    );
    const reopened = yield* program(
      "reopen",
      `return tools.open_run({runId:${JSON.stringify(summary.runId)}});`
    );
    assert.deepEqual(
      reopened.summary.browserModifications,
      summary.browserModifications
    );
    yield* command("browser", "goto", "--url", reopened.viewUrl);
    yield* command(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      "Browser Modifications"
    );
    yield* capture("summary");
    const summaryAria = yield* io(() =>
      readFile(path.join(artifacts, "summary.aria.txt"), "utf-8")
    );
    assert.ok(summaryAria.includes("second fixture response"));
    const result = {
      ok: true,
      runId: summary.runId,
      screenshots,
      sessionId: run.id,
    };
    yield* io(() =>
      writeFile(
        path.join(artifacts, "result.json"),
        JSON.stringify(result, null, 2)
      )
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).pipe(
    Effect.ensuring(
      io(() =>
        writeFile(
          path.join(artifacts, "commands.json"),
          JSON.stringify(journal, null, 2)
        )
      )
    )
  )
);
