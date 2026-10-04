// Reproducible task-directed proof against a control-contingency-owned instance.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const here = import.meta.dirname;
const cliRoot = path.resolve(here, "../../../../packages/cli");
const { Effect } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("effect", { paths: [cliRoot] })
  ).href
);
const { NodeSocket } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("@effect/platform-node", {
      paths: [cliRoot],
    })
  ).href
);
const execute = promisify(execFile);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(
  directory,
  "Launch control-contingency and export CONTINGENCY_VERIFY_DIR first."
);
const artifacts = path.resolve(here, "../artifacts/task-proof");
const control = path.join(here, "control-contingency");
const io = (action) => Effect.tryPromise(action);
let sequence = 0;
const proofId = Date.now();
const journal = [];
const blockers = [];
// Per-tool call counts and answer sizes, the baseline every MCP efficiency
// change is measured against (ADR 0045).
const metrics = new Map();
const measure = (tool, stdout) => {
  const entry = metrics.get(tool) ?? { bytes: 0, calls: 0, maxBytes: 0 };
  const bytes = Buffer.byteLength(stdout);
  metrics.set(tool, {
    bytes: entry.bytes + bytes,
    calls: entry.calls + 1,
    maxBytes: Math.max(entry.maxBytes, bytes),
  });
};
const metricsReport = (extra) => {
  const byTool = Object.fromEntries(
    [...metrics].toSorted(([left], [right]) => left.localeCompare(right))
  );
  const totals = { bytes: 0, calls: 0 };
  for (const entry of metrics.values()) {
    totals.bytes += entry.bytes;
    totals.calls += entry.calls;
  }
  return { byTool, ...extra, totals };
};
const operation = () => `task-proof-${proofId}-${(sequence += 1)}`;
const secrets = ["disposable-flow-one-9F!", "disposable-flow-two-2G!"];
const record = (name, value) =>
  io(async () => {
    const text = JSON.stringify(value, null, 2);
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `Secret leaked in ${name}`);
    }
    await writeFile(path.join(artifacts, name), `${text}\n`);
  });
