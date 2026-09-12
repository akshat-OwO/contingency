import {
  BrowserTabId,
  ContingencyRpcs,
  OperationId,
  profileViewport,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { fixtureServer } from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/**
 * Browser setup tooling over the same loopback RPC boundary the Workspace
 * uses, against real Chromium. The browser handle stays inside the Agent
 * Session; every call here names the Agent Session instead (ADR 0038).
 */
const BrowserServices = makeAgentSessionLayer({
  baseUrl: "http://127.0.0.1:7777",
}).pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);
const AgentBrowserSetupLive = RpcHandlersLive.pipe(
  Layer.provide(BrowserServices),
  // The fixture server reads its pages from disk inside the test itself.
  Layer.provideMerge(NodeServices.layer)
);

const phoneViewport = {
  deviceScaleFactor: 3,
  height: 800,
  width: 360,
} as const;

it.live("configures the MCP-owned browser Teaching demonstrates in", () =>
  Effect.gen(function* configureTeachingBrowser() {
    const fixtures = yield* fixtureServer;
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const started = yield* client("agent.session.start", {
      data: {
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        operationId: OperationId.make("start-teaching"),
        url: fixtures.url("shop.html"),
        viewport,
      },
      type: "agent.session.start",
    });
    const sessionId = started.data.session.id;

    const opened = yield* client("agent.browser.emulation.get", {
      data: { sessionId },
      type: "agent.browser.emulation.get",
    });
    expect(opened.data.emulation.viewport).toEqual(viewport);
    expect(opened.data.userAgentProfile).toBe("default");

    const configured = yield* client("agent.browser.emulation.set", {
      data: {
        colorScheme: "dark",
        locale: "de-DE",
        sessionId,
        timezoneId: "Europe/Berlin",
        userAgentProfile: UserAgentProfileId.make("chrome-android-mobile"),
      },
      type: "agent.browser.emulation.set",
    });
    expect(configured.data.emulation.colorScheme).toBe("dark");
    expect(configured.data.emulation.locale).toBe("de-DE");
    expect(configured.data.emulation.timezoneId).toBe("Europe/Berlin");
    expect(configured.data.userAgentProfile).toBe("chrome-android-mobile");
    // An identity brings its own device metrics, so a phone identity is never
    // applied over the desktop window the session opened at (ADR 0013).
    expect(configured.data.emulation.viewport).toEqual(
      profileViewport(UserAgentProfileId.make("chrome-android-mobile"))
    );
    expect(configured.data.emulation.viewport).not.toEqual(viewport);
    expect(configured.data.emulation.browser?.mobile).toBe(true);

    // An explicit viewport in the same patch outranks the identity's metrics.
    const resized = yield* client("agent.browser.emulation.set", {
      data: { sessionId, viewport: phoneViewport },
      type: "agent.browser.emulation.set",
    });
    expect(resized.data.emulation.viewport).toEqual(phoneViewport);
    expect(resized.data.userAgentProfile).toBe("chrome-android-mobile");

    const reread = yield* client("agent.browser.emulation.get", {
      data: { sessionId },
      type: "agent.browser.emulation.get",
    });
    expect(reread.data.emulation).toEqual(resized.data.emulation);
    expect(reread.data.userAgentProfile).toBe("chrome-android-mobile");

    const tabs = yield* client("agent.browser.tabs.get", {
      data: { sessionId },
      type: "agent.browser.tabs.get",
    });
    const activeTab = tabs.data.tabs.find(({ active }) => active);
    expect(activeTab).toBeDefined();
    const tabId = activeTab?.tabId ?? BrowserTabId.make("missing");

    yield* client("agent.browser.storage.set", {
      data: {
        key: "teaching-setup",
        kind: "local",
        sessionId,
        tabId,
        value: "ready",
      },
      type: "agent.browser.storage.set",
    });
    const storage = yield* client("agent.browser.storage.get", {
      data: { kind: "local", sessionId, tabId },
      type: "agent.browser.storage.get",
    });
    expect(storage.data.snapshot).toMatchObject({
      entries: { "teaching-setup": "ready" },
      kind: "local",
    });

    yield* client("agent.browser.storage.clear", {
      data: { kind: "local", sessionId, tabId },
      type: "agent.browser.storage.clear",
    });
    const cleared = yield* client("agent.browser.storage.get", {
      data: { kind: "local", sessionId, tabId },
      type: "agent.browser.storage.get",
    });
    expect(cleared.data.snapshot).toMatchObject({ entries: {}, kind: "local" });

    const requests = yield* client("agent.browser.network.requests.get", {
      data: { sessionId, tabId },
      type: "agent.browser.network.requests.get",
    });
    expect(Array.isArray(requests.data.requests)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserSetupLive))
);

it.live("refuses browser setup while the agent holds the browser", () =>
  Effect.gen(function* refuseSetupDuringAgentControl() {
    const fixtures = yield* fixtureServer;
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    });
    const started = yield* client("agent.session.start", {
      data: {
        activity: "run",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        operationId: OperationId.make("start-run"),
        url: fixtures.url("shop.html"),
        viewport,
      },
      type: "agent.session.start",
    });
    const sessionId = started.data.session.id;

    // Reading what the browser emulates is always allowed: it discloses the
    // session, it does not change it.
    const applied = yield* client("agent.browser.emulation.get", {
      data: { sessionId },
      type: "agent.browser.emulation.get",
    });
    expect(applied.data.emulation.viewport).toEqual(viewport);

    const refused = yield* Effect.flip(
      client("agent.browser.emulation.set", {
        data: { colorScheme: "dark", sessionId },
        type: "agent.browser.emulation.set",
      })
    );
    expect(refused.code).toBe("agent_control_unavailable");

    // Taking over hands the browser to the user, but an Interactive Run still
    // reproduces the Agent Flow's declared Emulation rather than a new one.
    yield* client("agent.session.takeover", {
      data: {
        operationId: OperationId.make("takeover-run"),
        reason: "Configuring the browser.",
        sessionId,
      },
      type: "agent.session.takeover",
    });
    const stillRefused = yield* Effect.flip(
      client("agent.browser.emulation.set", {
        data: { colorScheme: "dark", sessionId },
        type: "agent.browser.emulation.set",
      })
    );
    expect(stillRefused.code).toBe("agent_session_conflict");

    yield* client("agent.session.close", {
      data: { operationId: OperationId.make("close-run"), sessionId },
      type: "agent.session.close",
    });
  }).pipe(Effect.scoped, Effect.provide(AgentBrowserSetupLive))
);
