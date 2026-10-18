import {
  AgentSessionId,
  BrowserModification,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import type {
  AgentRunSummary,
  BrowserDevtoolsCommand,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeBrowserModifications } from "../../src/services/browser-modifications.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  agentProcessLayer,
  agentViewport,
  catalogTool,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const decodeModifications = Schema.decodeUnknownSync(
  Schema.Struct({ modifications: Schema.Array(BrowserModification) })
);

const summaryModifications = (summary: AgentRunSummary) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ browserModifications: Schema.Array(BrowserModification) })
  )(summary).browserModifications;

it.live(
  "modifies a Run context, replays writes, reverts layered changes, and persists redacted activity",
  () =>
    Effect.gen(function* interactiveModifications() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "browser-modifications-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* modifyRun() {
        const sessions = yield* AgentSession;
        const browser = yield* CreateBrowser;
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("start"),
          referencedSkills: [],
          requestedTask: "Check browser modifications",
          url: fixture.url("devtools.html"),
        });
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const [browserId] = yield* browser.list();
        if (browserId === undefined) {
          return yield* Effect.die("Missing browser");
        }
        const target = yield* browser.activeTarget(browserId);
        const { page, tabId } = target;
        const call = (command: BrowserDevtoolsCommand) =>
          sessions.devtools(run.id, command);
        const list = () =>
          call({ action: "modifications_list" }).pipe(
            Effect.map(decodeModifications),
            Effect.map((result) => result.modifications)
          );
        const remove = (id: string) =>
          call({
            action: "modification_remove",
            id,
            operationId: `remove-${id}`,
          });
        const fetchText = (url: string) =>
          Effect.tryPromise(() =>
            page.evaluate(async (path) => {
              try {
                const response = await fetch(path);
                return await response.text();
              } catch {
                return "request failed";
              }
            }, url)
          );
        const mock = {
          action: "route_add",
          operationId: "mock",
          pattern: "**/mocked",
          resourceType: "fetch",
          response: {
            action: "mock",
            body: "mock body",
            contentType: "text/plain",
            status: 201,
          },
        } as const;
        const first = yield* call(mock);
        expect(yield* call(mock)).toEqual(first);
        expect(
          yield* Effect.flip(call({ ...mock, pattern: "**/different" }))
        ).toMatchObject({ code: "agent_session_conflict" });
        expect(yield* fetchText("/mocked")).toBe("mock body");
        yield* call({
          action: "route_add",
          operationId: "block",
          pattern: "**/blocked",
          response: { action: "block" },
        });
        expect(yield* fetchText("/blocked")).toBe("request failed");
        // The same route on another resource type falls through to the server.
        yield* call({
          ...mock,
          operationId: "image-only",
          pattern: "**/shop.html?type-check",
          resourceType: "image",
        });
        expect(yield* fetchText("/shop.html?type-check")).not.toBe("mock body");
        yield* call({
          action: "headers_set",
          headers: { "x-modification": "agent" },
          operationId: "headers",
        });
        yield* fetchText("/shop.html?headers");
        expect(
          fixture.requestHeaders.find(
            (request) => request.url === "/shop.html?headers"
          )?.headers["x-modification"]
        ).toBe("agent");
        const cookie = {
          domain: "127.0.0.1",
          httpOnly: true,
          name: "injected",
          path: "/",
          secure: false,
          value: "private-cookie",
        };
        yield* call({ action: "cookie_set", cookie, operationId: "cookie" });
        expect(
          yield* Effect.tryPromise(() => target.context.cookies())
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "injected",
              value: "private-cookie",
            }),
          ])
        );
        yield* call({
          action: "cookie_clear",
          domain: cookie.domain,
          name: cookie.name,
          operationId: "cookie-clear",
          path: cookie.path,
        });
        expect(
          (yield* Effect.tryPromise(() => target.context.cookies())).some(
            (entry) => entry.name === cookie.name
          )
        ).toBe(false);
        yield* remove("modification-cookie-clear");
        expect(
          (yield* Effect.tryPromise(() => target.context.cookies())).find(
            (entry) => entry.name === cookie.name
          )?.value
        ).toBe("private-cookie");
        for (const kind of ["local", "session"] as const) {
          yield* call({
            action: "storage_set",
            key: "injected",
            kind,
            operationId: `${kind}-set`,
            value: kind,
          });
          expect(
            yield* browser.getTabStorage(browserId, tabId, kind)
          ).toMatchObject({ entries: { injected: kind } });
          yield* call({
            action: "storage_clear",
            kind,
            operationId: `${kind}-clear`,
          });
          expect(
            yield* browser.getTabStorage(browserId, tabId, kind)
          ).toMatchObject({ entries: {} });
          yield* remove(`modification-${kind}-clear`);
          expect(
            yield* browser.getTabStorage(browserId, tabId, kind)
          ).toMatchObject({ entries: { injected: kind } });
        }
        // Background-tab writes must not switch the active tab.
        yield* browser.newTab(browserId);
        const other = yield* browser.activeTarget(browserId);
        yield* Effect.tryPromise(() =>
          other.page.goto(fixture.url("shop.html"))
        );
        yield* sessions.devtools(
          run.id,
          {
            action: "storage_set",
            key: "background",
            kind: "session",
            operationId: "background",
            value: "yes",
          },
          tabId
        );
        expect(
          yield* browser.getTabStorage(browserId, tabId, "session")
        ).toMatchObject({ entries: { background: "yes" } });
        expect((yield* browser.activeTarget(browserId)).tabId).toBe(
          other.tabId
        );
        expect(
          yield* Effect.tryPromise(() =>
            other.page.evaluate(async () => {
              const response = await fetch("/mocked");
              return await response.text();
            })
          )
        ).toBe("mock body");
        yield* call({
          action: "emulation_set",
          operationId: "scale",
          pageZoom: 150,
          textScale: 200,
        });
        expect(yield* list()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "emulation-scale",
              kind: "emulation",
              pageZoom: 150,
              textScale: 200,
            }),
          ])
        );
        yield* remove("emulation-scale");
        expect(yield* call({ action: "emulation_get" })).toMatchObject({
          pageZoom: 100,
          textScale: 100,
        });
        yield* remove("modification-mock");
        expect(yield* fetchText("/mocked")).not.toBe("mock body");
        yield* remove("modification-headers");
        yield* fetchText("/shop.html?no-headers");
        expect(
          fixture.requestHeaders.find(
            (request) => request.url === "/shop.html?no-headers"
          )?.headers["x-modification"]
        ).toBeUndefined();
        expect(
          yield* Effect.flip(
            call({
              action: "cookie_set",
              cookie: { ...cookie, domain: "outside.test" },
              operationId: "outside-cookie",
            })
          )
        ).toMatchObject({
          code: "agent_session_conflict",
          message: expect.stringContaining("Domain Scope"),
        });
        // Deliberately put a tab outside the boundary without navigating a host.
        yield* Effect.tryPromise(() => other.page.goto("about:blank"));
        expect(
          yield* Effect.flip(
            call({
              action: "storage_set",
              key: "outside",
              kind: "local",
              operationId: "outside-storage",
              value: "no",
            })
          )
        ).toMatchObject({
          code: "agent_session_conflict",
          message: expect.stringContaining("Domain Scope"),
        });
        yield* Effect.tryPromise(() =>
          other.page.goto(fixture.url("shop.html"))
        );
        yield* sessions.takeover(run.id, OperationId.make("takeover"));
        expect(
          yield* Effect.flip(
            call({
              action: "headers_set",
              headers: {},
              operationId: "takeover-deny",
            })
          )
        ).toMatchObject({ code: "agent_control_unavailable" });
        yield* sessions.setStorage(run.id, other.tabId, {
          key: "user",
          kind: "local",
          value: "user-value",
        });
        yield* sessions.deleteStorage(run.id, other.tabId, {
          key: "user",
          kind: "local",
        });
        yield* sessions.clearStorage(run.id, other.tabId, "local");
        const takenOver = yield* sessions.get(run.id);
        expect(
          takenOver.timeline.filter(
            (entry) =>
              entry.actor === "user" &&
              entry.description.includes("browser storage")
          )
        ).toHaveLength(3);
        expect(
          decodeModifications(
            yield* call({ action: "modifications_list" })
          ).modifications.some((entry) =>
            entry.description.includes("user-value")
          )
        ).toBe(false);
        yield* sessions.returnControl(run.id, OperationId.make("return"));
        const summary = yield* runTool("agent_run_complete", {
          operationId: OperationId.make("complete"),
          sessionId: run.id,
        });
        if (!("schemaVersion" in summary)) {
          return yield* Effect.die("Expected task Run Summary");
        }
        expect(summary).toMatchObject({
          browserModifications: expect.arrayContaining([
            expect.objectContaining({
              at: expect.any(String),
              id: "modification-mock",
              removedAt: expect.any(String),
            }),
            expect.objectContaining({
              id: "emulation-scale",
              removedAt: expect.any(String),
            }),
          ]),
        });
        expect(JSON.stringify(summary)).not.toContain("private-cookie");
        const reopened = yield* runTool("open_run", { runId: summary.runId });
        expect(reopened.summary).toMatchObject({
          browserModifications: summaryModifications(summary),
        });
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "allows scoped Teaching state, refuses network setup and every Dry Run write, and scrubs secrets",
  () =>
    Effect.gen(function* authorityAndSecrets() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "modification-authority-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* checkAuthority() {
        const sessions = yield* AgentSession;
        const teaching = yield* sessions.start({
          activity: "teaching",
          openedBy: "agent",
          operationId: "teach",
          url: fixture.url("devtools.html"),
          viewport: agentViewport,
        });
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const requested = yield* sessionTool("agent_variable_request", {
          name: "SECRET",
          operationId: OperationId.make("request"),
          purpose: "Prove modification redaction",
          sessionId: teaching.id,
        });
        const variable = requested.setupVariables?.[0];
        if (variable === undefined) {
          return yield* Effect.die("Missing Variable request");
        }
        const secret = "browser-modification-secret-27491";
        yield* sessions.answerSetupVariable({
          operationId: OperationId.make("supply"),
          requestId: variable.requestId,
          sessionId: teaching.id,
          value: secret,
        });
        const cookie = {
          domain: "127.0.0.1",
          httpOnly: true,
          name: "secret-cookie",
          path: "/",
          secure: false,
          value: secret,
        };
        const commands: Extract<
          BrowserDevtoolsCommand,
          { operationId: string }
        >[] = [
          { action: "cookie_set", cookie, operationId: "cookie" },
          {
            action: "cookie_clear",
            domain: cookie.domain,
            name: cookie.name,
            operationId: "clear-cookie",
            path: "/",
          },
          {
            action: "storage_set",
            key: "private",
            kind: "local",
            operationId: "local",
            value: secret,
          },
          {
            action: "storage_clear",
            kind: "local",
            operationId: "clear-local",
          },
          {
            action: "storage_set",
            key: "private",
            kind: "session",
            operationId: "session",
            value: secret,
          },
          {
            action: "storage_clear",
            kind: "session",
            operationId: "clear-session",
          },
          {
            action: "route_add",
            operationId: "mock",
            pattern: "**/mock",
            response: {
              action: "mock",
              body: secret,
              contentType: "text/plain",
              status: 200,
            },
          },
          {
            action: "headers_set",
            headers: { authorization: secret },
            operationId: "headers",
          },
          { action: "emulation_set", operationId: "scale", textScale: 200 },
          {
            action: "modification_remove",
            id: "modification-cookie",
            operationId: "remove",
          },
        ];
        for (const command of commands.slice(0, 6)) {
          expect(
            JSON.stringify(yield* sessions.devtools(teaching.id, command))
          ).not.toContain(secret);
        }
        for (const command of commands.slice(6, 8)) {
          expect(
            yield* Effect.flip(sessions.devtools(teaching.id, command))
          ).toMatchObject({
            message: expect.stringContaining("Teaching setup"),
          });
        }
        expect(
          decodeModifications(
            yield* sessions.devtools(teaching.id, {
              action: "modifications_list",
            })
          ).modifications
        ).toHaveLength(6);
        expect(
          yield* Effect.flip(
            sessions.devtools(teaching.id, {
              action: "cookie_set",
              cookie: { ...cookie, domain: "example.test" },
              operationId: "outside",
            })
          )
        ).toMatchObject({ message: expect.stringContaining("Domain Scope") });
        const dry = yield* sessions.start({
          activity: "run",
          dryRun: {
            flowSkillName: FlowSkillName.make("dry"),
            inputs: [],
            recordingId: TeachingRecordingId.make("recording-dry"),
          },
          operationId: "dry",
          url: fixture.url("shop.html"),
          viewport: agentViewport,
        });
        for (const command of commands) {
          expect(
            yield* Effect.flip(
              sessions.devtools(dry.id, {
                ...command,
                operationId: `dry-${command.operationId}`,
              })
            )
          ).toMatchObject({
            code: "agent_session_conflict",
            message: expect.stringContaining("Dry Run"),
          });
        }
        expect(
          decodeModifications(
            yield* sessions.devtools(dry.id, { action: "modifications_list" })
          ).modifications
        ).toEqual([]);
        // Routes may match hosts outside the navigation scope.
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("secret-run"),
          referencedSkills: [],
          requestedTask: "Prove scoped routes",
          url: fixture.url("shop.html"),
        });
        // A mock may target an arbitrary host but cannot fulfill its navigation.
        yield* sessions.devtools(run.id, {
          action: "route_add",
          operationId: "any-host",
          pattern: "**/*",
          response: {
            action: "mock",
            body: "should not navigate",
            contentType: "text/plain",
            status: 200,
          },
        });
        const browser = yield* CreateBrowser;
        const ids = yield* browser.list();
        const id = ids.at(-1);
        if (id === undefined) {
          return yield* Effect.die("Missing Run browser");
        }
        const target = yield* browser.activeTarget(id);
        expect(
          yield* Effect.tryPromise(() =>
            target.page.evaluate(async () => {
              const response = await fetch("https://outside.test/api", {
                mode: "no-cors",
              });
              return response.type;
            })
          )
        ).toBe("opaque");
        yield* Effect.tryPromise(() =>
          target.page.evaluate(`new Promise((resolve) => {
          const frame = document.createElement("iframe");
          frame.onload = () => resolve(true);
          frame.src = "https://outside.test/embedded";
          document.body.append(frame);
        })`)
        ).pipe(Effect.timeout("30 seconds"));
        const embedded = target.page
          .frames()
          .find((frame) => frame.url() === "https://outside.test/embedded");
        if (embedded === undefined) {
          return yield* Effect.die("Missing cross-host iframe");
        }
        expect(
          yield* Effect.tryPromise(() => embedded.locator("body").textContent())
        ).toContain("should not navigate");
        yield* Effect.tryPromise(() =>
          target.page.goto("https://outside.test/")
        ).pipe(Effect.ignore);
        const paused = yield* sessions.get(run.id);
        expect(
          paused.pendingDecisions.some(
            (decision) => decision.kind === "boundary"
          )
        ).toBe(true);
        expect(target.page.url()).not.toBe("https://outside.test/");
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "keeps modifications across Flow Skills and redacts secret Variables in the persisted Summary",
  () =>
    Effect.gen(function* composedEvidence() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "modification-skills-",
      });
      const fixture = yield* fixtureServer;
      for (const name of ["first", "second"]) {
        yield* fs.makeDirectory(`${root}/${name}/references`, {
          recursive: true,
        });
        yield* fs.writeFileString(
          `${root}/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: Inspect the browser.\nhosts:\n  - 127.0.0.1\nemulation:\n  viewport: 1280x720@1\ninputs:\n  - name: PASSWORD\n---\n\n1. Inspect the browser. Done when: The page is visible.\n`
        );
        yield* fs.writeFileString(
          `${root}/${name}/references/verification.md`,
          "- Verified: 2026-10-01T00:00:00.000Z\n"
        );
      }
      yield* Effect.gen(function* compose() {
        const sessions = yield* AgentSession;
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("composed-start"),
          referencedSkills: [FlowSkillName.make("first")],
          requestedTask: "Inspect both skills",
          url: fixture.url("shop.html"),
        });
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const request = yield* sessionTool("agent_variable_request", {
          flowSkillName: FlowSkillName.make("first"),
          name: "PASSWORD",
          operationId: OperationId.make("request-secret"),
          sessionId: run.id,
        });
        const decision = request.pendingDecisions.find(
          (entry) => entry.variable?.name === "PASSWORD"
        );
        if (decision === undefined) {
          return yield* Effect.die("Missing private Variable decision");
        }
        const secret = "summary-private-value-41529";
        yield* catalogTool("agent_pending_decision_resolve", {
          decision: "supply",
          operationId: OperationId.make("supply-secret"),
          pendingDecisionId: decision.pendingDecisionId,
          value: secret,
        });
        yield* sessions.devtools(run.id, {
          action: "route_add",
          operationId: "private-mock",
          pattern: "**/private-mock",
          response: {
            action: "mock",
            body: `response ${secret}`,
            contentType: "text/plain",
            status: 200,
          },
        });
        yield* sessions.devtools(run.id, {
          action: "cookie_set",
          cookie: {
            domain: "127.0.0.1",
            httpOnly: true,
            name: "private-cookie",
            path: "/",
            secure: false,
            value: secret,
          },
          operationId: "private-cookie",
        });
        yield* runTool("agent_run_update", {
          inputs: [],
          instruction: "Continue with the second skill",
          operationId: OperationId.make("reference-second"),
          referencedSkills: [FlowSkillName.make("second")],
          sessionId: run.id,
        });
        const browser = yield* CreateBrowser;
        const [browserId] = yield* browser.list();
        if (browserId === undefined) {
          return yield* Effect.die("Missing Run browser");
        }
        const { page, context } = yield* browser.activeTarget(browserId);
        expect(
          yield* Effect.tryPromise(() =>
            page.evaluate(async () => {
              const response = await fetch("/private-mock");
              return await response.text();
            })
          )
        ).toBe(`response ${secret}`);
        expect(
          (yield* Effect.tryPromise(() => context.cookies())).find(
            (entry) => entry.name === "private-cookie"
          )?.value
        ).toBe(secret);
        expect(
          decodeModifications(
            yield* sessions.devtools(run.id, { action: "modifications_list" })
          ).modifications
        ).toHaveLength(2);
        const summary = yield* runTool("agent_run_complete", {
          operationId: OperationId.make("composed-complete"),
          sessionId: run.id,
        });
        expect(JSON.stringify(summary)).not.toContain(secret);
        if (!("schemaVersion" in summary)) {
          return yield* Effect.die("Expected task Run Summary");
        }
        expect(JSON.stringify(summaryModifications(summary))).toContain(
          "response [sensitive input]"
        );
        expect(
          summaryModifications(summary)?.every((entry) => entry.at.length > 0)
        ).toBe(true);
        const reopened = yield* runTool("open_run", { runId: summary.runId });
        expect(JSON.stringify(reopened.summary)).not.toContain(secret);
        expect(reopened.summary).toMatchObject({
          browserModifications: summaryModifications(summary),
        });
        const files = yield* fs.readDirectory(`${root}/agent-runs`);
        expect(files.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("tracks and removes Emulation during agent-held Teaching setup", () =>
  Effect.gen(function* teachingEmulationUndo() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "teaching-undo-",
    });
    const fixture = yield* fixtureServer;
    yield* Effect.gen(function* prepareTeaching() {
      const sessions = yield* AgentSession;
      const teaching = yield* sessions.start({
        activity: "teaching",
        openedBy: "agent",
        operationId: "teach-scale",
        url: fixture.url("emulation-scale.html"),
        viewport: agentViewport,
      });
      yield* Effect.addFinalizer(() => sessions.closeAll());
      const call = (command: BrowserDevtoolsCommand) =>
        sessions.devtools(teaching.id, command);
      const before = yield* call({ action: "emulation_get" });
      yield* call({
        action: "emulation_set",
        operationId: "setup-scale",
        textScale: 200,
      });
      expect(
        decodeModifications(yield* call({ action: "modifications_list" }))
          .modifications
      ).toEqual([
        expect.objectContaining({
          id: "emulation-setup-scale",
          kind: "emulation",
          textScale: 200,
        }),
      ]);
      yield* call({
        action: "modification_remove",
        id: "emulation-setup-scale",
        operationId: "remove-setup-scale",
      });
      expect(yield* call({ action: "emulation_get" })).toEqual(before);
      expect((yield* sessions.get(teaching.id)).browserModifications).toEqual([
        expect.objectContaining({
          id: "emulation-setup-scale",
          removedAt: expect.any(String),
        }),
      ]);
      expect(
        decodeModifications(yield* call({ action: "modifications_list" }))
          .modifications
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const domain of ["localhost", "127.0.0.1", "example.test"]) {
  for (const oldestFirst of [true, false]) {
    it.live(
      `restores ${domain} cookie layers with oldestFirst=${oldestFirst}`,
      () =>
        Effect.gen(function* cookieIdentityUndo() {
          const browser = yield* CreateBrowser;
          const browserId = yield* browser.create(
            "create-cookie-identity",
            agentViewport,
            true
          );
          yield* Effect.addFinalizer(() =>
            browser.close(browserId).pipe(Effect.ignore)
          );
          const target = yield* browser.activeTarget(browserId);
          const modifications = yield* makeBrowserModifications();
          const sessionId = AgentSessionId.make("agent-cookie-identity");
          const cookie = {
            domain,
            httpOnly: false,
            name: "identity",
            path: "/",
            secure: false,
            value: "original",
          };
          yield* Effect.tryPromise(() => target.context.addCookies([cookie]));
          const read = () => Effect.tryPromise(() => target.context.cookies());
          const value = (storedDomain: string) =>
            read().pipe(
              Effect.map(
                (cookies) =>
                  cookies.find((entry) => entry.domain === storedDomain)?.value
              )
            );
          const set = (id: string, spelling: string) =>
            modifications.apply(
              sessionId,
              id,
              {
                action: "cookie_set",
                cookie: { ...cookie, domain: spelling, value: id },
                operationId: id,
              },
              target,
              () => true
            );
          yield* set("dotted", `.${domain}`);
          const dottedDomain =
            domain === "example.test" ? `.${domain}` : domain;
          expect(yield* value(dottedDomain)).toBe("dotted");
          if (domain === "example.test") {
            expect(yield* value(domain)).toBe("original");
          }
          yield* set("bare", domain);
          yield* modifications.remove(
            sessionId,
            oldestFirst ? "dotted" : "bare"
          );
          const afterFirstRemoval = oldestFirst ? "bare" : "dotted";
          expect(yield* value(domain)).toBe(
            domain === "example.test" && !oldestFirst
              ? "original"
              : afterFirstRemoval
          );
          yield* modifications.remove(
            sessionId,
            oldestFirst ? "bare" : "dotted"
          );
          expect(yield* value(domain)).toBe("original");
          if (domain === "example.test") {
            expect(yield* value(dottedDomain)).toBeUndefined();
          }
          // Clearing through the dotted spelling addresses the same stored identity.
          yield* modifications.apply(
            sessionId,
            "clear",
            {
              action: "cookie_clear",
              domain: `.${domain}`,
              name: cookie.name,
              operationId: "clear",
              path: cookie.path,
            },
            target,
            () => true
          );
          expect(yield* value(dottedDomain)).toBeUndefined();
          yield* modifications.remove(sessionId, "clear");
          expect(yield* value(domain)).toBe("original");
        }).pipe(
          Effect.scoped,
          Effect.provide(CreateBrowserLive),
          Effect.provide(NodeServices.layer)
        )
    );
  }
}
