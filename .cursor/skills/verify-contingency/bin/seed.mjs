// Puts a control-contingency instance into every Workspace state the #744
// prototype walks through, through the real server (#785), and captures each
// state beside its prototype counterpart.
//
//   control-contingency seed [--only <name,...>] [--android] [--ios]
//   control-contingency seed capture [--only <name,...>] [--prototype <url>] [--path <dir>]
//
// Seeding drives the same paths a user and an agent use: MCP operations
// through the broker, Workspace actions through the driver, and Flow files in
// the isolated Catalog Root. Nothing is mocked in the Workspace.
/* oxlint-disable no-await-in-loop -- Seeded sessions, gestures and captures are sequential. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runDirectory } from "./catalog-paths.mjs";
import { nativeSeeding } from "./seed-native.mjs";

const here = import.meta.dirname;
const control = path.join(here, "control-contingency");
const cliRoot = path.resolve(here, "../../../../packages/cli");
const artifactsRoot = path.resolve(here, "../artifacts");
const execute = promisify(execFile);

// Seed verification through the CLI's own stamp so its digests match (ADR 0071).
const { stampFlowVerification } = await import(
  pathToFileURL(path.join(cliRoot, "src/services/flow-package.ts")).href
);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const parseFlags = (argv) => {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[token.slice(2)] = true;
      } else {
        flags[token.slice(2)] = next;
        index += 1;
      }
    } else {
      rest.push(token);
    }
  }
  return { flags, rest };
};

const directory = process.env.CONTINGENCY_VERIFY_DIR?.trim();
if (!directory) {
  fail("Launch control-contingency and export CONTINGENCY_VERIFY_DIR first.");
}
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
if (!instance.mcpUrl || !instance.ecommerceUrl) {
  fail("seed needs `ecommerce start` and `mcp start` on this instance first.");
}
const seedDir = path.join(directory, "seed");
const manifestPath = path.join(seedDir, "manifest.json");
const catalog = path.join(instance.stateDir, "catalog");
const globalCatalog = path.join(instance.stateDir, "global-catalog");
const shop = new URL("shop.html", instance.ecommerceUrl).href;
// The continuity shop has one `Add anvil to cart` button and a `Cart has <n> items` line.
const store = new URL("continuity.html", instance.ecommerceUrl).href;
const fixture = (page) => new URL(page, instance.ecommerceUrl).href;
const mcpPage = (pathname) => new URL(pathname, instance.mcpUrl).href;
const viewport = { deviceScaleFactor: 1, height: 800, width: 1280 };
const client = { clientName: "seed", clientVersion: "1.0" };

class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefusalError";
  }
}

const run = async (args) => {
  try {
    const { stdout } = await execute(process.execPath, [control, ...args], {
      env: { ...process.env, CONTINGENCY_VERIFY_DIR: directory },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (error.code === 2) {
      throw new RefusalError(
        `${args.join(" ")}: ${String(error.stdout).trim()}`
      );
    }
    throw new Error(
      `${args.join(" ")} failed: ${String(error.stderr || error.stdout || error.message).trim()}`,
      { cause: error }
    );
  }
};

let sequence = 0;
const stamp = Date.now().toString(36);
const operation = (label) => `seed-${stamp}-${label}-${(sequence += 1)}`;
const call = async (tool, params = {}) =>
  JSON.parse(
    await run([
      "mcp",
      "call",
      "--tool",
      tool,
      "--params",
      JSON.stringify(params),
    ])
  );

const flagArgs = (flags) =>
  Object.entries(flags).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, String(value)]
  );
const browser = (action, flags = {}) =>
  run(["browser", action, ...flagArgs(flags)]);
const goto = (url) => browser("goto", { url });
const click = (role, name, extra = {}) =>
  browser("click", { name, role, ...extra });
const waitFor = (role, name, extra = {}) =>
  role === "text"
    ? browser("wait", { text: name, "timeout-ms": 30_000, ...extra })
    : browser("wait", { name, role, "timeout-ms": 30_000, ...extra });

// ---------------------------------------------------------------------------
// Shared prerequisites. Each runs at most once per seed.

const memo = new Map();
const once = (key, build) => {
  if (!memo.has(key)) {
    memo.set(key, build());
  }
  return memo.get(key);
};

const flowDocument = ({ name, description, inputs = [], steps }) =>
  `---\nname: ${name}\ndescription: ${description}\n${
    inputs.length > 0
      ? `inputs:\n${inputs.map((input) => `  - ${input}\n`).join("")}`
      : ""
  }hosts:\n  - 127.0.0.1\nemulation:\n  userAgentProfile: default\n  viewport: 1280x800@1\n---\n\n# ${name}\n\n${steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.do}\n   Done when: ${step.doneWhen}\n`
    )
    .join("")}`;

const writeVerifiedFlow = async (root, flow) => {
  const dir = path.join(root, flow.name);
  await mkdir(path.join(dir, "references"), { recursive: true });
  const file = path.join(dir, "flow.md");
  await writeFile(
    file,
    stampFlowVerification(flowDocument(flow), {
      completedAt: "2026-11-02",
      inputs: [],
      observableOutcome: flow.steps.at(-1).doneWhen,
      outcome: "passed",
      platform: "web",
      verifiedAt: "2026-11-02",
    })
  );
};

const seededFlows = () =>
  once("flows", async () => {
    await writeVerifiedFlow(catalog, {
      description: "Browse the local catalogue and add an anvil to the cart.",
      name: "browse-catalogue",
      steps: [
        { do: "Open the catalogue.", doneWhen: "Products are listed." },
        {
          do: "Add an anvil to the cart.",
          doneWhen: "Cart has 1 items is visible.",
        },
      ],
    });
    await writeVerifiedFlow(catalog, {
      description: "Sign in to the local shop with the account password.",
      inputs: ["PASSWORD"],
      name: "sign-in",
      steps: [
        {
          do: "Sign in using {{PASSWORD}}.",
          doneWhen: "Signed in is visible.",
        },
      ],
    });
    await writeVerifiedFlow(globalCatalog, {
      description: "Sign in with single sign-on before any other Flow.",
      name: "sso-sign-in",
      steps: [
        { do: "Choose single sign-on.", doneWhen: "Signed in is visible." },
      ],
    });
    const listed = await call("agent_flows_list", {});
    for (const name of ["browse-catalogue", "sign-in"]) {
      if (listed.flows.find((flow) => flow.name === name)?.verified !== true) {
        throw new Error(
          `Seeded Flow ${name} is not Verified: ${JSON.stringify(listed)}`
        );
      }
    }
  });

const snapshot = (sessionId) =>
  call("agent_browser_snapshot", { format: "structured", sessionId });
const act = (sessionId, action, extra = {}) =>
  call("agent_browser_act", {
    action,
    operationId: operation("act"),
    sessionId,
    ...extra,
  });
const actOn = async (sessionId, name, { text, type = "click" } = {}) => {
  const observed = await snapshot(sessionId);
  const node = observed.nodes.find((item) => item.name === name);
  if (!node?.ref) {
    throw new Error(`No node named ${name} in ${sessionId}`);
  }
  const action = { ref: node.ref, type };
  if (text !== undefined) {
    action.text = text;
  }
  return act(sessionId, action);
};
const assess = async (sessionId, outcome, outcomeComplete, explanation) => {
  const observed = await snapshot(sessionId);
  const params = {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation,
    operationId: operation("assess"),
    outcome,
    sessionId,
  };
  if (outcomeComplete !== undefined) {
    params.outcomeComplete = outcomeComplete;
  }
  return call("agent_run_assess", params);
};
const finding = async (sessionId, explanation) => {
  const observed = await snapshot(sessionId);
  return call("agent_run_finding", {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation,
    operationId: operation("finding"),
    outcome: "not-working",
    sessionId,
  });
};

const teachingSession = async (name, { handoff = true, url = shop } = {}) => {
  const session = await call("agent_session_start", {
    ...client,
    activity: "teaching",
    group: "",
    name,
    operationId: operation("teach"),
    url,
    viewport,
  });
  if (handoff) {
    await call("agent_teaching_setup_handoff", {
      operationId: operation("handoff"),
      sessionId: session.id,
    });
  }
  return session;
};

const guidedSession = async (name) => {
  const session = await call("agent_guided_run_start", {
    group: "",
    name,
    operationId: operation("guided"),
    url: shop,
    viewport,
  });
  await call("agent_teaching_setup_handoff", {
    operationId: operation("handoff"),
    sessionId: session.id,
  });
  return session;
};

// The user starts and stops recording in the Workspace.
const startRecording = async (session) => {
  await goto(session.viewUrl);
  await waitFor("button", "Start recording");
  await click("button", "Start recording");
  await waitFor("button", "Stop recording");
};
const stopRecording = async (session) => {
  await goto(session.viewUrl);
  await waitFor("button", "Stop recording");
  await click("button", "Stop recording");
  await waitFor("button", "Start recording", { state: "hidden" });
};

const comment = async (text) => {
  await click("button", "Comment", { partial: true });
  await waitFor("dialog", "Comment");
  await browser("fill", { name: "Comment", role: "textbox", value: text });
  await browser("press", { key: "Enter" });
  await browser("press", { key: "Escape" });
  await waitFor("dialog", "Comment", { state: "hidden" });
};

const taskRun = (requestedTask, referencedFlows = [], url = store) =>
  call("agent_run_start", {
    ...client,
    inputs: [],
    operationId: operation("run"),
    referencedFlows,
    requestedTask,
    url,
  });

// The user's demonstration: a click on the live canvas at the anvil's Add to
// cart button, when the snapshot reports its bounds. A recording without it
// still saves, because the instruction gives it an outcome.
const actOnUser = async (session) => {
  const observed = await snapshot(session.id);
  const node = observed.nodes.find((item) => item.name === "Add anvil to cart");
  if (node?.bounds) {
    await browser("canvas-click", {
      x: Math.round(node.bounds.x + node.bounds.width / 2),
      y: Math.round(node.bounds.y + node.bounds.height / 2),
    });
  }
};

/** Teach, stop, claim and save one Flow, as a learning agent does. */
const learnedFlow = (name, { inputs = [], instruction, steps }) =>
  once(`learned:${name}`, async () => {
    const teaching = await teachingSession(name, { url: store });
    await startRecording(teaching);
    await call("agent_teaching_instruction_record", {
      operationId: operation("instruction"),
      sessionId: teaching.id,
      text: instruction,
    });
    await actOnUser(teaching);
    await stopRecording(teaching);
    const state = await call("agent_session_get", { sessionId: teaching.id });
    const { recordingId } = state;
    if (!recordingId) {
      throw new Error(`Teaching ${name} has no recording`);
    }
    const claimOperationId = operation("claim");
    await call("agent_teaching_recording_claim", {
      action: "take",
      operationId: claimOperationId,
      recordingId,
    });
    await call("agent_teaching_timeline_get", {
      claimOperationId,
      recordingId,
    });
    await call("agent_flow_save", {
      claimOperationId,
      files: [
        {
          content: flowDocument({
            description: instruction,
            inputs,
            name,
            steps,
          }).replace(/hosts:[\s\S]*?---\n/u, "---\n"),
          path: "flow.md",
        },
      ],
      operationId: operation("save"),
      recordingId,
    });
    return { claimOperationId, recordingId, teaching };
  });

