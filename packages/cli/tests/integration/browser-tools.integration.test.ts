import path from "node:path";

import {
  AgentActionResult,
  AgentSessionSnapshot,
  BrowserModification,
  BrowserTab,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import type { AgentSessionId, BrowserTabId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema, Stream } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import type { AgentSessionService } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  BrowserDevtoolsTools,
  BrowserDevtoolsToolHandlersLive,
} from "../../src/services/mcp-browser-devtools.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const decodeTabs = Schema.decodeUnknownSync(
  Schema.Struct({ tabs: Schema.Array(BrowserTab) })
);
const decodeDownloads = Schema.decodeUnknownSync(
  Schema.Struct({
    downloads: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.NullOr(Schema.String),
        size: Schema.NullOr(Schema.Number),
        state: Schema.Literals(["saved", "failed"]),
        type: Schema.String,
      })
    ),
  })
);
const decodeText = Schema.decodeUnknownSync(
  Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })
);
const decodeModifications = Schema.decodeUnknownSync(
  Schema.Struct({ modifications: Schema.Array(BrowserModification) })
);
const decodeSnapshot = Schema.decodeUnknownSync(AgentSessionSnapshot);
const decodeAction = Schema.decodeUnknownSync(AgentActionResult);

const fileRef = (sessionId: AgentSessionId) =>
  sessionTool("agent_browser_snapshot", { sessionId }).pipe(
    Effect.map((snapshot) => findNode(snapshot.nodes, "textbox", "Receipt").ref)
  );
const tabsOf = (sessions: AgentSessionService, sessionId: AgentSessionId) =>
  sessions
    .devtools(sessionId, { action: "tabs" })
    .pipe(Effect.map((value) => decodeTabs(value).tabs));

