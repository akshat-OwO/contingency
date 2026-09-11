import path from "node:path";

import {
  AgentElementRef,
  AgentFlowHeads,
  EvidenceSlice,
  OperationId,
  TEACHING_SCREENSHOT_BUDGET_CHARACTERS,
} from "@contingency/protocol";
import type {
  AgentSessionId,
  TeachingFeed,
  TeachingScreenshot,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { makeAgentFlowCatalogLayer } from "../../src/services/agent-flow-catalog.ts";
import {
  AgentSession,
  makeAgentSessionLayer,
} from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentFlowToolHandlersLive,
  AgentFlowTools,
} from "../../src/services/mcp-agent-flow.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { findNode, makeCall } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/** The screenshot reference a feed must have captured, or a loud failure. */
const firstScreenshot = (feed: TeachingFeed): TeachingScreenshot => {
  const [first] = feed.screenshots;
  if (first === undefined) {
    throw new Error("The Teaching Feed captured no screenshot.");
  }
  return first;
};

const session = makeCall(AgentSessionTools);
const flow = makeCall(AgentFlowTools);

/** Where the user's pointer lands on the shop fixture's cart button. */
const VIEW_CART = { x: 100, y: 316 } as const;

/** Where it lands on the login fixture's sign-in and help buttons. */
const SIGN_IN = { x: 70, y: 220 } as const;
const OPEN_HELP = { x: 260, y: 315 } as const;

/**
 * One user click, sent the way the Workspace forwards a pointer event to the
 * browser it is streaming. Teaching has no other way in: the agent observes.
 */
const clickAsUser = (
  sessionId: AgentSessionId,
  at: { readonly x: number; readonly y: number }
) =>
  Effect.gen(function* clickAsTheUser() {
    const service = yield* AgentSession;
    for (const eventType of ["mousePressed", "mouseReleased"] as const) {
      yield* service.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        x: at.x,
        y: at.y,
      });
    }
  });

/** The user typing into whichever control the Page has focused. */
const typeAsUser = (sessionId: AgentSessionId, text: string) =>
  Effect.gen(function* typeAsTheUser() {
    const service = yield* AgentSession;
    for (const character of text) {
      yield* service.sendInput(sessionId, {
        eventType: "keyDown",
        key: character,
        text: character,
        type: "input_keyboard",
      });
      yield* service.sendInput(sessionId, {
        eventType: "keyUp",
        key: character,
        type: "input_keyboard",
      });
    }
  });

/**
 * The whole Teaching surface over one real Chromium and one temporary Catalog
 * Root: the external agent drives the browser through MCP, reads the bounded
 * Teaching Feed, compiles a draft, and finds it again by search.
 */
const teachingLayer = (initialCatalogRoot: string) => {
  let selectedCatalogRoot = initialCatalogRoot;
  return Layer.mergeAll(
    AgentSessionToolHandlersLive,
    AgentFlowToolHandlersLive
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        makeAgentSessionLayer({
          baseUrl: "http://127.0.0.1:7777",
          traceDirectory: () => path.join(selectedCatalogRoot, "teaching"),
        }),
        makeAgentFlowCatalogLayer({
          onSelect: (root) => {
            selectedCatalogRoot = root;
          },
          root: initialCatalogRoot,
        })
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );
};