// ---------------------------------------------------------------------------
// States. Each `build` answers where the state lives: the Workspace URL, the
// actions that open it there, and the handle that shows it is ready. `alive`
// answers whether a recorded entry still stands, so a second seed reuses it.

const sessionAlive = (expected) => async (entry) => {
  try {
    const session = await call("agent_session_get", {
      sessionId: entry.sessionId,
    });
    return expected === undefined || expected(session);
  } catch (error) {
    if (error instanceof RefusalError) {
      return false;
    }
    throw error;
  }
};
const always = () => true;
/** A persisted Run stands while its Summary is in the Catalog Root. */
const runStored = async (entry) => {
  try {
    return existsSync(
      path.join(await runDirectory(catalog, entry.runId), "summary.json")
    );
  } catch {
    return false;
  }
};

const native = nativeSeeding({
  RefusalError,
  always,
  browser,
  call,
  click,
  goto,
  mcpPage,
  operation,
  run,
  stamp,
  waitFor,
});

const PROTOTYPE = {
  ended: "/ended:run_R3dj",
  run: "/s4",
  teaching: "/s1",
};

const states = [
  // Workspace home ---------------------------------------------------------
  {
    alive: always,
    build: () => ({
      ready: ["heading", "Teach a new Flow"],
      url: instance.url,
    }),
    name: "home-empty",
    prototype: {
      actions: [{ click: ["button", "Sessions:", { partial: true }] }],
      path: "/",
      review: "home-empty.png",
    },
    surface: "Workspace home",
  },
  {
    alive: always,
    build: () => ({
      ready: ["region", "In progress"],
      url: mcpPage("/"),
    }),
    name: "home-in-progress",
    prototype: { path: "/", review: "home-light.png" },
    surface: "Workspace home",
  },
  {
    alive: always,
    build: () => ({
      actions: [{ click: ["button", "Start a Web session"] }],
      ready: ["form", "Teach on Web"],
      url: mcpPage("/"),
    }),
    name: "home-start-web",
    prototype: {
      actions: [{ press: "1" }],
      path: "/",
      review: "start-web-profile.png",
    },
    surface: "Workspace home",
  },
  {
    alive: always,
    build: () => ({
      ready: ["form", "Teach on Android"],
      url: mcpPage("/?android=new"),
    }),
    name: "home-start-android",
    prototype: {
      actions: [{ press: "2" }],
      path: "/",
      review: "start-android-setup.png",
    },
    surface: "Workspace home",
  },
  {
    alive: always,
    build: () => ({
      ready: ["form", "Teach on iOS"],
      url: mcpPage("/?ios=new"),
    }),
    name: "home-start-ios",
    prototype: {
      actions: [{ press: "3" }],
      path: "/",
      review: "start-ios-dark.png",
    },
    surface: "Workspace home",
  },

  // Teaching ---------------------------------------------------------------
  {
    alive: sessionAlive((session) => session.controller !== "user"),
    build: async () => {
      const session = await teachingSession("setup-sign-in", {
        handoff: false,
        url: fixture("setup-login.html"),
      });
      await call("agent_variable_request", {
        name: "OTP",
        operationId: operation("setup-variable"),
        purpose: "The one-time code the shop sends to sign in",
        sessionId: session.id,
      });
      return {
        ready: ["region", "Setup Variables"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "teaching-agent-preparing",
    prototype: { path: PROTOTYPE.teaching },
    surface: "Dock and Requests",
  },
  {
    alive: sessionAlive((session) => session.controller === "user"),
    build: async () => {
      const session = await teachingSession("browse-shop");
      return {
        ready: ["button", "Start recording"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "teaching-ready",
    prototype: {
      actions: [
        { press: "1" },
        { click: ["button", "Start teaching"] },
        { wait: ["button", "Start recording"] },
      ],
      path: "/",
    },
    surface: "Dock and Requests",
  },
  {
    alive: sessionAlive(
      (session) => session.captureState?._tag === "recording"
    ),
    build: async () => {
      const session = await teachingSession("checkout");
      await startRecording(session);
      await comment("Add the anvil, then open the cart.");
      await comment("The cart total must include delivery.");
      return {
        ready: ["button", "Stop recording"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "teaching-recording",
    prototype: {
      path: PROTOTYPE.teaching,
      review: "session-teaching-notice-light.png",
    },
    surface: "Dock and Requests",
  },
  {
    alive: always,
    build: (context) => ({
      ...context.entry("teaching-recording"),
      actions: [{ click: ["button", "Comment, ", { partial: true }] }],
      ready: ["dialog", "Comment"],
    }),
    depends: ["teaching-recording"],
    name: "teaching-comment",
    prototype: {
      actions: [{ click: ["button", "Comment, ", { partial: true }] }],
      path: PROTOTYPE.teaching,
    },
    surface: "Teaching overlays",
  },
  {
    alive: always,
    build: (context) => ({
      ...context.entry("teaching-recording"),
      actions: [
        { click: ["button", "Comment, ", { partial: true }] },
        { wait: ["dialog", "Comment"] },
        { click: ["button", "Attach element"] },
      ],
      ready: ["text", "Click an element to attach it to the comment"],
    }),
    depends: ["teaching-recording"],
    name: "teaching-inspect",
    prototype: {
      actions: [
        { click: ["button", "Comment, ", { partial: true }] },
        { click: ["button", "Attach element"] },
      ],
      path: PROTOTYPE.teaching,
    },
    surface: "Teaching overlays",
  },
  {
    alive: always,
    build: (context) => ({
      ...context.entry("teaching-recording"),
      actions: [
        { click: ["button", "Comment, ", { partial: true }] },
        { wait: ["dialog", "Comment"] },
        { click: ["button", "Require an unseen cookie"] },
      ],
      ready: ["button", "Close check"],
    }),
    depends: ["teaching-recording"],
    name: "teaching-browser-check",
    prototype: {
      actions: [
        { click: ["button", "Comment, ", { partial: true }] },
        { click: ["button", "Browser check"] },
        { click: ["button", "GET /api/cart from Network"] },
      ],
      path: PROTOTYPE.teaching,
    },
    surface: "Teaching overlays",
  },
  {
    alive: sessionAlive(),
    build: async () => {
      const session = await teachingSession("blocked-shop");
      await goto(session.viewUrl);
      await waitFor("textbox", "Browser address");
      await browser("fill", {
        name: "Browser address",
        role: "textbox",
        value: fixture("bot-protection"),
      });
      await browser("press", {
        key: "Enter",
        name: "Browser address",
        role: "textbox",
      });
      await waitFor("alert", "", {
        "has-text": "blocked this browser",
        partial: true,
      });
      return {
        ready: ["button", "Dismiss bot protection notice"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "teaching-bot-protection",
    prototype: {
      actions: [{ click: ["button", "Bot block: off"] }],
      path: PROTOTYPE.teaching,
    },
    surface: "Interactive Run chrome",
  },

  // Guided Run -------------------------------------------------------------
  {
    alive: sessionAlive(
      (session) => session.captureState?._tag === "recording"
    ),
    build: async () => {
      const session = await guidedSession("guided-question");
      await startRecording(session);
      await call("agent_guided_run_question_ask", {
        operationId: operation("question"),
        sessionId: session.id,
        text: "Which item should I add?",
      });
      await call("agent_guided_run_question_ask", {
        operationId: operation("proposal"),
        proposal: {
          _tag: "scan",
          reason: "The document asks for a cart accessibility scan",
          scan: { id: "cart-a11y", mode: "accessibility", phase: "start" },
        },
        sessionId: session.id,
        text: "When the cart opens",
      });
      return {
        ready: ["region", "Guided Run questions"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "guided-question",
    prototype: { path: "/s3", review: "session-ios-question-dark.png" },
    surface: "Request cards",
  },
  {
    alive: sessionAlive((session) => session.controller !== "user"),
    build: async () => {
      const session = await guidedSession("guided-takeover");
      await startRecording(session);
      await call("agent_session_takeover_request", {
        operationId: operation("takeover"),
        reason: "The shop asks for a code sent to your phone",
        sessionId: session.id,
      });
      return {
        ready: ["button", "Take over"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "guided-takeover-requested",
    prototype: {
      actions: [{ click: ["button", "Control: agent"] }],
      path: "/s7",
    },
    surface: "Interactive Run chrome",
  },
  {
    alive: sessionAlive((session) => session.controller === "user"),
    build: async () => {
      const session = await guidedSession("guided-control");
      await startRecording(session);
      await click("button", "Take control");
      await waitFor("button", "Return control");
      return {
        ready: ["region", "Takeover Variable"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "guided-you-have-control",
    prototype: {
      actions: [
        { click: ["button", "Control: agent"] },
        { click: ["button", "Control: requested"] },
      ],
      path: "/s7",
    },
    surface: "Interactive Run chrome",
  },

  // Interactive Runs -------------------------------------------------------
  {
    alive: sessionAlive((session) => session.pendingDecisions?.length > 0),
    build: async () => {
      const session = await taskRun("Compare delivery prices on the help site");
      await act(session.id, {
        type: "navigate",
        url: store.replace("127.0.0.1", "localhost"),
      });
      return {
        ready: ["region", "Execution Boundary"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "run-execution-boundary",
    prototype: { path: PROTOTYPE.run, review: "session-run-boundary-dark.png" },
    surface: "Request cards",
  },
  {
    alive: sessionAlive((session) => session.pendingDecisions?.length > 0),
    build: async () => {
      await seededFlows();
      const session = await taskRun(
        "Sign in and open the cart",
        ["sign-in"],
        fixture("login.html")
      );
      await call("agent_variable_request", {
        flowName: "sign-in",
        name: "PASSWORD",
        operationId: operation("runtime-variable"),
        sessionId: session.id,
      });
      return {
        ready: ["region", "Runtime Variables"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "run-runtime-variables",
    prototype: { path: "/s4" },
    surface: "Request cards",
  },
  {
    alive: always,
    build: (context) => ({
      ...context.entry("run-runtime-variables"),
      actions: [{ click: ["button", "Task details"] }],
      ready: ["region", "Requested task"],
    }),
    depends: ["run-runtime-variables"],
    name: "run-task-details-empty",
    prototype: {
      actions: [{ click: ["button", "Task details"] }],
      path: PROTOTYPE.run,
      review: "778-task-details-empty-light.png",
    },
    surface: "Run details",
  },
  {
    alive: sessionAlive(),
    build: async () => {
      await seededFlows();
      const session = await taskRun(
        "Add an anvil to the cart, then check the delivery estimate for the North area",
        ["browse-catalogue"]
      );
      await actOn(session.id, "Add anvil to cart");
      await call("agent_run_update", {
        inputs: [],
        instruction:
          "Use the South delivery area instead, and stop before paying",
        operationId: operation("update"),
        referencedFlows: ["browse-catalogue", "sign-in"],
        sessionId: session.id,
      });
      for (const command of [
        { action: "headers_set", headers: { "x-seed-tenant": "verify" } },
        {
          action: "route_add",
          pattern: "**/cart-viewed",
          response: {
            action: "mock",
            body: "",
            contentType: "text/plain",
            status: 204,
          },
        },
        { action: "emulation_set", pageZoom: 125 },
      ]) {
        await call("agent_browser_devtools", {
          command: { ...command, operationId: operation(command.action) },
          sessionId: session.id,
        });
      }
      await finding(
        session.id,
        "The delivery estimate does not update after the area changes."
      );
      await assess(
        session.id,
        "working",
        false,
        "The anvil is in the cart; the estimate was not checked yet."
      );
      return {
        ready: ["button", "Task details"],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "run-live",
    prototype: { path: PROTOTYPE.run },
    surface: "Dock and Requests",
  },
  {
    alive: always,
    build: (context) => ({
      ...context.entry("run-live"),
      actions: [{ click: ["button", "Task details"] }],
      ready: ["region", "Requested task"],
    }),
    depends: ["run-live"],
    name: "run-task-details-long",
    prototype: {
      actions: [{ click: ["button", "Task details"] }],
      path: PROTOTYPE.run,
      review: "778-task-details-long-light.png",
    },
    surface: "Run details",
  },
  {
    // The Workspace keeps an ended Run's last frame only while it watches the
    // Run end, so the capture ends it: this entry is consumed by one capture.
    alive: sessionAlive((session) => session.phase !== "closed"),
    build: async () => {
      const session = await taskRun(
        "Open the catalogue and read the first product"
      );
      await assess(
        session.id,
        "working",
        true,
        "The first product is the anvil."
      );
      return {
        actions: [
          { wait: ["region", "Session status"] },
          {
            mcp: [
              "agent_run_complete",
              { operationId: "@operation", sessionId: session.id },
            ],
          },
        ],
        consumed: true,
        // The summary is written, then its video is condensed in place.
        ready: ["group", "Run video player", { "timeout-ms": 240_000 }],
        sessionId: session.id,
        url: session.viewUrl,
      };
    },
    name: "run-ended",
    prototype: {
      path: PROTOTYPE.ended,
      review: "778-summary-task-long-light.png",
    },
    surface: "Run Summary",
  },

  // Dry Runs ---------------------------------------------------------------
  {
    alive: sessionAlive(
      (session) => session.captureState?._tag === "dry-run-passed"
    ),
    build: async () => {
      const learned = await learnedFlow("add-anvil", {
        instruction: "Add an anvil to the cart. Stop with one cart item.",
        steps: [
          {
            do: "Add an anvil to the cart.",
            doneWhen: "Cart has 1 items is visible.",
          },
        ],
      });
      const started = await call("agent_flow_dry_run_start", {
        inputs: [],
        operationId: operation("dry"),
        recordingId: learned.recordingId,
        url: store,
      });
      await actOn(started.session.id, "Add anvil to cart");
      await assess(
        started.session.id,
        "working",
        true,
        "Cart has 1 items is visible."
      );
      await call("agent_run_complete", {
        operationId: operation("complete"),
        sessionId: started.session.id,
      });
      await goto(learned.teaching.viewUrl);
      return {
        ready: ["button", "Verify flow"],
        recordingId: learned.recordingId,
        sessionId: learned.teaching.id,
        url: learned.teaching.viewUrl,
      };
    },
    name: "dry-run-passed",
    prototype: { path: "/?recording=rec_5Pf0" },
    surface: "Run Summary",
  },
  {
    alive: always,
    build: async (context) => {
      const { recordingId } = context.entry("dry-run-passed");
      const opened = await call("open_recording", { recordingId });
      return {
        ready: ["button", "Verify flow"],
        recordingId,
        url: opened.viewUrl,
      };
    },
    depends: ["dry-run-passed"],
    name: "dry-run-review",
    prototype: {
      path: "/?recording=rec_8Wl3",
      review: "778-summary-checks-long-light.png",
    },
    surface: "Run Summary",
  },
  {
    alive: sessionAlive((session) => session.pendingDecisions?.length > 0),
    build: async () => {
      await seededFlows();
      const learned = await learnedFlow("wishlist", {
        inputs: ["area"],
        instruction: "Save an anvil to the wishlist for the delivery area.",
        steps: [
          {
            do: "Save an anvil for {{area}}.",
            doneWhen: "Wishlist has 1 items is visible.",
          },
        ],
      });
      const started = await call("agent_flow_dry_run_start", {
        inputs: [{ changed: true, name: "area" }],
        operationId: operation("dry"),
        prerequisites: ["sign-in"],
        recordingId: learned.recordingId,
        url: store,
      });
      await call("agent_variable_request", {
        flowName: "sign-in",
        name: "PASSWORD",
        operationId: operation("prerequisite"),
        sessionId: started.session.id,
      });
      return {
        ready: ["region", "Prerequisite Variables"],
        sessionId: started.session.id,
        url: started.session.viewUrl,
      };
    },
    name: "dry-run-variables",
    prototype: { path: "/s6" },
    surface: "Request cards",
  },

  // Flows page -------------------------------------------------------------
  {
    alive: always,
    build: async () => {
      await seededFlows();
      return {
        ready: ["heading", "Flows", { partial: true }],
        url: mcpPage("/flow"),
      };
    },
    name: "flows-catalog",
    prototype: { path: "/flow", review: "flows-root-runs-light.png" },
    surface: "Flows page",
  },
  {
    alive: always,
    build: async () => {
      await seededFlows();
      return {
        ready: ["region", "browse-catalogue"],
        url: mcpPage("/flow?flow=browse-catalogue"),
      };
    },
    name: "flows-verified",
    prototype: {
      path: "/flow?flow=checkout",
      review: "flows-checkout-light.png",
    },
    surface: "Flows page",
  },
  {
    alive: always,
    build: async () => {
      await seededFlows();
      return {
        ready: ["region", "sso-sign-in"],
        url: mcpPage("/flow?flow=global:sso-sign-in"),
      };
    },
    name: "flows-global",
    prototype: {
      path: "/flow?flow=global:sign-in-sso",
      review: "flows-global-light.png",
    },
    surface: "Flows page",
  },
  {
    alive: runStored,
    build: async () => {
      await seededFlows();
      const session = await taskRun(
        "Add an anvil to the cart and stop with one item",
        ["browse-catalogue"]
      );
      await actOn(session.id, "Add anvil to cart");
      await finding(
        session.id,
        "The cart badge lags one click behind the cart."
      );
      await assess(session.id, "working", true, "Cart has 1 items is visible.");
      const summary = await call("agent_run_complete", {
        operationId: operation("complete"),
        sessionId: session.id,
      });
      return {
        ready: ["region", "Run Summary"],
        runId: summary.runId,
        url: mcpPage(`/flow?run=${summary.runId}`),
      };
    },
    name: "flows-run-completed",
    prototype: { path: "/flow?flow=checkout&run=run_K0pd" },
    surface: "Flows page",
  },
  {
    alive: runStored,
    build: async () => {
      await seededFlows();
      const session = await taskRun("Check out with the saved card", [
        "browse-catalogue",
      ]);
      await assess(
        session.id,
        "not-working",
        true,
        "Checkout never offers the saved card."
      );
      const summary = await call("agent_run_complete", {
        operationId: operation("complete"),
        sessionId: session.id,
      });
      return {
        ready: ["region", "Run Summary"],
        runId: summary.runId,
        url: mcpPage(`/flow?run=${summary.runId}`),
      };
    },
    name: "flows-run-failed",
    prototype: { path: "/flow?run=run_Q81x" },
    surface: "Flows page",
  },
  {
    alive: runStored,
    build: async () => {
      const session = await taskRun("Search, then check out the first result");
      await call("agent_session_close", {
        operationId: operation("close"),
        sessionId: session.id,
      });
      return {
        ready: ["region", "Run Summary"],
        runId: session.run.runId,
        url: mcpPage(`/flow?run=${session.run.runId}`),
      };
    },
    name: "flows-run-closed",
    prototype: { path: "/flow?run=run_P9mm" },
    surface: "Flows page",
  },

  // App chrome -------------------------------------------------------------
  {
    alive: always,
    build: () => ({
      actions: [{ click: ["button", "Change color theme"] }],
      ready: ["menuitemradio", "Light"],
      url: mcpPage("/"),
    }),
    name: "chrome-theme-menu",
    prototype: {
      actions: [{ click: ["button", "Change color theme"] }],
      path: "/",
      review: "779-theme-menu-light.png",
    },
    surface: "App chrome",
  },
  {
    alive: always,
    // A one-segment path reads as a session id, so the unknown route has two.
    build: () => ({
      ready: ["link", "Go to the Workspace"],
      url: mcpPage("/seed/unknown-route"),
    }),
    name: "chrome-not-found",
    prototype: {
      path: "/?status=not-found",
      review: "779-not-found-light.png",
    },
    surface: "App chrome",
  },
  {
    alive: always,
    // On the process that owns live sessions an unknown id opens one of them,
    // so the unresolved link is read on the web process, which owns none.
    build: () => ({
      ready: ["alert", "", { "has-text": "did not resolve" }],
      url: new URL("/?session=agent-seed-missing", instance.url).href,
    }),
    name: "chrome-unknown-session",
    prototype: {
      path: "/?status=unavailable",
      review: "779-unavailable-light.png",
    },
    surface: "App chrome",
  },

  // Web canvas tools -------------------------------------------------------
  ...[
    ["web-network", "Network"],
    ["web-console", "Console"],
    ["web-emulation", "Emulation"],
    ["web-user-agent", "User agent"],
    ["web-storage", "Storage"],
    ["web-stream-diagnostics", "Stream diagnostics"],
  ].map(([name, tool]) => ({
    alive: always,
    build: (context) => ({
      ...context.entry("teaching-ready"),
      actions: [{ click: ["button", tool] }],
      ready: undefined,
    }),
    depends: ["teaching-ready"],
    name,
    prototype: { actions: [{ click: ["button", tool] }], path: "/s1" },
    surface: "Web session canvas",
  })),

  // Android and iOS (opt in with --android and --ios) ----------------------
  ...native.states,
];

/** States the real server cannot reach on demand, with the reason. */
const unreached = [
  [
    "chrome-session-unavailable",
    "App chrome",
    "The `Agent Session unavailable` card shows only when the watched session's stream fails; an unknown id shows `chrome-unknown-session` instead.",
  ],
  [
    "chrome-loading",
    "App chrome",
    "The Workspace shows its loader only until the session list answers, which takes milliseconds on a local server.",
  ],
  [
    "dock-agent-idle",
    "Dock and Requests",
    "`Agent idle for <n> min` needs ten minutes without an agent MCP call.",
  ],
  [
    "dock-refused-gesture",
    "Dock and Requests",
    "A refused gesture's alert is transient; it shows only while the refusal is fresh.",
  ],
  [
    "teaching-demo-password",
    "Teaching overlays",
    "The demo password asks only in a `contingency start --demo` work session.",
  ],
  [
    "flows-hidden-interval",
    "Flows page",
    "A Hidden Interval comes from an Android secure screen.",
  ],
  ...native.unreached.map(([name, surface, , reason]) => [
    name,
    surface,
    reason,
  ]),
];

// ---------------------------------------------------------------------------
// Seed

const readManifest = async () => {
  try {
    return JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { entries: [] };
    }
    throw error;
  }
};

/** A flag's value, or undefined when it is absent or given without one. */
const flagValue = (value) => (value === true ? undefined : value);
const only = (flags) => {
  const value = flagValue(flags.only);
  return value === undefined ? undefined : new Set(value.split(","));
};

const withDependencies = (selected) => {
  if (selected === undefined) {
    return states;
  }
  const wanted = new Set();
  const visit = (name) => {
    if (wanted.has(name)) {
      return;
    }
    wanted.add(name);
    for (const dependency of states.find((state) => state.name === name)
      ?.depends ?? []) {
      visit(dependency);
    }
  };
  for (const name of selected) {
    if (!states.some((state) => state.name === name)) {
      fail(`Unknown seed state: ${name}`);
    }
    visit(name);
  }
  return states.filter((state) => wanted.has(state.name));
};

const order = new Map(
  [
    ...states.map((state) => state.name),
    ...unreached.map(([name]) => name),
  ].map((name, index) => [name, index])
);
const writeManifest = async (byName, chains = {}) => {
  const manifest = {
    // Each native chain's sessions that `seed capture` started (seed-native.mjs).
    chains,
    entries: [...byName.values()].toSorted(
      (left, right) =>
        (order.get(left.name) ?? 999) - (order.get(right.name) ?? 999)
    ),
    mcpUrl: instance.mcpUrl,
    webUrl: instance.url,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

const seed = async (flags) => {
  await mkdir(seedDir, { recursive: true });
  const previous = await readManifest();
  // Entries for states this file no longer defines are dropped.
  const byName = new Map(
    previous.entries
      .filter((entry) => order.has(entry.name))
      .map((entry) => [entry.name, entry])
  );
  const chains = { ...previous.chains };
  const context = {
    entry: (name) => {
      const entry = byName.get(name);
      if (entry?.status !== "reached") {
        throw new Error(`${name} was not reached`);
      }
      const { native: chain, recordingId, sessionId, url } = entry;
      return { native: chain, recordingId, sessionId, url };
    },
  };
  const selected = withDependencies(only(flags));
  for (const state of selected) {
    const existing = byName.get(state.name);
    // A native state drives a device, so it runs only when asked for.
    if (state.platform !== undefined && flags[state.platform] !== true) {
      byName.set(state.name, {
        name: state.name,
        prototype: state.prototype,
        reason: native.flagReason(state.platform),
        status: "unreached",
        surface: state.surface,
      });
      continue;
    }
    // A state that owns no server state is derived again on every seed, so
    // its handles follow this file; one that owns a session or Run is kept
    // while that still stands.
    if (
      state.alive !== always &&
      existing?.status === "reached" &&
      [instance.url, instance.mcpUrl].includes(
        `${new URL(existing.url).origin}/`
      ) &&
      (await state.alive(existing))
    ) {
      byName.set(state.name, {
        ...existing,
        prototype: state.prototype,
        surface: state.surface,
      });
      process.stderr.write(`kept    ${state.name}\n`);
      continue;
    }
    process.stderr.write(
      `${state.alive === always ? "derived" : "seeding"} ${state.name}\n`
    );
    try {
      const built = await state.build(context);
      if (state.platform !== undefined && built.native !== undefined) {
        // A new chain starts; the Dry Run an earlier capture started is gone.
        chains[state.platform] = {};
      }
      byName.set(state.name, {
        ...built,
        name: state.name,
        platform: state.platform,
        prototype: state.prototype,
        status: "reached",
        surface: state.surface,
      });
    } catch (error) {
      byName.set(state.name, {
        name: state.name,
        prototype: state.prototype,
        reason: error instanceof Error ? error.message : String(error),
        status: "failed",
        surface: state.surface,
      });
      process.stderr.write(
        `failed  ${state.name}: ${byName.get(state.name).reason}\n`
      );
    }
    await writeManifest(byName, chains);
  }
  for (const [name, surface, reason] of unreached) {
    byName.set(name, { name, reason, status: "unreached", surface });
  }
  const manifest = await writeManifest(byName, chains);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  const failed = manifest.entries.filter((entry) => entry.status === "failed");
  if (failed.length > 0) {
    process.exitCode = 2;
  }
};

// ---------------------------------------------------------------------------
// Capture

/** A chain placeholder such as `@chain:android:dryRun` names a session a capture step started. */
const resolveUrl = (url, chains) => {
  const match = /^@chain:(?<platform>\w+):(?<key>\w+)$/u.exec(url);
  if (!match?.groups) {
    return url;
  }
  const { key, platform } = match.groups;
  const sessionId = chains[platform]?.[key];
  if (!sessionId) {
    throw new Error(
      `No ${key} on the ${platform} chain yet; capture its earlier states first.`
    );
  }
  return `${mcpPage("/")}?${platform}=${sessionId}`;
};

const runActions = async (actions = [], entry = {}, chains = {}) => {
  for (const action of actions) {
    if (action.step) {
      const { platform } = entry;
      chains[platform] ??= {};
      await native.steps[action.step]({
        chain: chains[platform],
        entry,
        platform,
      });
    } else if (action.upload) {
      // A placeholder build for the prototype's upload field; it reads only the name.
      const [role, name] = action.upload;
      const placeholder = path.join(seedDir, "prototype-build.zip");
      await writeFile(placeholder, "");
      await browser("set-input-files", { name, path: placeholder, role });
    } else if (action.pick) {
      await native.runPick(entry.platform, entry.sessionId, action.pick);
    } else if (action.click) {
      const [role, name, extra] = action.click;
      await waitFor(role, name, extra);
      await click(role, name, extra);
    } else if (action.wait) {
      const [role, name, extra] = action.wait;
      await waitFor(role, name, extra);
    } else if (action.press) {
      await browser("press", { key: action.press });
    } else if (action.mcp) {
      const [tool, params] = action.mcp;
      await call(
        tool,
        Object.fromEntries(
          Object.entries(params).map(([key, value]) => [
            key,
            value === "@operation" ? operation("capture") : value,
          ])
        )
      );
    }
  }
};

const shoot = async (directoryName, name, ready) => {
  if (ready) {
    const [role, label, extra] = ready;
    await waitFor(role, label, extra);
  }
  await browser("settle");
  const relative = path.relative(artifactsRoot, directoryName);
  await browser("snapshot", {
    aria: true,
    path: path.join(relative, `${name}.aria.txt`),
  });
  for (const scheme of ["light", "dark"]) {
    await browser("color-scheme", { scheme });
    await browser("screenshot", {
      path: path.join(relative, `${name}-${scheme}.png`),
    });
  }
};

const capture = async (flags) => {
  const manifest = await readManifest();
  if (manifest.entries.length === 0) {
    fail("Run `control-contingency seed` before `seed capture`.");
  }
  const selected = only(flags);
  const out = path.resolve(
    flagValue(flags.path) ?? path.join(artifactsRoot, "seed")
  );
  await mkdir(out, { recursive: true });
  const prototypeUrl = flagValue(flags.prototype);
  const chains = manifest.chains ?? {};
  const results = [];
  for (const entry of manifest.entries) {
    if (selected !== undefined && !selected.has(entry.name)) {
      continue;
    }
    if (entry.status !== "reached") {
      results.push({
        name: entry.name,
        reason: entry.reason,
        status: entry.status,
      });
      continue;
    }
    const result = { name: entry.name, prod: undefined, prototype: undefined };
    try {
      await browser("resize", { height: 900, width: 1440 });
      await goto(resolveUrl(entry.url, chains));
      await runActions(entry.actions, entry, chains);
      await shoot(out, `${entry.name}.prod`, entry.ready);
      result.prod = "captured";
    } catch (error) {
      result.prod = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (prototypeUrl && entry.prototype) {
      try {
        await goto(new URL(entry.prototype.path, prototypeUrl).href);
        await runActions(entry.prototype.actions);
        // The prototype's scaffold strip is not proposed UI.
        await browser("hide", { selector: ".scaffold" });
        await shoot(out, `${entry.name}.prototype`);
        result.prototype = "captured";
      } catch (error) {
        result.prototype = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (entry.prototype?.review) {
      result.review = path.resolve(
        here,
        "../../../../docs/prototypes/744-workspace-design-direction/review",
        entry.prototype.review
      );
    }
    results.push(result);
    process.stderr.write(
      `captured ${entry.name}: prod ${result.prod}${result.prototype ? `, prototype ${result.prototype}` : ""}\n`
    );
  }
  // Native capture steps start sessions that later entries name.
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, chains }, null, 2)}\n`
  );
  // A partial capture (--only) replaces its own rows and keeps the others.
  const capturesPath = path.join(out, "captures.json");
  let previousResults = [];
  try {
    previousResults = JSON.parse(await readFile(capturesPath, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const captured = new Set(results.map((result) => result.name));
  const merged = [
    ...previousResults.filter((result) => !captured.has(result.name)),
    ...results,
  ].toSorted(
    (left, right) =>
      (order.get(left.name) ?? 999) - (order.get(right.name) ?? 999)
  );
  await writeFile(capturesPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ directory: out, results }, null, 2)}\n`
  );
};

// ---------------------------------------------------------------------------

const { flags, rest } = parseFlags(process.argv.slice(2));
if (rest[0] === "capture") {
  await capture(flags);
} else if (rest[0] === "reset") {
  await rm(seedDir, { force: true, recursive: true });
  process.stdout.write("seed manifest removed\n");
} else if (rest.length === 0) {
  await seed(flags);
} else {
  fail(`Unknown seed command: ${rest[0]}`);
}