it.live(
  "lists popups, switches and closes tabs, saves downloads, and profiles a tab",
  () =>
    Effect.gen(function* tabsAndDownloads() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "browser-tools-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* driveTabs() {
        const sessions = yield* AgentSession;
        const browser = yield* CreateBrowser;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("run"),
          referencedSkills: [],
          requestedTask: "Use browser tools",
          url: fixture.url("browser-tools.html"),
        });
        const [browserId] = yield* browser.list();
        if (browserId === undefined) {
          return yield* Effect.die("Missing browser");
        }
        const { page } = yield* browser.activeTarget(browserId);
        const [opener] = yield* tabsOf(sessions, run.id);
        if (opener === undefined) {
          return yield* Effect.die("Missing first tab");
        }
        const act = (operationId: string, name: string) =>
          Effect.gen(function* clickNamed() {
            const snapshot = yield* sessionTool("agent_browser_snapshot", {
              sessionId: run.id,
            });
            return yield* sessionTool("agent_browser_act", {
              action: {
                ref: findNode(snapshot.nodes, "button", name).ref,
                type: "click",
              },
              operationId: OperationId.make(operationId),
              sessionId: run.id,
            });
          });

        // A popup the page opens joins the agent's tab list.
        const opened = page.context().waitForEvent("page", { timeout: 30_000 });
        yield* act("open-popup", "Open popup");
        const popupPage = yield* Effect.tryPromise(() => opened);
        yield* Effect.tryPromise(() => popupPage.waitForLoadState());
        const listed = yield* tabsOf(sessions, run.id);
        expect(listed).toHaveLength(2);
        const popup = listed.find((tab) => tab.url.includes("popup-target"));
        if (popup === undefined) {
          return yield* Effect.die("Popup missing from tabs");
        }
        const change = (
          action: "tab_switch" | "tab_close",
          operationId: string,
          tabId: BrowserTabId
        ) =>
          sessions
            .devtools(run.id, { action, operationId }, tabId)
            .pipe(Effect.map(decodeSnapshot));
        const switched = yield* change("tab_switch", "to-popup", popup.tabId);
        expect(switched.currentUrl).toContain("popup-target");
        // Each tab keeps its own network buffer.
        const popupRequests = JSON.stringify(
          yield* sessions.devtools(run.id, { action: "requests" })
        );
        expect(popupRequests).toContain("popup-target.html");
        expect(popupRequests).not.toContain("browser-tools.html");
        // The popup's Snapshot holds only its own elements.
        const popupSnapshot = yield* sessionTool("agent_browser_snapshot", {
          sessionId: run.id,
        });
        expect(
          popupSnapshot.nodes.some((node) => node.name.includes("Copy code"))
        ).toBe(false);
        // Replaying a completed operation does not switch again.
        expect(yield* change("tab_switch", "to-popup", popup.tabId)).toEqual(
          switched
        );
        yield* change("tab_close", "close-popup", popup.tabId);
        expect(yield* tabsOf(sessions, run.id)).toHaveLength(1);
        expect(
          yield* Effect.flip(change("tab_close", "close-last", opener.tabId))
        ).toMatchObject({ message: expect.stringContaining("last tab") });

        const outside = fixture
          .url("shop.html?outside-tab")
          .replace("127.0.0.1", "localhost");
        expect(
          yield* Effect.flip(
            sessions.devtools(run.id, {
              action: "tab_open",
              operationId: "open-outside",
              url: outside,
            })
          )
        ).toMatchObject({ message: expect.stringContaining("Domain Scope") });
        expect(fixture.requests).not.toContain("/shop.html?outside-tab");
        yield* sessions.devtools(run.id, {
          action: "tab_open",
          operationId: "open-inside",
          url: fixture.url("shop.html?inside-tab"),
        });
        const withNew = yield* tabsOf(sessions, run.id);
        expect(withNew.find((tab) => tab.active)?.url).toContain("inside-tab");
        const created = withNew.find((tab) => tab.tabId !== opener.tabId);
        if (created === undefined) {
          return yield* Effect.die("New tab missing");
        }
        yield* change("tab_close", "close-new", created.tabId);

        // A popup to a host outside the Domain Scope never loads.
        const paused = yield* sessions.changes(run.id).pipe(
          Stream.filter((snapshot) => snapshot.boundary?.reason === "domain"),
          Stream.runHead,
          Effect.timeout("30 seconds"),
          Effect.forkChild
        );
        yield* act("open-outside-popup", "Open outside popup");
        yield* Fiber.join(paused);
        expect(fixture.requests).not.toContain(
          "/browser-tools.html?outside-popup"
        );
        const [refusal] = (yield* sessions.get(run.id)).pendingDecisions;
        if (refusal === undefined) {
          return yield* Effect.die("Missing Domain Scope decision");
        }
        yield* sessions.resolvePendingDecision({
          decision: "refuse",
          operationId: OperationId.make("refuse-outside-popup"),
          pendingDecisionId: refusal.pendingDecisionId,
        });

        // Downloads land in the Run's evidence and report name, size and type.
        const saved = yield* sessions.changes(run.id).pipe(
          Stream.filter((snapshot) =>
            snapshot.timeline.some((entry) =>
              entry.description.startsWith("Downloaded report.csv")
            )
          ),
          Stream.runHead,
          Effect.timeout("30 seconds"),
          Effect.forkChild
        );
        yield* Effect.tryPromise(() => page.click("#download"));
        yield* Fiber.join(saved);
        const [download] = decodeDownloads(
          yield* sessions.devtools(run.id, { action: "downloads" })
        ).downloads;
        expect(download).toMatchObject({
          name: "report.csv",
          size: 19,
          state: "saved",
          type: "text/csv",
        });
        expect(download?.path?.startsWith(path.join(root, "agent-runs"))).toBe(
          true
        );
        expect(download?.path).toMatch(/downloads[/\\]download-1$/u);
        expect(yield* fs.readFileString(download?.path ?? "")).toBe(
          "name,total\nanvil,3\n"
        );

        // CPU profiles and traces are written to local files.
        const toolkit = yield* BrowserDevtoolsTools;
        const profile = (kind: "cpu" | "trace", operationId: string) =>
          Effect.gen(function* recordProfile() {
            yield* sessions.devtools(run.id, {
              action: "profile_start",
              kind,
              operationId: `${operationId}-start`,
            });
            yield* Effect.tryPromise(() =>
              page.evaluate(() => {
                let total = 0;
                for (let index = 0; index < 100_000; index += 1) {
                  total += index;
                }
                return total;
              })
            );
            const reference = yield* toolkit
              .handle("agent_browser_devtools", {
                command: {
                  action: "profile_stop",
                  kind,
                  operationId: `${operationId}-stop`,
                },
                sessionId: run.id,
              })
              .pipe(Effect.flatMap(Stream.runLast));
            if (reference._tag === "None") {
              return yield* Effect.die("Missing profile reference");
            }
            const file = Schema.decodeUnknownSync(
              Schema.Struct({ format: Schema.String, path: Schema.String })
            )(reference.value.result);
            expect(file.path.startsWith(root)).toBe(true);
            return { file, text: yield* fs.readFileString(file.path) };
          });
        const cpu = yield* profile("cpu", "cpu");
        expect(cpu.file.format).toBe("cpuprofile");
        expect(JSON.parse(cpu.text)).toHaveProperty("nodes");
        const trace = yield* profile("trace", "trace");
        expect(trace.file.format).toBe("trace");
        expect(JSON.parse(trace.text)).toHaveProperty("traceEvents");
        expect(
          yield* Effect.flip(
            sessions.devtools(run.id, {
              action: "profile_stop",
              kind: "cpu",
              operationId: "not-running",
            })
          )
        ).toMatchObject({
          message: expect.stringContaining("Start one first"),
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(BrowserDevtoolsToolHandlersLive),
        Effect.provide(agentProcessLayer(root))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "replays profiles after persistence failure and scrubs newly supplied private values",
  () =>
    Effect.gen(function* profileReceipts() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "profile-replay-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* driveProfiles() {
        const sessions = yield* AgentSession;
        const browser = yield* CreateBrowser;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const session = yield* sessions.start({
          activity: "teaching",
          openedBy: "agent",
          operationId: "profile-session",
          url: fixture.url("browser-tools.html"),
          viewport: agentViewport,
        });
        const [browserId] = yield* browser.list();
        if (browserId === undefined) {
          return yield* Effect.die("Missing browser");
        }
        const { page } = yield* browser.activeTarget(browserId);
        const toolkit = yield* BrowserDevtoolsTools;
        for (const kind of ["cpu", "trace"] as const) {
          const start = {
            action: "profile_start",
            kind,
            operationId: `${kind}-start`,
          } as const;
          const stop = {
            action: "profile_stop",
            kind,
            operationId: `${kind}-stop`,
          } as const;
          const call = (command: {
            readonly action: "profile_start" | "profile_stop";
            readonly kind: "cpu" | "trace";
            readonly operationId: string;
          }) => sessions.devtools(session.id, command);
          const [started, concurrentRetry] = yield* Effect.all(
            [call(start), call(start)],
            { concurrency: "unbounded" }
          );
          expect(concurrentRetry).toEqual(started);
          expect(yield* call(start)).toEqual(started);
          expect(
            yield* Effect.flip(
              call({ ...start, kind: kind === "cpu" ? "trace" : "cpu" })
            )
          ).toMatchObject({ code: "agent_session_conflict" });
          const secret = `private-${kind}-"\\-value`;
          yield* Effect.tryPromise(() =>
            page.evaluate((value) => {
              performance.mark(value, { detail: { [value]: value } });
              let total = 0;
              for (let index = 0; index < 1_000_000; index += 1) {
                total += index;
              }
              return total;
            }, secret)
          );
          // A regular file at the directory path forces a real filesystem failure.
          const directory = path.join(root, ".devtools");
          yield* fs.writeFileString(directory, "block capture persistence");
          const persist = toolkit
            .handle("agent_browser_devtools", {
              command: stop,
              sessionId: session.id,
            })
            .pipe(Effect.flatMap(Stream.runLast));
          expect(yield* Effect.flip(persist)).toMatchObject({
            code: "agent_devtools_profile_write_failed",
          });
          const decodeCapture = Schema.decodeUnknownSync(
            Schema.Struct({ data: Schema.String })
          );
          const captured = decodeCapture(yield* call(stop));
          if (kind === "trace") {
            expect(captured.data).toContain(
              JSON.stringify(secret).slice(1, -1)
            );
          }
          // Supplying a secret after stop must also scrub the retained receipt.
          const requested = yield* sessionTool("agent_variable_request", {
            name: `SECRET_${kind.toUpperCase()}`,
            operationId: OperationId.make(`${kind}-request`),
            purpose: "Verify capture redaction",
            sessionId: session.id,
          });
          const variable = requested.setupVariables?.find(
            (item) => item.name === `SECRET_${kind.toUpperCase()}`
          );
          if (variable === undefined) {
            return yield* Effect.die("Missing Variable request");
          }
          yield* sessions.answerSetupVariable({
            operationId: OperationId.make(`${kind}-supply`),
            requestId: variable.requestId,
            sessionId: session.id,
            value: secret,
          });
          const redacted = decodeCapture(yield* call(stop));
          if (kind === "trace") {
            expect(redacted.data).toContain(
              JSON.stringify(secret).slice(1, -1)
            );
            const trace = Schema.decodeUnknownSync(
              Schema.Struct({
                traceEvents: Schema.Array(
                  Schema.Struct({ name: Schema.String })
                ),
              })
            )(JSON.parse(redacted.data));
            expect(
              trace.traceEvents.some((event) => event.name === "Screenshot")
            ).toBe(false);
          }
          expect(decodeCapture(yield* call(stop))).toEqual(redacted);
          yield* fs.remove(directory);
          const reference = yield* persist;
          if (reference._tag === "None") {
            return yield* Effect.die("Missing profile file");
          }
          const file = Schema.decodeUnknownSync(
            Schema.Struct({ path: Schema.String })
          )(reference.value.result);
          expect(yield* fs.readFileString(file.path)).toBe(redacted.data);
          // Conflicting stop requests must leave a later capture untouched.
          const laterStart = { ...start, operationId: `${kind}-later-start` };
          yield* call(laterStart);
          expect(
            yield* Effect.flip(
              call({ ...stop, kind: kind === "cpu" ? "trace" : "cpu" })
            )
          ).toMatchObject({ code: "agent_session_conflict" });
          const later = decodeCapture(
            yield* call({ ...stop, operationId: `${kind}-later-stop` })
          );
          expect(JSON.parse(later.data)).toHaveProperty(
            kind === "cpu" ? "nodes" : "traceEvents"
          );
          yield* fs.remove(directory, { recursive: true });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(BrowserDevtoolsToolHandlersLive),
        Effect.provide(agentProcessLayer(root))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "uploads from Catalog Root freely, confirms outside files, and layers clipboard writes",
  () =>
    Effect.gen(function* uploadsAndClipboard() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "browser-uploads-",
      });
      const elsewhere = yield* fs.makeTempDirectoryScoped({
        prefix: "browser-elsewhere-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* driveUploads() {
        const sessions = yield* AgentSession;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const inside = path.join(root, "receipt.txt");
        const outsideFile = path.join(elsewhere, "private.txt");
        yield* fs.writeFileString(inside, "hello");
        yield* fs.writeFileString(outsideFile, "outside!");
        const teaching = yield* sessions.start({
          activity: "teaching",
          openedBy: "agent",
          operationId: "teaching",
          url: fixture.url("browser-tools.html"),
          viewport: agentViewport,
        });
        const dry = yield* sessions.start({
          activity: "run",
          dryRun: {
            flowSkillName: FlowSkillName.make("dry"),
            inputs: [],
            recordingId: TeachingRecordingId.make("recording-dry"),
          },
          operationId: "dry",
          url: fixture.url("browser-tools.html"),
          viewport: agentViewport,
        });
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("run"),
          referencedSkills: [],
          requestedTask: "Upload a receipt",
          url: fixture.url("browser-tools.html"),
        });
        const upload = (
          sessionId: AgentSessionId,
          operationId: string,
          paths: readonly string[]
        ) =>
          Effect.gen(function* uploadFiles() {
            return decodeAction(
              yield* sessions.devtools(sessionId, {
                action: "upload",
                operationId,
                paths,
                ref: yield* fileRef(sessionId),
              })
            );
          });
        const chosen = (sessionId: AgentSessionId) =>
          sessions
            .devtools(sessionId, {
              action: "eval",
              mode: "read_only",
              operationId: `chosen-${sessionId}`,
              script: "document.querySelector('#chosen').textContent",
            })
            .pipe(Effect.map((value) => decodeText(value).text));

        // Teaching setup takes Catalog Root files, but cannot ask for others.
        const teachingUpload = yield* upload(teaching.id, "teach-inside", [
          inside,
        ]);
        expect(teachingUpload.entry.dispatched).toBe(true);
        expect(
          yield* Effect.flip(
            upload(teaching.id, "teach-outside", [outsideFile])
          )
        ).toMatchObject({ message: expect.stringContaining("Catalog Root") });
        // Dry Runs refuse uploads and clipboard writes.
        for (const attempt of [
          upload(dry.id, "dry-upload", [inside]),
          sessions.devtools(dry.id, {
            action: "clipboard_write",
            operationId: "dry-clipboard",
            text: "nope",
          }),
        ]) {
          expect(yield* Effect.flip(attempt)).toMatchObject({
            message: expect.stringContaining("Dry Run"),
          });
        }

        const insideUpload = yield* upload(run.id, "run-inside", [inside]);
        expect(insideUpload.entry.dispatched).toBe(true);
        expect(insideUpload.intervention ?? null).toBeNull();
        expect(yield* chosen(run.id)).toBe('"receipt.txt:5"');
        const paused = yield* upload(run.id, "run-outside", [outsideFile]);
        expect(paused.intervention?.reason).toBe("confirmation");
        const [pending] = (yield* sessions.get(run.id)).pendingDecisions;
        if (
          pending === undefined ||
          paused.intervention === undefined ||
          paused.intervention === null
        ) {
          return yield* Effect.die("Missing upload Confirmation");
        }
        yield* sessions.resolvePendingDecision({
          decision: "allow",
          operationId: OperationId.make("allow-upload"),
          pendingDecisionId: pending.pendingDecisionId,
        });
        const allowed = yield* sessions.resumeBoundary(
          run.id,
          paused.intervention.id
        );
        expect(allowed.entry.dispatched).toBe(true);
        expect(yield* chosen(run.id)).toBe('"private.txt:8"');
        const listed = decodeModifications(
          yield* sessions.devtools(run.id, { action: "modifications_list" })
        ).modifications;
        expect(listed.filter((entry) => entry.kind === "upload")).toHaveLength(
          2
        );
        expect(
          yield* Effect.flip(
            sessions.devtools(run.id, {
              action: "modification_remove",
              id: "modification-run-inside",
              operationId: "remove-upload",
            })
          )
        ).toMatchObject({
          message: expect.stringContaining("cannot be undone"),
        });

        // Clipboard writes are Browser Modifications that removal restores.
        const read = () =>
          sessions
            .devtools(run.id, { action: "clipboard_read" })
            .pipe(Effect.map((value) => decodeText(value).text));
        const before = yield* read();
        yield* sessions.devtools(run.id, {
          action: "clipboard_write",
          operationId: "write-clipboard",
          text: "agent-text",
        });
        expect(yield* read()).toBe("agent-text");
        yield* sessions.devtools(run.id, {
          action: "modification_remove",
          id: "modification-write-clipboard",
          operationId: "remove-clipboard",
        });
        expect(yield* read()).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
