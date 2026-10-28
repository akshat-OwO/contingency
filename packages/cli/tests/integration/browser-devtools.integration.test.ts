import {
  BrowserConsoleEntry,
  BrowserTabId,
  BrowserNetworkRequestDetail,
  OperationId,
  FlowSkillName,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Schema, Stream } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { DEVTOOLS_LIMITS } from "../../src/services/browser-devtools.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  BrowserDevtoolsTools,
  BrowserDevtoolsToolHandlersLive,
} from "../../src/services/mcp-browser-devtools.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const Requests = Schema.Struct({
  dropped: Schema.Int,
  requests: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      requestId: Schema.String,
      status: Schema.optionalKey(Schema.Int),
      url: Schema.String,
    })
  ),
});
const Console = Schema.Struct({
  dropped: Schema.Int,
  entries: Schema.Array(BrowserConsoleEntry),
});
const decodeRequests = Schema.decodeUnknownSync(Requests);
const decodeConsole = Schema.decodeUnknownSync(Console);

it.live(
  "scrubs a supplied Variable typed into a form from every devtools read and HAR",
  () =>
    Effect.gen(function* secretObservation() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "devtools-private-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* observeSecret() {
          const service = yield* AgentSession;
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "test",
            clientVersion: "1",
            name: "observe",
            operationId: OperationId.make("start"),
            url: fixture.url("devtools.html"),
            viewport: agentViewport,
          });
          const sessionId = started.id;
          const call = (command: Parameters<typeof service.devtools>[1]) =>
            service.devtools(sessionId, command);
          expect(
            decodeConsole(yield* call({ action: "console" })).entries.some(
              ({ text }) => text.includes("loaded before")
            )
          ).toBe(true);
          const requested = yield* sessionTool("agent_variable_request", {
            name: "SECRET",
            operationId: OperationId.make("request"),
            purpose: "Prove private input redaction",
            sessionId,
          });
          const variable = requested.setupVariables?.[0];
          if (variable === undefined) {
            return yield* Effect.die("Missing Variable request");
          }
          const secret = "private-form-value-91348";
          yield* service.answerSetupVariable({
            operationId: OperationId.make("supply"),
            requestId: variable.requestId,
            sessionId,
            value: secret,
          });
          const snapshot = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          yield* sessionTool("agent_variable_enter", {
            name: "SECRET",
            operationId: OperationId.make("enter"),
            ref: findNode(snapshot.nodes, "textbox", "Private input").ref,
            sessionId,
          });
          yield* call({ action: "har_start", operationId: "capture" });
          yield* call({ action: "har_start", operationId: "capture" });
          const current = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const uncaught = yield* service.browserStream(sessionId).pipe(
            Stream.filter((event) => event.type === "page_error"),
            Stream.runHead,
            Effect.timeout("30 seconds"),
            Effect.forkChild
          );
          yield* sessionTool("agent_browser_act", {
            action: {
              ref: findNode(current.nodes, "button", "Send observation").ref,
              type: "click",
            },
            operationId: OperationId.make("send"),
            sessionId,
          });
          const pageError = yield* Fiber.join(uncaught);
          expect(pageError._tag).toBe("Some");
          expect(JSON.stringify(pageError)).toContain(secret);
          // The action's settled Snapshot waits for the completed HTTP request.
          const result = decodeRequests(
            yield* call({
              action: "requests",
              method: "post",
              resourceType: "fetch",
              statusMax: 500,
              statusMin: 500,
              url: "devtools-echo",
            })
          );
          expect(result.requests).toHaveLength(1);
          const [request] = result.requests;
          if (request === undefined) {
            return yield* Effect.die("Missing failed request");
          }
          for (const command of [
            { action: "requests", url: "does-not-exist" },
            { action: "requests", method: "GET", url: "devtools-echo" },
            { action: "requests", statusMax: 499, url: "devtools-echo" },
            { action: "requests", statusMin: 501, url: "devtools-echo" },
            {
              action: "requests",
              resourceType: "document",
              url: "devtools-echo",
            },
          ] as const) {
            expect(decodeRequests(yield* call(command)).requests).toEqual([]);
          }
          const detail = yield* call({
            action: "request",
            requestId: request.requestId,
          });
          const decoded = Schema.decodeUnknownSync(BrowserNetworkRequestDetail)(
            detail
          );
          expect(decoded.status).toBe(500);
          expect(decoded.headers["authorization"]).toContain(secret);
          expect(decoded.responseHeaders?.["set-cookie"]).toContain(
            "never-show-this"
          );
          expect(decoded.bodyTruncated).toBe(true);
          expect(
            Buffer.byteLength(decoded.responseBody ?? "")
          ).toBeLessThanOrEqual(DEVTOOLS_LIMITS.bodyBytes);
          for (const value of [
            result,
            detail,
            yield* call({ action: "console" }),
            yield* call({ action: "storage", kind: "cookies" }),
            yield* call({ action: "storage", kind: "local" }),
            yield* call({ action: "storage", kind: "session" }),
          ]) {
            expect(JSON.stringify(value)).toContain(secret);
          }
          const toolkit = yield* BrowserDevtoolsTools;
          const stop = () =>
            toolkit
              .handle("agent_browser_devtools", {
                command: { action: "har_stop", operationId: "stop" },
                sessionId,
              })
              .pipe(
                Effect.flatMap((stream) =>
                  Effect.gen(function* readHarReference() {
                    return yield* Stream.runLast(stream);
                  })
                )
              );
          const reference = yield* stop();
          if (reference._tag === "None") {
            return yield* Effect.die("Missing HAR reference");
          }
          const file = Schema.decodeUnknownSync(
            Schema.Struct({ path: Schema.String })
          )(reference.value.result);
          expect(file.path.startsWith(root)).toBe(true);
          const har = yield* fs.readFileString(file.path);
          expect(har).toContain(secret);
          expect(har).toContain("never-show-this");
          expect(har).toContain('"status":500');
          expect(yield* stop()).toEqual(reference);
          expect(
            decodeConsole(yield* call({ action: "console" })).entries.some(
              (entry) => entry.type === "page_error"
            )
          ).toBe(true);
          yield* call({ action: "clear_console" });
          expect(
            decodeConsole(yield* call({ action: "console" })).entries
          ).toEqual([]);
          yield* service.closeAll();
        }).pipe(
          Effect.provide(BrowserDevtoolsToolHandlersLive),
          Effect.provide(agentProcessLayer(root))
        )
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it.live(
  "drops oldest requests and console entries per tab, and isolates capture windows",
  () =>
    Effect.gen(function* retention() {
      const fixture = yield* fixtureServer;
      const browser = yield* CreateBrowser;
      const sessionId = yield* browser.create(
        "create-retention",
        agentViewport,
        true
      );
      yield* Effect.addFinalizer(() =>
        browser.close(sessionId).pipe(Effect.ignore)
      );
      const { page, tabId } = yield* browser.activeTarget(sessionId);
      const tools = yield* browser.devtools(sessionId, tabId);
      yield* Effect.tryPromise(() => page.goto(fixture.url("devtools.html")));
      const [first] = tools.requests().requests;
      yield* Effect.tryPromise(() =>
        page.evaluate(async (count) => {
          for (let i = 0; i < count; i += 1) {
            // Sequential requests make oldest-first eviction observable.
            // oxlint-disable-next-line no-await-in-loop
            await fetch(`/shop.html?n=${i}`).then((response) =>
              response.text()
            );
            console.log(`entry ${i}`);
          }
        }, DEVTOOLS_LIMITS.requests + 3)
      );
      const retained = tools.requests();
      expect(retained.requests).toHaveLength(DEVTOOLS_LIMITS.requests);
      expect(retained.dropped).toBeGreaterThanOrEqual(4);
      expect(retained.requests[0]?.url).toContain("n=3");
      if (first === undefined) {
        return yield* Effect.die("Missing initial request");
      }
      expect(
        yield* Effect.flip(tools.request(first.requestId, []))
      ).toMatchObject({ code: "agent_browser_failed" });
      const logs = tools.console([]);
      expect(logs.entries).toHaveLength(DEVTOOLS_LIMITS.console);
      expect(logs.dropped).toBeGreaterThan(0);
      tools.startHar("start");
      yield* Effect.tryPromise(() =>
        page.evaluate(async () => {
          await fetch("/shop.html?captured").then((response) =>
            response.text()
          );
        })
      );
      const har = yield* tools.stopHar([], "stop");
      expect(JSON.stringify(har)).toContain("captured");
      expect(JSON.stringify(har)).not.toContain("n=3");
      const held = yield* fixture.holdRequest("/pending-har");
      tools.startHar("pending-start");
      yield* Effect.tryPromise(() =>
        page.evaluate(() => {
          void fetch("/pending-har");
        })
      );
      yield* Deferred.await(held.arrived).pipe(Effect.timeout("30 seconds"));
      const pendingHar = yield* tools
        .stopHar([], "pending-stop")
        .pipe(Effect.timeout("30 seconds"));
      expect(JSON.stringify(pendingHar)).toContain('"_unavailable":true');
      yield* Deferred.succeed(held.release, true);
      yield* browser.newTab(sessionId);
      const other = yield* browser.devtools(sessionId);
      expect(other.requests().requests).toEqual([]);
      expect(other.console([]).entries).toEqual([]);
      tools.clearConsole();
      expect(tools.console([])).toEqual({ dropped: 0, entries: [] });
    }).pipe(
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);

it.live("observes fresh Dry Run contexts without granting page writes", () =>
  Effect.gen(function* dryRunObservation() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "devtools-dry-" });
    const fixture = yield* fixtureServer;
    yield* Effect.scoped(
      Effect.gen(function* observeDryRun() {
        const sessions = yield* AgentSession;
        const session = yield* sessions.start({
          activity: "run",
          dryRun: {
            flowSkillName: FlowSkillName.make("observe"),
            inputs: [],
            recordingId: TeachingRecordingId.make("recording-observe"),
          },
          operationId: "dry-observe",
          url: fixture.url("devtools.html"),
          viewport: agentViewport,
        });
        expect(session.dryRun).not.toBeNull();
        expect(
          decodeRequests(
            yield* sessions.devtools(session.id, {
              action: "requests",
              resourceType: "document",
            })
          ).requests
        ).toHaveLength(1);
        expect(
          decodeConsole(
            yield* sessions.devtools(session.id, { action: "console" })
          ).entries.some(({ text }) => text.includes("loaded before"))
        ).toBe(true);
        expect(
          yield* sessions.devtools(session.id, {
            action: "storage",
            kind: "local",
          })
        ).toMatchObject({ entries: {} });
        expect(
          yield* sessions.devtools(session.id, {
            action: "storage",
            kind: "session",
          })
        ).toMatchObject({ entries: {} });
        const tabs = yield* sessions.tabs(session.id);
        const tab = tabs.find(({ active }) => active);
        if (tab === undefined) {
          return yield* Effect.die("Missing active tab");
        }
        expect(
          yield* Effect.flip(
            sessions.setStorage(session.id, tab.tabId, {
              key: "test",
              kind: "local",
              value: "write",
            })
          )
        ).toMatchObject({ code: "agent_control_unavailable" });
        yield* sessions.closeAll();
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.provide(NodeServices.layer))
);

it.live("reads background tab storage without changing the active tab", () =>
  Effect.gen(function* backgroundStorage() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "devtools-tabs-",
    });
    const fixture = yield* fixtureServer;
    yield* Effect.scoped(
      Effect.gen(function* inspectBackgroundStorage() {
        const sessions = yield* AgentSession;
        const browser = yield* CreateBrowser;
        const session = yield* sessions.start({
          activity: "teaching",
          operationId: "background-storage",
          url: fixture.url("devtools.html"),
          viewport: agentViewport,
        });
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const [browserSessionId] = yield* browser.list();
        if (browserSessionId === undefined) {
          return yield* Effect.die("Missing browser session");
        }
        const { page, tabId } = yield* browser.activeTarget(browserSessionId);
        yield* Effect.tryPromise(() =>
          page
            .context()
            .addCookies([
              { name: "background", url: page.url(), value: "tab-a" },
            ])
        );
        yield* Effect.tryPromise(() =>
          page.evaluate(() => {
            localStorage.setItem("background", "local-a");
            sessionStorage.setItem("background", "session-a");
          })
        );
        yield* browser.newTab(browserSessionId);
        const tabB = yield* browser.activeTarget(browserSessionId);
        expect(tabB.tabId).not.toBe(tabId);
        for (const kind of ["cookies", "local", "session"] as const) {
          const snapshot = yield* sessions.devtools(
            session.id,
            { action: "storage", kind },
            tabId
          );
          expect(snapshot).toMatchObject(
            kind === "cookies"
              ? {
                  cookies: [{ name: "background", value: "tab-a" }],
                  kind,
                  tabId,
                }
              : { entries: { background: `${kind}-a` }, kind, tabId }
          );
          expect((yield* browser.activeTarget(browserSessionId)).tabId).toBe(
            tabB.tabId
          );
          expect(yield* sessions.storage(session.id, tabId, kind)).toEqual(
            kind === "cookies"
              ? { cookies: [], kind, tabId }
              : { entries: {}, kind, tabId }
          );
          const missing = BrowserTabId.make("missing-tab");
          expect(
            yield* Effect.flip(
              browser.getTabStorage(browserSessionId, missing, kind)
            )
          ).toMatchObject({
            code: "session_not_found",
            message: `Browser tab ${missing} was not found.`,
          });
          expect(
            yield* Effect.flip(
              sessions.devtools(
                session.id,
                { action: "storage", kind },
                missing
              )
            )
          ).toMatchObject({ message: `Browser tab ${missing} was not found.` });
        }
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.provide(NodeServices.layer))
);