const command = (...args) =>
  io(async () => {
    journal.push({ args, entryPoint: "control-contingency" });
    const result = await execute("nub", [control, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout.trim();
  });
const call = (tool, params = {}, refusal = false) =>
  Effect.gen(function* callTool() {
    const publicParams = JSON.parse(
      JSON.stringify(params)
        .replaceAll(secrets[0], "<redacted>")
        .replaceAll(secrets[1], "<redacted>")
    );
    journal.push({ entryPoint: "mcp call", params: publicParams, tool });
    const result = yield* io(async () => {
      try {
        const { stdout } = await execute(
          "nub",
          [
            control,
            "mcp",
            "call",
            "--tool",
            tool,
            "--params",
            JSON.stringify(params),
          ],
          { maxBuffer: 8 * 1024 * 1024 }
        );
        return { exitCode: 0, stderr: "", stdout };
      } catch (error) {
        if (error.code !== 2) {
          throw error;
        }
        return {
          exitCode: error.code,
          stderr: error.stderr,
          stdout: error.stdout,
        };
      }
    });
    measure(tool, result.stdout);
    yield* record(`${String((sequence += 1)).padStart(3, "0")}-${tool}.json`, {
      params: publicParams,
      tool,
      ...result,
    });
    if (refusal === null) {
      return result;
    }
    assert.equal(result.exitCode, refusal ? 2 : 0, result.stdout);
    return refusal ? result.stdout : JSON.parse(result.stdout);
  });
const capture = (name, url) =>
  Effect.gen(function* captureWorkspace() {
    if (url) {
      yield* command("browser", "goto", "--url", url);
    }
    yield* command(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      url?.includes("?run=") ? "Run Summary" : "Workspace dock"
    );
    yield* command(
      "browser",
      "snapshot",
      "--aria",
      "--path",
      `task-proof/${name}.aria.txt`
    );
    yield* command("browser", "screenshot", "--path", `task-proof/${name}.png`);
    const aria = yield* io(() =>
      readFile(path.join(artifacts, `${name}.aria.txt`), "utf-8")
    );
    for (const secret of secrets) {
      assert.ok(!aria.includes(secret));
    }
    return aria;
  });
const click = (name) =>
  command("browser", "click", "--role", "button", "--name", name);
const snapshot = (sessionId) =>
  call("agent_browser_snapshot", { format: "structured", sessionId });
const act = (sessionId, action, extra = {}) =>
  call("agent_browser_act", {
    action,
    operationId: operation(),
    sessionId,
    ...extra,
  });
const target = (sessionId, name, text, type = "click") =>
  Effect.gen(function* actOnTarget() {
    const observed = yield* snapshot(sessionId);
    const node = observed.nodes.find((item) => item.name === name);
    assert.ok(node?.ref, `Missing ${name}: ${JSON.stringify(observed)}`);
    const action = { ref: node.ref, type };
    if (text !== undefined) {
      action.text = text;
    }
    return yield* act(sessionId, action);
  });
const complete = (sessionId) =>
  call("agent_run_complete", { operationId: operation(), sessionId });
const report = (
  sessionId,
  observed,
  outcome,
  outcomeComplete,
  tool = "agent_run_assess"
) => {
  const params = {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation: `Fixture observation: ${outcome}`,
    operationId: operation(),
    outcome,
    sessionId,
  };
  if (outcomeComplete !== undefined) {
    params.outcomeComplete = outcomeComplete;
  }
  return call(tool, params);
};
const rpc = (url, tag, data) =>
  Effect.callback((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(
      new URL("/ws", url).href.replace("http", "ws"),
      { origin: new URL(url).origin }
    );
    const timeout = setTimeout(() => {
      socket.close();
      resume(Effect.fail(new Error(`RPC timeout: ${tag}`)));
    }, 15_000);
    const finish = (effect) => {
      clearTimeout(timeout);
      socket.close();
      resume(effect);
    };
    socket.addEventListener("error", () =>
      finish(Effect.fail(new Error(`RPC socket failed: ${tag}`)))
    );
    socket.addEventListener("open", () =>
      socket.send(
        `${JSON.stringify({ _tag: "Request", headers: [], id: "1", payload: data, tag })}\n`
      )
    );
    socket.addEventListener("message", (event) => {
      for (const line of String(event.data).trim().split("\n")) {
        const message = JSON.parse(line);
        if (message._tag === "Exit") {
          if (message.exit._tag === "Success") {
            finish(Effect.succeed(message.exit.value));
          } else {
            finish(Effect.fail(new Error(JSON.stringify(message))));
          }
        }
      }
    });
    return Effect.sync(() => {
      clearTimeout(timeout);
      socket.close();
    });
  });
const browserState = (session) =>
  Effect.gen(function* readBrowserState() {
    const tabs = yield* rpc(session.viewUrl, "agent.browser.tabs.get", {
      sessionId: session.id,
    });
    const emulation = yield* rpc(
      session.viewUrl,
      "agent.browser.emulation.get",
      { sessionId: session.id }
    );
    const storage = [];
    for (const kind of ["cookies", "local", "session"]) {
      storage.push(
        yield* rpc(session.viewUrl, "agent.browser.storage.get", {
          kind,
          sessionId: session.id,
          tabId: tabs.tabs[0].tabId,
        })
      );
    }
    return { emulation, storage, tabs };
  });
const verifyCleanupFailure = (manifest, teachingUrl) =>
  Effect.gen(function* verifyRetainedCleanup() {
    yield* click("Verify flow");
    yield* command(
      "browser",
      "wait",
      "--role",
      "button",
      "--name",
      "Retry cleanup"
    );
    const pending = yield* manifest();
    assert.equal(pending.lifecycle._tag, "verified");
    assert.equal(pending.cleanup._tag, "purge-pending");
    assert.ok(pending.cleanup.failure);
    yield* record("cleanup-pending.json", {
      cleanup: pending.cleanup,
      lifecycle: pending.lifecycle._tag,
    });
    yield* capture("cleanup-pending", teachingUrl);
  });
const dryProof = (catalog, url) =>
  Effect.gen(function* proveDryRuns() {
    const teaching = yield* call("agent_session_start", {
      activity: "teaching",
      clientName: "verify",
      clientVersion: "1.0",
      name: "dry-proof",
      operationId: operation(),
      url,
      viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
    });
    yield* call("agent_teaching_setup_handoff", {
      operationId: operation(),
      sessionId: teaching.id,
    });
    yield* capture("teaching-setup", teaching.viewUrl);
    yield* click("Start recording");
    // A user-authored instruction gives this disposable recording its outcome.
    yield* call("agent_teaching_instruction_record", {
      operationId: operation(),
      sessionId: teaching.id,
      text: "Add an anvil to the cart. Stop with one cart item.",
    });
    yield* capture("teaching-recording");
    yield* click("Stop recording");
    let teachingState = yield* call("agent_session_get", {
      sessionId: teaching.id,
    });
    const { recordingId } = teachingState;
    assert.ok(recordingId);
    const claimOperationId = operation();
    yield* call("agent_teaching_recording_claim", {
      action: "take",
      operationId: claimOperationId,
      recordingId,
    });
    yield* call("agent_teaching_timeline_get", {
      claimOperationId,
      recordingId,
    });
    const files = [
      {
        content:
          "---\nname: dry-proof\ndescription: Add one anvil to the local cart.\ninputs:\n  - area\n---\n\n# Add an anvil\n\n1. Add an anvil for {{area}}.\n   Done when: Cart has 1 items is visible.\n",
        path: "SKILL.md",
      },
    ];
    const save = () =>
      call("agent_flow_skill_save", {
        claimOperationId,
        files,
        operationId: operation(),
        recordingId,
      });
    yield* save();
    const recordingDir = path.join(catalog, ".recordings", recordingId);
    const manifest = () =>
      io(async () =>
        JSON.parse(
          await readFile(path.join(recordingDir, "manifest.json"), "utf-8")
        )
      );
    const outcomes = [];
    for (const kind of [
      "partial",
      "failed",
      "takeover",
      "complete",
      "rejected-then-complete",
    ]) {
      const started = yield* call("agent_flow_skill_dry_run_start", {
        inputs: [
          { changed: true, name: "area", secret: false, value: "South" },
        ],
        operationId: operation(),
        recordingId,
        url,
      });
      const { session } = started;
      yield* capture(`dry-${kind}-live`, session.viewUrl);
      if (kind === "takeover") {
        yield* click("Take control");
        yield* capture("dry-takeover-intervention");
        yield* click("Return control");
      }
      let observed = yield* snapshot(session.id);
      if (!["partial", "failed"].includes(kind)) {
        yield* target(session.id, "Add anvil to cart");
        observed = yield* snapshot(session.id);
        assert.ok(
          observed.nodes.some((node) => node.name === "Cart has 1 items")
        );
      }
      yield* report(
        session.id,
        observed,
        kind === "failed" ? "not-working" : "working",
        kind !== "partial"
      );
      yield* complete(session.id);
      teachingState = yield* call("agent_session_get", {
        sessionId: teaching.id,
      });
      const passed = kind === "complete" || kind === "rejected-then-complete";
      assert.equal(
        teachingState.captureState._tag,
        passed ? "dry-run-passed" : "dry-run-failed"
      );
      const aria = yield* capture(`dry-${kind}-summary`, teaching.viewUrl);
      assert.equal(aria.includes('button "Verify flow"'), passed);
      const retained = yield* manifest();
      assert.ok(retained.artifacts.length > 0);
      for (const artifact of retained.artifacts) {
        assert.ok(
          (yield* io(() => stat(path.join(recordingDir, artifact.path)))).size >
            0
        );
      }
      yield* record(`dry-${kind}-retention.json`, {
        artifactKinds: retained.artifacts.map((artifact) => artifact.kind),
        cleanup: retained.cleanup,
        lifecycle: retained.lifecycle._tag,
        outcome: teachingState.captureState.dryRunResult,
      });
      outcomes.push({ kind, lifecycle: retained.lifecycle._tag });
      if (kind === "complete") {
        // Exercise the user's Workspace choice rather than relaying an invented conversation.
        yield* click("Reject flow");
        const rejected = yield* manifest();
        assert.equal(rejected.lifecycle._tag, "skill-drafted");
        assert.ok(rejected.artifacts.length > 0);
        yield* capture("dry-rejected");
      } else if (kind === "rejected-then-complete") {
        yield* command(
          "browser",
          "resize",
          "--width",
          "390",
          "--height",
          "844"
        );
        yield* capture("dry-verification-390");
        yield* command(
          "browser",
          "resize",
          "--width",
          "1440",
          "--height",
          "900"
        );
        // Make deletion fail after verification has been persisted. Only this
        // disposable directory is made read-only, never the catalog or manifest.
        const obstruction = path.join(recordingDir, "cleanup-obstruction");
        yield* io(async () => {
          await mkdir(obstruction);
          await writeFile(
            path.join(obstruction, "retained.txt"),
            "Disposable cleanup failure probe\n"
          );
          await chmod(obstruction, 0o555);
        });
        yield* verifyCleanupFailure(manifest, teaching.viewUrl).pipe(
          Effect.ensuring(io(() => chmod(obstruction, 0o755)))
        );
        yield* command("mcp", "stop");
        yield* command("mcp", "start");
        yield* io(async () => {
          await assert.rejects(stat(recordingDir), { code: "ENOENT" });
        });
        assert.ok(
          (yield* io(() =>
            readFile(
              path.join(catalog, "dry-proof", "references/verification.md"),
              "utf-8"
            )
          )).includes("- Verified:")
        );
        const listing = yield* call("agent_flow_skills_list", {}, null);
        if (listing.exitCode === 0) {
          assert.ok(
            JSON.parse(listing.stdout).flowSkills.some(
              (skill) => skill.name === "dry-proof"
            )
          );
        } else {
          blockers.push({
            attemptedTool: "agent_flow_skills_list",
            blocker: listing.stdout.trim(),
            featureId: "agent-teaching-flow-skill-learning",
            owningPhase: "#323",
          });
          yield* record("catalog-list-blocker.json", blockers.at(-1));
        }
      } else {
        yield* save();
      }
    }
    yield* record("dry-outcomes.json", outcomes);
  });
const reopenProof = (catalog, summary, fixtureUrl) =>
  Effect.gen(function* proveReopenedSummaries() {
    const legacyId = `agentrun-legacy-${proofId}`;
    const legacy = {
      assessmentCounts: {
        blocked: 0,
        inconclusive: 0,
        notWorking: 0,
        working: 1,
      },
      attribution: summary.attribution,
      ceilings: { extensions: 0, runMs: 120_000, stepMs: 60_000 },
      coverage: { complete: false, executed: 2, total: 3, unexecuted: 1 },
      endedAt: summary.endedAt,
      flowSkillName: "flow1",
      inputs: [],
      outcome: "timed-out",
      runId: legacyId,
      schemaVersion: 2,
      sessionId: summary.sessionId,
      startedAt: summary.startedAt,
      steps: [
        {
          assessment: { ...summary.assessment, attempts: 1 },
          attempts: 1,
          confirmation: false,
          description: "Read the cart",
          doneWhen: "The cart is visible",
          endedAt: summary.endedAt,
          execution: "assessed",
          index: 0,
          name: "Open cart",
          startedAt: summary.startedAt,
        },
        {
          assessment: null,
          attempts: 1,
          confirmation: true,
          description: "Wait for checkout",
          doneWhen: "Checkout is visible",
          endedAt: summary.endedAt,
          execution: "timed-out",
          index: 1,
          name: "Checkout timeout",
          startedAt: summary.startedAt,
        },
        {
          assessment: null,
          attempts: 0,
          confirmation: true,
          description: "Complete purchase",
          doneWhen: "Purchase is confirmed",
          endedAt: null,
          execution: "unexecuted",
          index: 2,
          name: "Unexecuted purchase",
          startedAt: null,
        },
      ],
      timeline: [],
      title: "Historical timeout fixture",
      tracePath: "run.trace.zip",
      videoPath: "run.webm",
    };
    const legacyDir = path.join(catalog, "agent-runs", legacyId);
    yield* io(async () => {
      await mkdir(legacyDir);
      await writeFile(
        path.join(legacyDir, "summary.json"),
        JSON.stringify(legacy)
      );
      await Promise.all(
        [
          [summary.videoPath, "run.webm"],
          [summary.tracePath, "run.trace.zip"],
        ].map(([source, file]) =>
          copyFile(
            path.join(catalog, "agent-runs", summary.runId, source),
            path.join(legacyDir, file)
          )
        )
      );
    });
    yield* record("legacy-fixture.json", {
      provenance:
        "Synthetic version 2 historical contract fixture with isolated Run video and Trace",
      summary: legacy,
    });
    const beforeRestart = yield* call("open_run", { runId: legacy.runId });
    assert.deepEqual(beforeRestart.summary, legacy);
    const exiting = yield* call("agent_run_start", {
      inputs: [],
      operationId: operation(),
      referencedSkills: [],
      requestedTask: "Leave this task unassessed at process exit",
      url: fixtureUrl,
    });
    yield* command("mcp", "stop");
    yield* command("mcp", "start");
    const exitSummary = JSON.parse(
      yield* io(() =>
        readFile(
          path.join(catalog, "agent-runs", exiting.run.runId, "summary.json"),
          "utf-8"
        )
      )
    );
    assert.equal(exitSummary.outcome, "process-exited");
    assert.equal(exitSummary.assessment, null);
    yield* record("process-exit-summary.json", exitSummary);
    for (const [name, expected] of [
      ["task", summary],
      ["historical", legacy],
    ]) {
      const viewer = yield* call("open_run", { runId: expected.runId });
      assert.deepEqual(viewer.summary, expected);
      const aria = yield* capture(`${name}-reopened`, viewer.viewUrl);
      assert.ok(aria.includes('region "Run video"'));
      if (name === "historical") {
        assert.ok(
          aria.includes("Checkout timeout") &&
            aria.includes("Unexecuted purchase")
        );
        assert.ok(aria.includes("timed-out"));
      }
      // A Run's video is condensed after its Summary is written, so wait for
      // it to be ready before reading bytes.
      const status = yield* Effect.gen(function* waitForVideo() {
        const deadline = Date.now() + 120_000;
        for (;;) {
          const response = yield* io(() =>
            fetch(
              new URL(
                `/agent-runs/${expected.runId}/video/status`,
                viewer.viewUrl
              )
            )
          );
          assert.equal(response.status, 200);
          const body = yield* io(() => response.json());
          if (body.state !== "preparing") {
            return body;
          }
          assert.ok(Date.now() < deadline, "The Run video never became ready.");
          yield* Effect.sleep("250 millis");
        }
      });
      assert.equal(status.state, "ready");
      yield* record(`${name}-reopened-video-status.json`, status);
      const video = yield* io(async () => {
        const response = await fetch(
          new URL(`/agent-runs/${expected.runId}/video`, viewer.viewUrl),
          { headers: { Range: "bytes=0-1023" } }
        );
        assert.equal(response.status, 206);
        const buffer = await response.arrayBuffer();
        const bytes = buffer.byteLength;
        assert.equal(bytes, 1024);
        return {
          bytes,
          contentType: response.headers.get("content-type"),
          status: response.status,
        };
      });
      yield* record(`${name}-reopened-video.json`, video);
    }
  });
const main = Effect.gen(function* main() {
  yield* io(async () => {
    try {
      await rename(artifacts, `${artifacts}-previous-${proofId}`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(artifacts, { recursive: true });
  });
  yield* record("result.json", { proofId, status: "running" });
  yield* record("doctor.json", JSON.parse(yield* command("doctor")));
  const instance = JSON.parse(
    yield* io(() => readFile(path.join(directory, "instance.json"), "utf-8"))
  );
  assert.equal(instance.stateDir, path.join(directory, "state"));
  assert.ok(
    instance.mcpUrl && instance.ecommerceUrl,
    "Start MCP and ecommerce first."
  );
  const catalog = path.join(instance.stateDir, "catalog");
  const url = new URL("continuity.html", instance.ecommerceUrl).href;
  const secondUrl = url.replace("127.0.0.1", "localhost");
  yield* io(async () => {
    const response = await fetch(secondUrl);
    assert.equal(response.status, 200);
  });
  for (const [name, width, host] of [
    ["flow1", 640, "127.0.0.1"],
    ["flow2", 390, "localhost"],
  ]) {
    const skill = path.join(catalog, name);
    yield* io(async () => {
      await mkdir(path.join(skill, "references"), { recursive: true });
      await writeFile(
        path.join(skill, "SKILL.md"),
        `---\nname: ${name}\ndescription: Exercise the local cart and help page.\ninputs:\n  - area\n  - PASSWORD\n  - UNUSED\nhosts:\n  - ${host}\nemulation:\n  userAgentProfile: default\n  viewport: ${width}x480@1\n---\n\n# ${name}\n\n1. Sign in using {{PASSWORD}}.\n   Done when: Signed in is visible.\n2. Add an anvil and open help, using {{area}} when requested.\n   Done when: The cart has one item and help is open.\n3. Continue the rest of the skill when requested using {{UNUSED}}.\n   Done when: The requested continuation is complete.\n`
      );
      await writeFile(
        path.join(skill, "references/verification.md"),
        "- Verified: 2026-10-01T00:00:00.000Z\n"
      );
    });
  }
  const start = (requestedTask, referencedSkills) =>
    call("agent_run_start", {
      inputs: [],
      operationId: operation(),
      referencedSkills,
      requestedTask,
      url,
    });
  const zero = yield* start("Inspect the local shop without a skill", []);
  assert.equal(zero.run.schemaVersion, 3);
  assert.equal(zero.pendingDecisions.length, 0);
  assert.ok(!("steps" in zero.run) && !("coverage" in zero.run));
  yield* capture("zero-skill", zero.viewUrl);
  const paused = yield* act(zero.id, { type: "navigate", url: secondUrl });
  assert.equal(paused.intervention.reason, "domain");
  let state = yield* call("agent_session_get", { sessionId: zero.id });
  yield* capture("domain-paused");
  yield* call("agent_pending_decision_resolve", {
    decision: "refuse",
    operationId: operation(),
    pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
  });
  state = yield* call("agent_run_update", {
    inputs: [],
    operationId: operation(),
    referencedSkills: ["flow2"],
    sessionId: zero.id,
  });
  assert.equal(state.id, zero.id);
  yield* act(zero.id, { type: "navigate", url: secondUrl });
  const unrelated = yield* act(
    zero.id,
    { type: "navigate", url: secondUrl },
    {
      intent: {
        objective: "Start an unrelated purchase",
        objectiveKind: "new",
      },
    }
  );
  assert.equal(unrelated.intervention.reason, "objective");
  state = yield* call("agent_session_get", { sessionId: zero.id });
  yield* call("agent_pending_decision_resolve", {
    decision: "refuse",
    operationId: operation(),
    pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
  });
  const outside = yield* act(zero.id, {
    type: "navigate",
    url: url.replace("127.0.0.1", "127.0.0.2"),
  });
  assert.equal(outside.intervention.reason, "domain");
  state = yield* call("agent_session_get", { sessionId: zero.id });
  yield* call("agent_pending_decision_resolve", {
    decision: "refuse",
    operationId: operation(),
    pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
  });
  yield* complete(zero.id);

  const session = yield* start(
    "Execute flow1 until the cart, then flow2 from there",
    ["flow1"]
  );
  assert.equal(session.run.startingEmulation.viewport.width, 640);
  assert.equal(session.pendingDecisions.length, 0);
  yield* target(session.id, "Sign in");
  yield* target(session.id, "Add anvil to cart");
  yield* target(session.id, "Open help tab");
  const before = yield* browserState(session);
  yield* record("continuity-before.json", before);
  const updated = yield* call("agent_run_update", {
    inputs: [
      { flowSkillName: "flow1", name: "area", value: "North" },
      { flowSkillName: "flow2", name: "area", value: "South" },
    ],
    instruction: "Keep the cart and use flow2 help, then recover and stop",
    operationId: operation(),
    referencedSkills: ["flow2"],
    sessionId: session.id,
  });
  assert.equal(updated.id, session.id);
  assert.equal(updated.run.runId, session.run.runId);
  assert.deepEqual(
    updated.run.startingEmulation,
    session.run.startingEmulation
  );
  const after = yield* browserState(session);
  assert.deepEqual(after, before);
  assert.equal(before.tabs.tabs.length, 2);
  yield* record("continuity-after.json", after);
  yield* capture("composed", session.viewUrl);
  yield* click("Task details");
  yield* capture("composed-details");
  yield* command("browser", "press", "--key", "Escape");
  yield* command("browser", "resize", "--width", "390", "--height", "844");
  yield* capture("composed-390");
  yield* command("browser", "resize", "--width", "1440", "--height", "900");
  let observed = yield* snapshot(session.id);
  yield* report(session.id, observed, "not-working");
  yield* report(
    session.id,
    observed,
    "not-working",
    undefined,
    "agent_run_finding"
  );
  observed = yield* snapshot(session.id);
  yield* target(session.id, "Flow one area", "North", "fill");
  yield* target(session.id, "Flow two area", "South", "fill");
  observed = yield* snapshot(session.id);
  yield* report(session.id, observed, "working");
  yield* call(
    "agent_run_assess",
    {
      evidence: [{ id: "fabricated", kind: "snapshot" }],
      explanation: "Invalid evidence must fail",
      operationId: operation(),
      outcome: "working",
      sessionId: session.id,
    },
    true
  );
  for (const [index, flowSkillName] of ["flow1", "flow2"].entries()) {
    state = yield* call("agent_variable_request", {
      flowSkillName,
      name: "PASSWORD",
      operationId: operation(),
      sessionId: session.id,
    });
    yield* capture(`${flowSkillName}-pending`);
    if (index === 0) {
      yield* call("agent_pending_decision_resolve", {
        decision: "refuse",
        operationId: operation(),
        pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
      });
      yield* capture("flow1-refused");
      state = yield* call("agent_variable_request", {
        flowSkillName,
        name: "PASSWORD",
        operationId: operation(),
        sessionId: session.id,
      });
    }
    const supply = {
      decision: "supply",
      operationId: operation(),
      pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
      value: secrets[index],
    };
    const supplied = yield* call("agent_pending_decision_resolve", supply);
    assert.deepEqual(
      yield* call("agent_pending_decision_resolve", supply),
      supplied
    );
    observed = yield* snapshot(session.id);
    yield* call("agent_variable_enter", {
      flowSkillName,
      name: "PASSWORD",
      operationId: operation(),
      ref: observed.nodes.find((node) => node.name === "Password").ref,
      sessionId: session.id,
    });
  }
  state = yield* call("agent_session_get", { sessionId: session.id });
  assert.equal(
    state.run.inputs.filter((input) => input.name === "area").length,
    2
  );
  assert.ok(
    state.run.variables
      .filter((variable) => variable.name === "PASSWORD")
      .every((variable) => variable.supplied)
  );
  assert.ok(
    state.run.variables
      .filter((variable) => variable.name === "UNUSED")
      .every((variable) => !variable.supplied)
  );
  yield* capture("scoped-supplied");
  yield* click("Take control");
  yield* capture("takeover");
  yield* call(
    "agent_browser_act",
    {
      action: { type: "navigate", url },
      operationId: operation(),
      sessionId: session.id,
    },
    true
  );
  yield* snapshot(session.id);
  yield* click("Return control");
  yield* capture("returned");
  observed = yield* snapshot(session.id);
  assert.ok(observed.nodes.some((node) => node.name === "Cart has 1 items"));
  // Confirmation is granted per attempt; replay must not add another cart item.
  const confirmation = {
    action: {
      ref: observed.nodes.find((node) => node.name === "Add anvil to cart").ref,
      type: "click",
    },
    intent: { irreversible: true },
    operationId: operation(),
    sessionId: session.id,
  };
  const boundary = yield* call("agent_browser_act", confirmation);
  assert.equal(boundary.intervention.reason, "confirmation");
  state = yield* call("agent_session_get", { sessionId: session.id });
  yield* capture("confirmation");
  yield* click("Take control");
  yield* capture("confirmation-takeover");
  yield* call(
    "agent_pending_decision_resolve",
    {
      decision: "allow",
      operationId: operation(),
      pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
    },
    true
  );
  yield* click("Return control");
  yield* call("agent_pending_decision_resolve", {
    decision: "allow",
    operationId: operation(),
    pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
  });
  const attempted = yield* call("agent_browser_act", confirmation);
  assert.deepEqual(yield* call("agent_browser_act", confirmation), attempted);
  const repeated = yield* call("agent_browser_act", {
    ...confirmation,
    operationId: operation(),
  });
  assert.equal(repeated.intervention.reason, "confirmation");
  state = yield* call("agent_session_get", { sessionId: session.id });
  const compactState = yield* call("agent_session_get", {
    sessionId: session.id,
    view: "compact",
  });
  assert.equal(compactState.view, "compact");
  assert.deepEqual(compactState.pendingDecisions, state.pendingDecisions);
  const sessionViewBytes = {
    compact: JSON.stringify(compactState).length,
    full: JSON.stringify(state).length,
  };
  yield* call("agent_pending_decision_resolve", {
    decision: "refuse",
    operationId: operation(),
    pendingDecisionId: state.pendingDecisions[0].pendingDecisionId,
  });
  const completion = { operationId: operation(), sessionId: session.id };
  const summary = yield* call("agent_run_complete", completion);
  assert.deepEqual(yield* call("agent_run_complete", completion), summary);
  const persisted = JSON.parse(
    yield* io(() =>
      readFile(
        path.join(catalog, "agent-runs", summary.runId, "summary.json"),
        "utf-8"
      )
    )
  );
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.findings.length, 1);
  assert.equal(persisted.instructions.length, 1);
  assert.ok(persisted.videoPath && persisted.tracePath);
  yield* record("persisted-task-summary.json", persisted);
  yield* record("run-ids.json", { task: summary.runId, zero: zero.run.runId });
  const viewer = yield* call("open_run", { runId: summary.runId });
  yield* capture("task-summary", viewer.viewUrl);
  const closed = yield* start(
    "Close this task without submitting an assessment",
    []
  );
  yield* call("agent_session_close", {
    operationId: operation(),
    sessionId: closed.id,
  });
  const closedViewer = yield* call("open_run", { runId: closed.run.runId });
  assert.equal(closedViewer.summary.outcome, "user-closed");
  assert.equal(closedViewer.summary.assessment, null);
  yield* capture("unassessed-closed", closedViewer.viewUrl);
  yield* dryProof(catalog, url);
  yield* reopenProof(catalog, summary, url);
  const measured = metricsReport({ sessionViewBytes });
  yield* record("metrics.json", measured);
  yield* record("result.json", {
    blockers,
    features: [
      "zero-skill",
      "domain-scope",
      "later-skill-host",
      "composition",
      "starting-emulation",
      "tabs-storage-cookie",
      "redirection",
      "finding-recovery",
      "scoped-inputs",
      "lazy-secrets",
      "takeover",
      "confirmation",
      "operation-replay",
      "explicit-completion",
      "persisted-summary",
      "dry-run-outcomes",
      "user-verify-reject",
      "cleanup-resumption",
      "summary-restart",
      "historical-schema-fixture",
      "video-range-serving",
      "user-closure",
      "process-exit",
      "compact-session-view",
    ],
    metrics: measured.totals,
    proofId,
    status: blockers.length > 0 ? "blocked" : "passed",
    taskRunId: summary.runId,
  });
  process.stdout.write(
    `Task proof finished with ${blockers.length} blockers. Evidence: ${artifacts}\n`
  );
  process.exitCode = blockers.length === 0 ? 0 : 2;
});
await Effect.runPromise(
  main.pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure"
        ? record("result.json", { proofId, status: "failed" })
        : Effect.void
    ),
    Effect.ensuring(record("commands.json", journal))
  )
);