it.live("teaches a public journey and saves a searchable draft", () =>
  Effect.gen(function* teachPublicJourney() {
    const fileSystem = yield* FileSystem.FileSystem;
    const initialCatalogRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-",
    });
    const catalogRoot = path.join(initialCatalogRoot, "selected");
    yield* Effect.gen(function* teach() {
      const fixtures = yield* fixtureServer;
      const shopUrl = fixtures.url("shop.html");
      const fixtureHost = new URL(shopUrl).hostname;

      const selected = yield* flow("agent_catalog_select", {
        operationId: OperationId.make("select-teaching-root"),
        root: catalogRoot,
      });
      expect(selected).toEqual({ agentFlowCount: 0, root: catalogRoot });

      const started = yield* session("agent_session_start", {
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        operationId: OperationId.make("start-teaching"),
        url: shopUrl,
        viewport,
      });
      const localSession = yield* AgentSession;
      const { traceFile, videoFile } = yield* localSession.teachingSource(
        started.id
      );
      expect(traceFile).toBeDefined();
      expect(videoFile).toBeDefined();
      if (traceFile === undefined || videoFile === undefined) {
        throw new Error("Teaching did not allocate local artifacts.");
      }
      expect(yield* fileSystem.exists(traceFile)).toBe(false);
      expect(started.teaching).toEqual({
        actionCount: 0,
        draft: null,
        instructionCount: 0,
      });

      // The agent cannot act during a Demonstration, however it asks: the
      // refusal names the tool it should reach for instead.
      const refusedAct = yield* Effect.flip(
        session("agent_browser_act", {
          action: { action: "reload", type: "history" },
          operationId: OperationId.make("act-while-teaching"),
          sessionId: started.id,
        })
      );
      expect(refusedAct.code).toBe("agent_control_unavailable");
      expect(refusedAct.message).toContain("Teaching is user-led");
      expect(refusedAct.message).toContain("agent_teaching_instruction_record");

      // Nor is there control to move: the user holds the browser throughout.
      const refusedTakeover = yield* Effect.flip(
        localSession.takeover(
          started.id,
          "Let me drive this myself.",
          OperationId.make("takeover-teaching")
        )
      );
      expect(refusedTakeover.code).toBe("agent_control_unavailable");
      expect(refusedTakeover.message).toContain("Teaching has no Takeover");
      const refusedReturn = yield* Effect.flip(
        localSession.returnControl(
          started.id,
          OperationId.make("return-teaching")
        )
      );
      expect(refusedReturn.code).toBe("agent_control_unavailable");
      expect(
        (yield* session("agent_session_get", { sessionId: started.id }))
          .controller
      ).toBe("user");

      // The user says what to do and then demonstrates it themselves. The
      // agent observes: a Browser Snapshot and a screenshot, nothing else.
      yield* flow("agent_teaching_instruction_record", {
        operationId: OperationId.make("instruct-search"),
        sessionId: started.id,
        text: "Search the catalogue for an anvil.",
      });
      const observed = yield* session("agent_browser_snapshot", {
        sessionId: started.id,
      });
      const visual = yield* session("agent_browser_screenshot", {
        sessionId: started.id,
      });
      expect(visual.image.length).toBeGreaterThan(0);
      findNode(observed.nodes, "textbox", "Search the catalogue");
      yield* typeAsUser(started.id, "anvil");

      yield* flow("agent_teaching_instruction_record", {
        operationId: OperationId.make("instruct-cart"),
        sessionId: started.id,
        text: "Now open the cart and make sure it has one item.",
      });
      yield* clickAsUser(started.id, VIEW_CART);

      // A failed attempt is part of the Demonstration too: the user mistyped
      // a URL in the Workspace address bar and the browser refused it.
      const failure = yield* Effect.flip(
        localSession.userNavigate(started.id, {
          type: "navigate",
          url: "http://127.0.0.1:9/",
        })
      );
      expect(failure.code).toBeDefined();

      const unfinishedFeed = yield* Effect.flip(
        flow("agent_teaching_feed_get", {
          includeSnapshots: true,
          sessionId: started.id,
        })
      );
      expect(unfinishedFeed.code).toBe("agent_session_invalid");
      expect(unfinishedFeed.message).toContain("End Teaching");
      const unfinishedDraft = yield* Effect.flip(
        flow("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: {
            description: "Cannot compile before video analysis.",
            domainScope: { hosts: [fixtureHost] },
            schemaVersion: 1,
            steps: [
              {
                confirmation: false,
                description: "This proposal must not be compiled yet.",
                firstActionId: "action-not-read-yet",
                lastActionId: "action-not-read-yet",
                name: "Too early",
              },
            ],
            title: "Too early",
          },
          operationId: OperationId.make("save-before-analysis"),
          sessionId: started.id,
        })
      );
      expect(unfinishedDraft.code).toBe("agent_session_invalid");
      expect(unfinishedDraft.message).toContain("End Teaching");

      yield* session("agent_session_close", {
        operationId: OperationId.make("close-teaching"),
        sessionId: started.id,
      });
      expect(yield* fileSystem.exists(traceFile)).toBe(true);
      expect((yield* fileSystem.stat(traceFile)).size).toBeGreaterThan(0n);
      expect(yield* fileSystem.exists(videoFile)).toBe(true);
      expect((yield* fileSystem.stat(videoFile)).size).toBeGreaterThan(0n);

      const feed = yield* flow("agent_teaching_feed_get", {
        includeSnapshots: true,
        sessionId: started.id,
      });
      // The PlayByPlay leads the feed and stays consistent with the
      // instrumentation behind it: the URL it started on, the Instructions the
      // user relayed, and the outcome of every captured action.
      expect(Object.keys(feed)[0]).toBe("playByPlay");
      expect(feed.playByPlay.length).toBeGreaterThan(0);
      expect(feed.playByPlay.startsWith("Contingency analyzed")).toBe(true);
      expect(feed.playByPlay).toContain("local Teaching video");
      expect(feed.playByPlay).toContain("cross-checked against 3 captured");
      expect(feed.playByPlay).toContain(
        "Browser evidence identified “Anvil Works”"
      );
      expect(feed.playByPlay).toContain(shopUrl);
      expect(feed.playByPlay).toContain("Search the catalogue for an anvil.");
      expect(feed.playByPlay).toContain("which failed");
      expect(feed.playByPlay).toContain("The user");
      expect(feed.playByPlay).not.toContain("The agent");
      // The bounded feed: instructions, actor-attributed actions, URL
      // transitions, and observed hosts. No cookies, headers, or network.
      expect(feed.instructions.map(({ text }) => text)).toEqual([
        "Search the catalogue for an anvil.",
        "Now open the cart and make sure it has one item.",
      ]);
      // Every captured action is the user's: the typing coalesces into one
      // Fill, the pointer becomes one semantic Click, and the refused
      // navigation is kept as the failure it was.
      expect(feed.actions.every(({ actor }) => actor === "user")).toBe(true);
      expect(
        feed.actions.map(({ action, outcome }) => [action.type, outcome])
      ).toEqual([
        ["fill", "completed"],
        ["click", "completed"],
        ["navigate", "failed"],
      ]);
      expect(feed.actions[0]?.action).toEqual(
        expect.objectContaining({ text: "anvil", type: "fill" })
      );
      // The user path observes the control it is about to edit, so the Fill
      // anchors to a Snapshot of its own rather than the agent's last read.
      expect(feed.actions[0]?.snapshotBefore).not.toBeNull();
      expect(feed.snapshots.map(({ snapshotId }) => snapshotId)).toContain(
        feed.actions[0]?.snapshotBefore
      );
      expect(feed.actions[0]?.urlBefore).toBe(shopUrl);
      expect(feed.observedHosts).toEqual([fixtureHost]);
      // The feed carries a reference, never the bytes. The agent fetches one
      // image at a time, and an unknown reference is refused.
      expect(feed.screenshots).toHaveLength(1);
      const reference = firstScreenshot(feed);
      expect(JSON.stringify(feed)).not.toContain(visual.image);
      const fetched = yield* flow("agent_teaching_screenshot_get", {
        screenshotId: reference.id,
        sessionId: started.id,
      });
      expect(fetched.image).toBe(visual.image);
      expect(fetched.contentHash).toBe(reference.contentHash);
      expect(feed.urlTransitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: null,
            from: "about:blank",
            to: shopUrl,
          }),
        ])
      );
      const serialized = JSON.stringify(feed);
      expect(serialized).not.toContain("cookie");
      expect(serialized).not.toContain("<");

      const [fillAction, clickAction] = feed.actions;
      if (fillAction === undefined || clickAction === undefined) {
        throw new Error("The feed lost captured actions.");
      }
      // The Snapshots the user's own actions produced are in the feed, so a
      // compiler can anchor Step boundaries to the Page either side of them.
      expect(feed.snapshots.map(({ snapshotId }) => snapshotId)).toEqual(
        expect.arrayContaining([
          fillAction.snapshotBefore,
          fillAction.snapshotAfter,
          clickAction.snapshotAfter,
        ])
      );
      const catalogBefore = yield* flow("agent_catalog_get", {});
      expect(catalogBefore).toEqual({ agentFlowCount: 0, root: catalogRoot });

      // Invalid compiler output is refused with diagnostics and saves nothing.
      const refused = yield* Effect.flip(
        flow("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: {
            description: "Search and open the cart.",
            domainScope: { hosts: ["shop.example.com"] },
            schemaVersion: 1,
            steps: [
              {
                confirmation: false,
                description: "Type anvil into the search box.",
                firstActionId: fillAction.id,
                lastActionId: "action-missing",
                name: "Search",
              },
            ],
            title: "Anvil cart",
          },
          operationId: OperationId.make("save-refused"),
          sessionId: started.id,
        })
      );
      expect(refused.code).toBe("agent_flow_invalid");
      expect(refused.diagnostics?.map(({ code }) => code)).toEqual([
        "unknown_action",
      ]);
      expect(refused.message).toContain("unknown_action");
      expect((yield* flow("agent_catalog_get", {})).agentFlowCount).toBe(0);

      const saved = yield* flow("agent_flow_draft_save", {
        basedOnRevisionId: null,
        draft: {
          description:
            "Search the catalogue and confirm the cart holds an item.",
          domainScope: { hosts: [fixtureHost] },
          schemaVersion: 1,
          steps: [
            {
              confirmation: false,
              description: "Type anvil into the catalogue search box.",
              firstActionId: fillAction.id,
              lastActionId: fillAction.id,
              name: "Search for an anvil",
            },
            {
              confirmation: false,
              description: "Open the cart and see one item in it.",
              firstActionId: clickAction.id,
              lastActionId: clickAction.id,
              name: "Open the cart",
            },
          ],
          tags: ["shop", "cart"],
          title: "Anvil Works cart check",
        },
        operationId: OperationId.make("save-draft"),
        sessionId: started.id,
      });
      expect(saved.catalogRoot).toBe(catalogRoot);
      expect(saved.manifest.status).toBe("draft");
      expect(saved.manifest.compiler).toEqual({
        clientName: "integration-agent",
        clientVersion: "1.0.0",
      });
      expect(saved.manifest.sourceSessionId).toBe(started.id);
      expect(saved.manifest.emulation.viewport).toEqual(viewport);
      expect(saved.manifest.steps.map(({ name }) => name)).toEqual([
        "Search for an anvil",
        "Open the cart",
      ]);

      // The Evidence Slice is derived from the demonstrated span, with the
      // Page as it stood before and after, and the instruction in force.
      const [, secondStep] = saved.manifest.steps;
      const slice = Schema.decodeUnknownSync(EvidenceSlice)(
        JSON.parse(
          yield* fileSystem.readFileString(
            path.join(
              catalogRoot,
              "agent-flows",
              saved.manifest.agentFlowId,
              secondStep?.evidence.path ?? ""
            )
          )
        )
      );
      expect(slice.actions.map(({ id }) => id)).toEqual([clickAction.id]);
      expect(slice.instructions.map(({ text }) => text)).toEqual([
        "Now open the cart and make sure it has one item.",
      ]);
      expect(slice.before?.snapshotId).toBe(clickAction.snapshotBefore);
      expect(slice.after?.snapshotId).toBe(clickAction.snapshotAfter);
      expect(
        findNode(slice.after?.nodes ?? [], "main", "1 item").name
      ).toContain("1 item");
      expect(
        findNode(slice.before?.nodes ?? [], "main", "0 items").name
      ).toContain("0 items");

      // Agent View learns the draft through the session.
      const current = yield* session("agent_session_get", {
        sessionId: started.id,
      });
      expect(current.teaching).toEqual({
        actionCount: 3,
        draft: {
          agentFlowId: saved.manifest.agentFlowId,
          revisionId: saved.manifest.revisionId,
          savedAt: saved.manifest.createdAt,
          steps: saved.manifest.steps.map((step, index) => ({
            confirmation: step.confirmation,
            description: step.description,
            evidenceHash: step.evidence.hash,
            firstActionId: step.firstActionId,
            index,
            lastActionId: step.lastActionId,
            name: step.name,
          })),
          title: "Anvil Works cart check",
        },
        instructionCount: 2,
      });

      // A later conversation finds the finalized draft, labelled as one.
      const found = yield* flow("agent_catalog_search", {
        query: "anvil cart",
      });
      expect(found.hits).toHaveLength(1);
      expect(found.hits[0]).toMatchObject({
        agentFlowId: saved.manifest.agentFlowId,
        revisionId: saved.manifest.revisionId,
        status: "draft",
        stepCount: 2,
        title: "Anvil Works cart check",
      });
      const byHost = yield* flow("agent_catalog_search", { host: fixtureHost });
      expect(byHost.hits.map(({ title }) => title)).toEqual([
        "Anvil Works cart check",
      ]);
      const approvedOnly = yield* flow("agent_catalog_search", {
        status: "approved",
      });
      expect(approvedOnly.hits).toEqual([]);
      const read = yield* flow("agent_flow_get", {
        agentFlowId: saved.manifest.agentFlowId,
      });
      expect(read).toEqual(saved);

      // Archived state is explicit at the tool boundary, not silently lost.
      const headsPath = path.join(
        catalogRoot,
        "agent-flows",
        saved.manifest.agentFlowId,
        "agent-flow.json"
      );
      const heads = Schema.decodeUnknownSync(AgentFlowHeads)(
        JSON.parse(yield* fileSystem.readFileString(headsPath))
      );
      yield* fileSystem.writeFileString(
        headsPath,
        JSON.stringify({ ...heads, archived: true })
      );
      const archived = yield* flow("agent_catalog_search", {
        archived: true,
        query: "anvil cart",
      });
      expect(archived.hits).toMatchObject([
        { agentFlowId: saved.manifest.agentFlowId, archived: true },
      ]);
    }).pipe(Effect.scoped, Effect.provide(teachingLayer(catalogRoot)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("masks known-sensitive values from Browser Snapshots", () =>
  Effect.gen(function* sensitiveSnapshotJourney() {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-sensitive-catalog-",
    });
    yield* Effect.gen(function* inspectSensitiveSnapshot() {
      const fixtures = yield* fixtureServer;
      const started = yield* session("agent_session_start", {
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        operationId: OperationId.make("start-sensitive-teaching"),
        url: fixtures.url("secret-echo.html?access_token=url-secret"),
        viewport,
      });
      expect(started.currentUrl).not.toContain("url-secret");
      const observed = yield* session("agent_browser_snapshot", {
        sessionId: started.id,
      });
      expect(observed.url).not.toContain("url-secret");
      const token = findNode(observed.nodes, "textbox", "Token");
      expect(token.valueWithheld).toBeUndefined();
      // The user types the credential into the focused field themselves. A
      // known-sensitive control never yields a semantic Fill: its keystrokes
      // are captured as masked raw input, so the literal is never recorded.
      yield* typeAsUser(started.id, "top-secret");
      const after = yield* session("agent_browser_snapshot", {
        sessionId: started.id,
      });
      const redactedToken = findNode(after.nodes, "textbox", "Token");
      expect(redactedToken.value).toBeUndefined();
      expect(redactedToken.valueWithheld).toBe(true);
      expect(JSON.stringify(after)).not.toContain("top-secret");
      expect(after.url).not.toContain("url-secret");
      const screenshot = yield* session("agent_browser_screenshot", {
        sessionId: started.id,
      });
      expect(screenshot.url).not.toContain("url-secret");
      yield* session("agent_session_close", {
        operationId: OperationId.make("close-sensitive-teaching"),
        sessionId: started.id,
      });
      const feed = yield* flow("agent_teaching_feed_get", {
        includeSnapshots: true,
        sessionId: started.id,
      });
      expect(feed.actions.every(({ actor }) => actor === "user")).toBe(true);
      expect(feed.actions.every(({ action }) => action.type === "input")).toBe(
        true
      );
      expect(
        feed.actions.every(
          ({ action }) =>
            action.type !== "input" ||
            action.input.inputType !== "keyboard" ||
            action.input.key === "[user input]"
        )
      ).toBe(true);
      expect(JSON.stringify(feed)).not.toContain("top-secret");
      expect(JSON.stringify(feed)).not.toContain("url-secret");
      const capturedTokens = feed.snapshots.flatMap(({ nodes }) =>
        nodes.filter(({ name, role }) => name === "Token" && role === "textbox")
      );
      expect(
        capturedTokens.some(({ valueWithheld }) => valueWithheld === true)
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(teachingLayer(catalogRoot)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "teaches a login with private Variables without exporting literals",
  () =>
    Effect.gen(function* teachPrivateLogin() {
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-private-teaching-",
      });
      yield* Effect.gen(function* teach() {
        const fixtures = yield* fixtureServer;
        const started = yield* session("agent_session_start", {
          activity: "teaching",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("start-private-teaching"),
          url: fixtures.url("agent-login.html"),
          viewport,
        });
        const localSession = yield* AgentSession;
        const artifacts = yield* localSession.teachingSource(started.id);
        expect(artifacts.artifactRetention).toEqual({
          location: "local",
          sensitive: true,
        });
        expect(artifacts.traceFile).toBeDefined();
        expect(artifacts.videoFile).toBeDefined();
        expect(artifacts.retentionFile).toBeDefined();
        const observed = yield* session("agent_browser_snapshot", {
          sessionId: started.id,
        });
        findNode(observed.nodes, "textbox", "Display name");
        const mobile = findNode(observed.nodes, "textbox", "Mobile number");
        const password = findNode(observed.nodes, "textbox", "Password");
        const rejected = findNode(
          observed.nodes,
          "textbox",
          "Rejected private value"
        );
        const otp = findNode(observed.nodes, "textbox", "digit 1 of 6");

        // The user demonstrates: they type the public display name into the
        // focused field, then click sign in with their own pointer.
        yield* typeAsUser(started.id, "AB");
        yield* clickAsUser(started.id, SIGN_IN);

        // Private values are the user's to enter, named by the Variable the
        // Demonstration declares. The literal never leaves Contingency.
        const mobileLiteral = "5551234";
        yield* localSession.enterUserVariable(
          started.id,
          {
            ref: mobile.ref,
            value: mobileLiteral,
            variable: { name: "MOBILE", runtime: false, secret: true },
          },
          OperationId.make("enter-mobile")
        );

        const passwordLiteral = "x5551234x";
        const ignoredLiteral = "ignored-private-value";
        // A control that discards what it was given registers no Variable,
        // and the refusal never carries the literal back.
        const ignored = yield* Effect.flip(
          localSession.enterUserVariable(
            started.id,
            {
              ref: rejected.ref,
              value: ignoredLiteral,
              variable: { name: "IGNORED", runtime: false, secret: true },
            },
            OperationId.make("reject-private-input")
          )
        );
        expect(ignored.code).toBe("agent_browser_failed");
        expect(JSON.stringify(ignored)).not.toContain(ignoredLiteral);
        const failed = yield* Effect.flip(
          localSession.enterUserVariable(
            started.id,
            {
              ref: AgentElementRef.make("e999999"),
              value: "must-not-register",
              variable: { name: "FAILED", runtime: false, secret: true },
            },
            OperationId.make("fail-private-input")
          )
        );
        expect(failed.code).toBe("agent_element_stale");
        const passwordInput = {
          ref: password.ref,
          value: passwordLiteral,
          variable: { name: "PASSWORD", runtime: false, secret: true },
        } as const;
        const enteredPassword = yield* localSession.enterUserVariable(
          started.id,
          passwordInput,
          OperationId.make("enter-password")
        );
        expect(
          yield* localSession.enterUserVariable(
            started.id,
            passwordInput,
            OperationId.make("enter-password")
          )
        ).toEqual(enteredPassword);
        const otpLiteral = "246801";
        const enteredOtp = yield* localSession.enterUserVariable(
          started.id,
          {
            ref: otp.ref,
            value: otpLiteral,
            variable: { name: "OTP", runtime: true, secret: true },
          },
          OperationId.make("enter-otp")
        );
        expect(
          findNode(enteredOtp.snapshot.nodes, "output", "Verification ready")
            .name
        ).toBe("Verification ready");
        // The fixture's split boxes carry no one-time-code metadata, so the
        // Snapshot heuristic keeps their values. Each one holds a single
        // character of the declared Variable and must still be redacted.
        const otpBoxes = enteredOtp.snapshot.nodes.filter(({ name }) =>
          name.endsWith(" of 6")
        );
        expect(otpBoxes).toHaveLength(6);
        for (const box of otpBoxes) {
          expect(box.value).not.toBe("");
          expect(box.value).toBe("[sensitive input]");
          expect(box.valueWithheld).toBe(true);
        }
        // A second Page the user opened is captured too, video and all.
        yield* clickAsUser(started.id, OPEN_HELP);
        yield* session("agent_browser_screenshot", { sessionId: started.id });

        yield* session("agent_session_close", {
          operationId: OperationId.make("close-private-teaching"),
          sessionId: started.id,
        });
        const feed = yield* flow("agent_teaching_feed_get", {
          includeSnapshots: true,
          sessionId: started.id,
        });
        const literals = [mobileLiteral, passwordLiteral, otpLiteral];
        const exported = JSON.stringify(feed);
        // The fixture server binds an ephemeral port, so its digits would
        // otherwise collide at random with a slice of a numeric literal.
        const snapshotExport = JSON.stringify({
          ...feed,
          screenshots: [],
        })
          .split(new URL(started.currentUrl).origin)
          .join("http://fixture");
        for (const literal of literals) {
          expect(exported).not.toContain(literal);
        }
        expect(exported).toContain("Available in 1800+ cities.");
        expect(exported).toContain("Drugs and Cosmetics Act, 1940.");
        for (const literal of literals) {
          for (let index = 0; index <= literal.length - 4; index += 1) {
            expect(snapshotExport).not.toContain(
              literal.slice(index, index + 4)
            );
          }
        }
        expect(snapshotExport).not.toContain("{{IGNORED}}");
        const feedOtpBoxes = feed.snapshots.flatMap(({ nodes }) =>
          nodes.filter(({ name }) => name.endsWith(" of 6"))
        );
        expect(feedOtpBoxes.length).toBeGreaterThan(0);
        for (const box of feedOtpBoxes) {
          // Snapshots taken before private entry hold an empty box; every
          // filled one must be redacted rather than carrying its digit.
          expect(["", "[sensitive input]", undefined]).toContain(box.value);
          expect(box.valueWithheld).toBe(
            box.value === "[sensitive input]" ? true : undefined
          );
        }
        expect(feed.variables).toEqual([
          { name: "MOBILE", runtime: false, secret: true },
          { name: "PASSWORD", runtime: false, secret: true },
          { name: "OTP", runtime: true, secret: true },
        ]);
        const publicFills = feed.actions.filter(
          ({ action }) => action.type === "fill" && action.text === "AB"
        );
        expect(publicFills).toHaveLength(1);
        expect(
          feed.actions.filter(
            ({ action, actor }) => actor === "user" && action.type === "click"
          )
        ).toHaveLength(2);
        expect(
          feed.actions.some(
            ({ action }) =>
              action.type === "input" && action.input.inputType === "mouse"
          )
        ).toBe(false);
        expect(feed.actions.every(({ actor }) => actor === "user")).toBe(true);
        const privateActions = feed.actions.filter(
          ({ action }) => action.type === "fill" && action.text.startsWith("{{")
        );
        expect(privateActions.map(({ actor }) => actor)).toEqual([
          "user",
          "user",
          "user",
        ]);
        expect(
          privateActions.map(({ action }) =>
            action.type === "fill" ? action.text : ""
          )
        ).toEqual(["{{MOBILE}}", "{{PASSWORD}}", "{{OTP}}"]);

        const [first] = privateActions;
        const last = privateActions.at(-1);
        if (first === undefined || last === undefined) {
          throw new Error("Private Teaching actions were not captured.");
        }
        const draft = {
          description: "Sign in with a reusable identity and a one-time code.",
          domainScope: { hosts: [new URL(started.currentUrl).hostname] },
          schemaVersion: 1 as const,
          steps: [
            {
              confirmation: false,
              description: "Enter the private sign-in values.",
              firstActionId: first.id,
              lastActionId: last.id,
              name: "Enter sign-in values",
            },
          ],
          title: "Private Variable sign in",
        };
        const refused = yield* Effect.flip(
          flow("agent_flow_draft_save", {
            basedOnRevisionId: null,
            draft,
            operationId: OperationId.make("refuse-missing-variables"),
            sessionId: started.id,
          })
        );
        for (const literal of literals) {
          expect(JSON.stringify(refused)).not.toContain(literal);
        }
        expect(refused.diagnostics?.map(({ code }) => code)).toEqual([
          "missing_variable",
          "missing_variable",
          "missing_variable",
        ]);

        const saved = yield* flow("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: { ...draft, variables: feed.variables },
          operationId: OperationId.make("save-private-variables"),
          sessionId: started.id,
        });
        expect(saved.manifest.variables).toEqual(feed.variables);
        const flowRoot = path.join(
          catalogRoot,
          "agent-flows",
          saved.manifest.agentFlowId
        );
        const evidence = yield* Effect.all(
          saved.manifest.steps.map((step) =>
            fileSystem.readFileString(path.join(flowRoot, step.evidence.path))
          )
        );
        const persisted = [
          yield* fileSystem.readFileString(
            path.join(
              flowRoot,
              "revisions",
              saved.manifest.revisionId,
              "manifest.json"
            )
          ),
          ...evidence,
        ].join("\n");
        const evidenceNodes = evidence
          .map((content) =>
            Schema.decodeUnknownSync(EvidenceSlice)(JSON.parse(content))
          )
          .flatMap(({ after, before }) => [before, after])
          .flatMap((snapshot) => snapshot?.nodes ?? []);
        expect(
          evidenceNodes.some(
            ({ name, valueWithheld }) =>
              name.endsWith(" of 6") && valueWithheld === true
          )
        ).toBe(true);
        for (const literal of literals) {
          expect(persisted).not.toContain(literal);
        }
        if (
          artifacts.traceFile === undefined ||
          artifacts.videoFile === undefined ||
          artifacts.retentionFile === undefined
        ) {
          throw new Error("Teaching did not allocate local artifacts.");
        }
        expect(yield* fileSystem.exists(artifacts.traceFile)).toBe(true);
        expect(yield* fileSystem.exists(artifacts.videoFile)).toBe(true);
        const retention = Schema.decodeUnknownSync(
          Schema.Struct({
            files: Schema.Struct({
              trace: Schema.String,
              videos: Schema.Array(Schema.String),
            }),
            retention: Schema.String,
            sensitive: Schema.Boolean,
          })
        )(
          JSON.parse(yield* fileSystem.readFileString(artifacts.retentionFile))
        );
        expect(retention).toMatchObject({
          files: {
            trace: path.basename(artifacts.traceFile),
          },
          retention: "local",
          sensitive: true,
        });
        expect(retention.files.videos).toContain(
          path.basename(artifacts.videoFile)
        );
        expect(retention.files.videos).toHaveLength(2);
        expect(
          (yield* fileSystem.stat(artifacts.videoFile)).size
        ).toBeGreaterThan(0n);
      }).pipe(Effect.scoped, Effect.provide(teachingLayer(catalogRoot)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "keeps the Teaching Feed readable however many screenshots a session took",
  () =>
    Effect.gen(function* boundTheTeachingFeed() {
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-catalog-",
      });
      yield* Effect.gen(function* teachWithScreenshots() {
        const fixtures = yield* fixtureServer;
        const started = yield* session("agent_session_start", {
          activity: "teaching",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("start-bounded-teaching"),
          url: fixtures.url("shop.html"),
          // A realistic viewport: at 400x300 the bytes would be small enough
          // to hide the problem this bound exists for.
          viewport: { deviceScaleFactor: 2, height: 800, width: 1280 },
        });

        const localSession = yield* AgentSession;
        const captured: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          const visual = yield* session("agent_browser_screenshot", {
            sessionId: started.id,
          });
          captured.push(visual.image);
          yield* localSession.userNavigate(started.id, {
            action: "reload",
            type: "history",
          });
        }
        const embedded = captured.reduce(
          (total, image) => total + image.length,
          0
        );
        expect(embedded).toBeGreaterThan(200_000);

        yield* session("agent_session_close", {
          operationId: OperationId.make("close-bounded-teaching"),
          sessionId: started.id,
        });
        const feed = yield* flow("agent_teaching_feed_get", {
          includeSnapshots: false,
          sessionId: started.id,
        });
        expect(feed.screenshots).toHaveLength(5);
        const serialized = JSON.stringify(feed);
        for (const image of captured) {
          expect(serialized).not.toContain(image);
        }
        // The whole feed costs less than one of the images it references, and
        // each reference stays inside its documented budget.
        expect(serialized.length).toBeLessThan(
          captured[0]?.length ?? Number.POSITIVE_INFINITY
        );
        for (const reference of feed.screenshots) {
          expect(JSON.stringify(reference).length).toBeLessThanOrEqual(
            TEACHING_SCREENSHOT_BUDGET_CHARACTERS
          );
        }

        // The bytes are still there, one deliberate fetch at a time, and an
        // unknown reference is refused rather than answered with nothing.
        const fetched = yield* flow("agent_teaching_screenshot_get", {
          screenshotId: firstScreenshot(feed).id,
          sessionId: started.id,
        });
        expect(fetched.image).toBe(captured[0]);
        const unknown = yield* Effect.flip(
          flow("agent_teaching_screenshot_get", {
            screenshotId: "screenshot-missing",
            sessionId: started.id,
          })
        );
        expect(unknown.code).toBe("agent_session_invalid");
      }).pipe(Effect.scoped, Effect.provide(teachingLayer(catalogRoot)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
