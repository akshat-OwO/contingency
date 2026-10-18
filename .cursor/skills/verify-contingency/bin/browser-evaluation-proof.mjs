// Prove evaluation through the code tool and Workspace Confirmation controls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  "../artifacts/browser-evaluation"
);
const evidence = process.env.CONTINGENCY_EVAL_EVIDENCE ?? artifacts;
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
const program = (name, code, status = "completed") =>
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
    assert.equal(result.status, status, JSON.stringify(result));
    return status === "completed" ? result.value : result;
  });
const capture = (name) =>
  Effect.gen(function* captureWorkspace() {
    yield* command(
      "browser",
      "snapshot",
      "--aria",
      "--path",
      `browser-evaluation/${name}.aria.txt`
    );
    yield* command(
      "browser",
      "screenshot",
      "--path",
      `browser-evaluation/${name}.png`
    );
    if (evidence !== artifacts) {
      yield* io(() =>
        copyFile(
          path.join(artifacts, `${name}.png`),
          path.join(evidence, `${name}.png`)
        )
      );
      yield* io(() =>
        copyFile(
          path.join(artifacts, `${name}.aria.txt`),
          path.join(evidence, `${name}.aria.txt`)
        )
      );
    }
  });
await Effect.runPromise(
  Effect.gen(function* proveEvaluation() {
    yield* io(() => mkdir(artifacts, { recursive: true }));
    yield* io(() => mkdir(evidence, { recursive: true }));
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
    const url = new URL("eval.html", instance.ecommerceUrl).href;
    const run = yield* program(
      "start",
      `const s = await tools.agent_run_start({inputs:[],referencedSkills:[],requestedTask:"Inspect the disposable account and confirm each delete attempt",url:${JSON.stringify(url)},operationId:"eval-proof-start",view:"compact"}); return {id:s.id,viewUrl:s.viewUrl};`
    );
    const sid = JSON.stringify(run.id);
    const evaluate = (operationId, mode, script) =>
      `return tools.agent_browser_devtools({sessionId:${sid},command:${JSON.stringify({ action: "eval", mode, operationId, script })}});`;
    yield* command("browser", "goto", "--url", run.viewUrl);
    yield* command(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      "Workspace dock"
    );
    const style = yield* program(
      "computed-style",
      evaluate(
        "eval-proof-style",
        "read_only",
        "getComputedStyle(document.body).display"
      )
    );
    assert.deepEqual(style, {
      failed: false,
      text: '"block"',
      truncated: false,
    });
    const before = yield* program(
      "no-pause",
      `return tools.agent_session_get({sessionId:${sid},view:"compact"});`
    );
    assert.equal(before.pendingDecisions.length, 0);
    yield* capture("read-only");
    const click = "document.querySelector('#delete-account').click()";
    const paused = yield* program(
      "delete-paused",
      evaluate("eval-proof-delete", "mutating", click),
      "intervention"
    );
    assert.ok(paused.intervention.reasons.includes("pending_decision"));
    const { boundaryId } = paused.intervention.pending.find(
      (item) => item.kind === "boundary"
    );
    yield* command("browser", "wait", "--role", "button", "--name", "Allow");
    yield* capture("pending-decision");
    yield* command("browser", "click", "--role", "button", "--name", "Allow");
    yield* program(
      "delete-allowed",
      `return tools.agent_browser_resume({sessionId:${sid},boundaryId:${JSON.stringify(boundaryId)}});`
    );
    yield* program(
      "delete-replay",
      evaluate("eval-proof-delete", "mutating", click)
    );
    const count = yield* program(
      "delete-count",
      evaluate(
        "eval-proof-count",
        "read_only",
        "document.querySelector('#attempts').textContent"
      )
    );
    assert.equal(count.text, '"Delete attempts: 1"');
    yield* command("browser", "wait", "--text", "1 evaluation");
    yield* capture("confirmed-once");
    const outside = new URL(url);
    outside.hostname = "localhost";
    const fetchPause = yield* program(
      "fetch-paused",
      evaluate(
        "eval-proof-fetch",
        "mutating",
        `fetch(${JSON.stringify(outside.href)})`
      ),
      "intervention"
    );
    yield* command("browser", "wait", "--role", "button", "--name", "Allow");
    yield* command("browser", "click", "--role", "button", "--name", "Allow");
    const fetchBoundary = fetchPause.intervention.pending.find(
      (item) => item.kind === "boundary"
    ).boundaryId;
    const blocked = yield* program(
      "fetch-blocked",
      `return tools.agent_browser_resume({sessionId:${sid},boundaryId:${JSON.stringify(fetchBoundary)}});`
    );
    assert.equal(blocked.evaluation.failed, true);
    assert.ok(blocked.evaluation.text.includes("outside the Domain Scope"));
    const summary = yield* program(
      "complete",
      `return tools.agent_run_complete({sessionId:${sid},operationId:"eval-proof-complete"});`
    );
    const reopened = yield* program(
      "reopen",
      `return tools.open_run({runId:${JSON.stringify(summary.runId)}});`
    );
    assert.deepEqual(
      reopened.summary.browserModifications,
      summary.browserModifications
    );
    assert.equal(
      summary.browserModifications.filter((item) => item.kind === "eval")
        .length,
      2
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
    const result = {
      evidence,
      feature: "browser-evaluation",
      ok: true,
      runId: summary.runId,
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
