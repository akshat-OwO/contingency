// Prove tabs, downloads, uploads, clipboard, and profiling through the code tool.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
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
  "../artifacts/browser-tools"
);
const evidence = process.env.CONTINGENCY_TOOLS_EVIDENCE ?? artifacts;
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
      `browser-tools/${name}.aria.txt`
    );
    yield* command(
      "browser",
      "screenshot",
      "--path",
      `browser-tools/${name}.png`
    );
    if (evidence !== artifacts) {
      for (const file of [`${name}.png`, `${name}.aria.txt`]) {
        yield* io(() =>
          copyFile(path.join(artifacts, file), path.join(evidence, file))
        );
      }
    }
  });
await Effect.runPromise(
  Effect.gen(function* proveBrowserTools() {
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
    const catalog = path.join(instance.stateDir, "catalog");
    const inside = path.join(catalog, "tools-receipt.txt");
    const outsideDir = path.join(
      os.tmpdir(),
      `contingency-tools-${process.pid}`
    );
    const outside = path.join(outsideDir, "outside-receipt.txt");
    yield* io(() => mkdir(catalog, { recursive: true }));
    yield* io(() => mkdir(outsideDir, { recursive: true }));
    yield* io(() => writeFile(inside, "hello"));
    yield* io(() => writeFile(outside, "outside!"));
    const url = new URL("tools.html", instance.ecommerceUrl).href;
    const run = yield* program(
      "start",
      `const s = await tools.agent_run_start({inputs:[],referencedSkills:[],requestedTask:"Use tabs, downloads, uploads, clipboard, and profiling",url:${JSON.stringify(url)},operationId:"tools-proof-start",view:"compact"}); return {id:s.id,viewUrl:s.viewUrl};`
    );
    const sid = JSON.stringify(run.id);
    const devtools = (request, tabId) =>
      `return tools.agent_browser_devtools({sessionId:${sid},command:${JSON.stringify(request)}${tabId === undefined ? "" : `,tabId:${JSON.stringify(tabId)}`}});`;
    const click = (operationId, role, name) =>
      `const snap = await tools.agent_browser_snapshot({sessionId:${sid},format:"structured"}); const node = snap.nodes.find((n) => n.role === ${JSON.stringify(role)} && n.name.includes(${JSON.stringify(name)})); return tools.agent_browser_act({sessionId:${sid},operationId:${JSON.stringify(operationId)},action:{type:"click",ref:node.ref}});`;
    yield* command("browser", "goto", "--url", run.viewUrl);
    yield* command(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      "Workspace dock"
    );

    // A popup the page opens appears in the agent's tab list and the Workspace.
    yield* program(
      "open-popup",
      click("tools-proof-popup", "button", "Open popup")
    );
    const tabs = yield* program("tabs", devtools({ action: "tabs" }));
    assert.equal(tabs.tabs.length, 2, JSON.stringify(tabs));
    const popup = tabs.tabs.find((tab) => tab.url.includes("cart.html"));
    assert.ok(popup, "The popup is listed.");
    yield* program(
      "switch",
      devtools(
        { action: "tab_switch", operationId: "tools-proof-switch" },
        popup.tabId
      )
    );
    yield* capture("tabs");
    const opener = tabs.tabs.find((tab) => tab.tabId !== popup.tabId);
    yield* program(
      "close",
      devtools(
        { action: "tab_close", operationId: "tools-proof-close" },
        popup.tabId
      )
    );
    yield* program(
      "back",
      devtools(
        { action: "tab_switch", operationId: "tools-proof-back" },
        opener.tabId
      )
    );

    // A download is saved into the Run's evidence.
    yield* program(
      "download",
      click("tools-proof-download", "link", "Download report")
    );
    const downloads = yield* program(
      "downloads",
      `for (let attempt = 0; attempt < 20; attempt += 1) { const listed = await tools.agent_browser_devtools({sessionId:${sid},command:{action:"downloads"}}); if (listed.downloads.length > 0) return listed; await tools.agent_session_get({sessionId:${sid},view:"compact",waitMs:500}); } return {downloads:[]};`
    );
    const [report] = downloads.downloads;
    assert.equal(report?.name, "report.csv");
    assert.equal(report.type, "text/csv");
    assert.equal(report.size, 19);
    assert.ok(report.path.startsWith(path.join(catalog, "agent-runs")));
    assert.equal((yield* io(() => stat(report.path))).size, 19);

    // Catalog Root uploads go straight in; other paths wait for Allow.
    const fileRef = `const snap = await tools.agent_browser_snapshot({sessionId:${sid},format:"structured"}); const ref = snap.nodes.find((n) => n.role === "textbox" && n.name.includes("Receipt")).ref;`;
    yield* program(
      "upload-inside",
      `${fileRef} return tools.agent_browser_devtools({sessionId:${sid},command:{action:"upload",operationId:"tools-proof-upload-inside",ref,paths:[${JSON.stringify(inside)}]}});`
    );
    const paused = yield* program(
      "upload-outside",
      `${fileRef} return tools.agent_browser_devtools({sessionId:${sid},command:{action:"upload",operationId:"tools-proof-upload-outside",ref,paths:[${JSON.stringify(outside)}]}});`,
      "intervention"
    );
    const { boundaryId } = paused.intervention.pending.find(
      (item) => item.kind === "boundary"
    );
    yield* command("browser", "wait", "--role", "button", "--name", "Allow");
    yield* capture("upload-confirmation");
    yield* command("browser", "click", "--role", "button", "--name", "Allow");
    yield* program(
      "upload-allowed",
      `return tools.agent_browser_resume({sessionId:${sid},boundaryId:${JSON.stringify(boundaryId)}});`
    );
    const chosen = yield* program(
      "chosen",
      devtools({
        action: "eval",
        mode: "read_only",
        operationId: "tools-proof-chosen",
        script: "document.querySelector('#chosen').textContent",
      })
    );
    assert.equal(chosen.text, '"outside-receipt.txt:8"');

    // Clipboard writes are reversible Browser Modifications.
    yield* program(
      "clipboard-write",
      devtools({
        action: "clipboard_write",
        operationId: "tools-proof-clipboard",
        text: "agent clipboard text",
      })
    );
    const clipboard = yield* program(
      "clipboard-read",
      devtools({ action: "clipboard_read" })
    );
    assert.equal(clipboard.text, "agent clipboard text");

    // A CPU profile stops into a local file.
    yield* program(
      "profile-start",
      devtools({
        action: "profile_start",
        kind: "cpu",
        operationId: "tools-proof-cpu-start",
      })
    );
    const profile = yield* program(
      "profile-stop",
      devtools({
        action: "profile_stop",
        kind: "cpu",
        operationId: "tools-proof-cpu-stop",
      })
    );
    assert.equal(profile.format, "cpuprofile");
    assert.ok(
      JSON.parse(yield* io(() => readFile(profile.path, "utf-8"))).nodes
    );
    yield* command("browser", "wait", "--text", "2 uploads · clipboard");
    yield* capture("active");

    const summary = yield* program(
      "complete",
      `return tools.agent_run_complete({sessionId:${sid},operationId:"tools-proof-complete"});`
    );
    const reopened = yield* program(
      "reopen",
      `return tools.open_run({runId:${JSON.stringify(summary.runId)}});`
    );
    const kinds = reopened.summary.browserModifications.map(
      (item) => item.kind
    );
    assert.deepEqual(kinds.toSorted(), ["clipboard", "upload", "upload"]);
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
      download: report,
      evidence,
      feature: "browser-tools",
      ok: true,
      profile: profile.path,
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
