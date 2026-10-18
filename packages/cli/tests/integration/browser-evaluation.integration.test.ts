import type { AgentSessionId } from "@contingency/protocol";
import {
  AgentActionResult,
  BrowserModification,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import type { Page } from "playwright-core";

import { AgentSession } from "../../src/services/agent-session.ts";
import type { AgentSessionService } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  agentProcessLayer,
  agentViewport,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const evaluation = Schema.decodeUnknownSync(
  Schema.Struct({
    failed: Schema.Boolean,
    text: Schema.String,
    truncated: Schema.Boolean,
  })
);
const actionResult = Schema.decodeUnknownSync(AgentActionResult);
const modifications = Schema.decodeUnknownSync(
  Schema.Struct({ modifications: Schema.Array(BrowserModification) })
);

/** Page debugger statements must not freeze the tab once eval has run, and
 * read-only evaluation sees page globals with no realm budget. */
const expectPageStaysResponsive = (
  sessions: AgentSessionService,
  sessionId: AgentSessionId,
  page: Page
) =>
  Effect.gen(function* pageStaysResponsive() {
    expect(
      yield* Effect.tryPromise(() =>
        page.evaluate(() => {
          // oxlint-disable-next-line no-debugger
          debugger;
          return "resumed";
        })
      ).pipe(Effect.timeout("5 seconds"))
    ).toBe("resumed");
    for (let index = 0; index < 300; index += 1) {
      expect(
        evaluation(
          yield* sessions.devtools(sessionId, {
            action: "eval",
            mode: "read_only",
            operationId: `page-global-${index}`,
            script: "window.evaluationFixture",
          })
        )
      ).toEqual({ failed: false, text: '"page-global"', truncated: false });
    }
  });

it.live(
  "evaluates read-only in every activity and scrubs bounded results",
  () =>
    Effect.gen(function* authority() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "eval-authority-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* sessionsProof() {
        const sessions = yield* AgentSession;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const teaching = yield* sessions.start({
          activity: "teaching",
          openedBy: "agent",
          operationId: "teaching",
          url: fixture.url("devtools.html"),
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
          url: fixture.url("devtools.html"),
          viewport: agentViewport,
        });
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("run"),
          referencedSkills: [],
          requestedTask: "Inspect computed style",
          url: fixture.url("devtools.html"),
        });
        for (const session of [teaching, dry, run]) {
          const result = evaluation(
            yield* sessions.devtools(session.id, {
              action: "eval",
              mode: "read_only",
              operationId: `style-${session.id}`,
              script: "getComputedStyle(document.body).display",
            })
          );
          expect(result).toEqual({
            failed: false,
            text: '"block"',
            truncated: false,
          });
          expect((yield* sessions.get(session.id)).pendingDecisions).toEqual(
            []
          );
          const aborted = evaluation(
            yield* sessions.devtools(session.id, {
              action: "eval",
              mode: "read_only",
              operationId: `side-effect-${session.id}`,
              script: "document.body.setAttribute('data-mutated', 'yes')",
            })
          );
          expect(aborted).toMatchObject({
            failed: true,
            text: expect.stringContaining("Request mutating evaluation"),
          });
          expect(
            evaluation(
              yield* sessions.devtools(session.id, {
                action: "eval",
                mode: "read_only",
                operationId: `unchanged-${session.id}`,
                script: "document.body.getAttribute('data-mutated')",
              })
            ).text
          ).toBe("null");
          if (session.id !== run.id) {
            expect(
              yield* Effect.flip(
                sessions.devtools(session.id, {
                  action: "eval",
                  mode: "mutating",
                  operationId: `denied-${session.id}`,
                  script: "document.body.click()",
                })
              )
            ).toMatchObject({
              code: "agent_session_conflict",
              message: expect.stringContaining(
                session.id === dry.id ? "Dry Run" : "Interactive Run"
              ),
            });
          }
        }
        const request = yield* sessionTool("agent_variable_request", {
          name: "SECRET",
          operationId: OperationId.make("secret-request"),
          purpose: "Prove eval redaction",
          sessionId: teaching.id,
        });
        const variable = request.setupVariables?.[0];
        if (variable === undefined) {
          return yield* Effect.die("Missing secret request");
        }
        const secret = "eval-private-sentinel-74181";
        yield* sessions.answerSetupVariable({
          operationId: OperationId.make("secret-supply"),
          requestId: variable.requestId,
          sessionId: teaching.id,
          value: secret,
        });
        for (const script of [
          JSON.stringify(secret),
          `({ [${JSON.stringify(secret)}]: ${JSON.stringify(secret)} })`,
          `(() => { throw new Error(${JSON.stringify(secret)}) })()`,
        ]) {
          const result = evaluation(
            yield* sessions.devtools(teaching.id, {
              action: "eval",
              mode: "read_only",
              operationId: "redaction",
              script,
            })
          );
          expect(result.text).not.toContain(secret);
        }
        const large = evaluation(
          yield* sessions.devtools(teaching.id, {
            action: "eval",
            mode: "read_only",
            operationId: "large",
            script: `'${secret}' + 'x'.repeat(100000)`,
          })
        );
        expect(large.truncated).toBe(true);
        expect(Buffer.byteLength(large.text)).toBeLessThanOrEqual(65_536);
        expect(large.text).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "confirms each mutation once, records irreversible evidence and contains eval transports",
  () =>
    Effect.gen(function* interactive() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "eval-interactive-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* confirmAndEvaluate() {
        const sessions = yield* AgentSession;
        const browser = yield* CreateBrowser;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("run"),
          referencedSkills: [],
          requestedTask: "Test confirmed evaluation",
          url: fixture.url("browser-evaluation.html"),
        });
        const [browserId] = yield* browser.list();
        if (browserId === undefined) {
          return yield* Effect.die("Missing browser");
        }
        const { page } = yield* browser.activeTarget(browserId);
        const call = (operationId: string, script: string) =>
          sessions
            .devtools(run.id, {
              action: "eval",
              mode: "mutating",
              operationId,
              script,
            })
            .pipe(Effect.map(actionResult));
        const click = "document.querySelector('#delete').click()";
        const paused = yield* call("delete", click);
        expect(paused.intervention?.reason).toBe("confirmation");
        expect(
          yield* Effect.tryPromise(() =>
            page.getAttribute("body", "data-deleted")
          )
        ).toBeNull();
        const allow = (decision: "allow" | "refuse", operationId: string) =>
          Effect.gen(function* decide() {
            const [pending] = (yield* sessions.get(run.id)).pendingDecisions;
            if (pending === undefined) {
              return yield* Effect.die("Missing Confirmation");
            }
            return yield* sessions.resolvePendingDecision({
              decision,
              operationId: OperationId.make(operationId),
              pendingDecisionId: pending.pendingDecisionId,
            });
          });
        yield* allow("allow", "allow-delete");
        if (paused.intervention === null || paused.intervention === undefined) {
          return yield* Effect.die("Missing boundary");
        }
        const completed = yield* sessions.resumeBoundary(
          run.id,
          paused.intervention.id
        );
        expect(completed.evaluation?.failed).toBe(false);
        expect(
          yield* Effect.tryPromise(() =>
            page.getAttribute("body", "data-deleted")
          )
        ).toBe("1");
        expect(yield* call("delete", click)).toEqual(completed);
        expect(
          yield* sessions.resumeBoundary(run.id, paused.intervention.id)
        ).toEqual(completed);
        const listed = modifications(
          yield* sessions.devtools(run.id, { action: "modifications_list" })
        );
        expect(listed.modifications).toEqual([
          expect.objectContaining({ kind: "eval", operationId: "delete" }),
        ]);
        expect(
          yield* Effect.flip(
            sessions.devtools(run.id, {
              action: "modification_remove",
              id: "modification-delete",
              operationId: "remove",
            })
          )
        ).toMatchObject({
          message: expect.stringContaining("cannot be undone"),
        });
        const retry = yield* call("retry-delete", click);
        expect(retry.intervention?.id).not.toBe(paused.intervention.id);
        yield* allow("refuse", "refuse-delete");
        const sameIdRetry = yield* call("retry-delete", click);
        expect(sameIdRetry.intervention?.id).not.toBe(retry.intervention?.id);
        yield* allow("refuse", "refuse-same-id-retry");
        expect(
          yield* Effect.flip(call("delete", "document.body.click()"))
        ).toMatchObject({ code: "agent_session_conflict" });
        expect((yield* sessions.get(run.id)).timeline).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ actor: "user", outcome: "refused" }),
          ])
        );
        expect(
          yield* Effect.tryPromise(() =>
            page.getAttribute("body", "data-deleted")
          )
        ).toBe("1");
        const confirmed = (id: string, script: string) =>
          Effect.gen(function* evaluateConfirmed() {
            const pause = yield* call(id, script);
            if (
              pause.intervention === null ||
              pause.intervention === undefined
            ) {
              return yield* Effect.die("Missing network Confirmation");
            }
            yield* allow("allow", `allow-${id}`);
            return yield* sessions.resumeBoundary(
              run.id,
              pause.intervention.id
            );
          });
        const outside = fixture
          .url("shop.html?outside-eval")
          .replace("127.0.0.1", "localhost");
        const expressions = [
          `fetch(${JSON.stringify(outside)})`,
          `(() => { const xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(outside)}); xhr.send(); })()`,
          `navigator.sendBeacon(${JSON.stringify(outside)}, 'blocked')`,
          `new WebSocket(${JSON.stringify(outside.replace("http:", "ws:"))})`,
        ];
        const tampered = yield* confirmed(
          "tampered-prototypes",
          `Object.defineProperty(URL.prototype, 'hostname', {get() {return '127.0.0.1'}}); Array.prototype.some = () => true; new WebSocket(${JSON.stringify(outside.replace("http:", "ws:"))})`
        );
        expect(tampered.evaluation?.text).toContain("outside the Domain Scope");
        for (const [index, expression] of expressions.entries()) {
          for (const [kind, script] of [
            ["direct", expression],
            ["promise", `Promise.resolve().then(() => ${expression})`],
            [
              "timer",
              `new Promise(resolve => setTimeout(() => { try { ${expression}; resolve('unexpected'); } catch (error) { resolve(error.message); } }, 0))`,
            ],
          ]) {
            const result = yield* confirmed(
              `network-${index}-${kind}`,
              script ?? ""
            );
            expect(result.evaluation?.text).toContain(
              "outside the Domain Scope"
            );
          }
        }
        expect(
          fixture.requests.filter((url) => url.includes("outside-eval"))
        ).toEqual([]);
        const iframeSocket = yield* confirmed(
          "iframe-socket",
          `(() => { const frame = document.createElement('iframe'); document.body.append(frame); return new frame.contentWindow.WebSocket(${JSON.stringify(outside.replace("http:", "ws:"))}); })()`
        );
        expect(iframeSocket.evaluation?.text).toContain(
          "outside the Domain Scope"
        );
        const background = yield* confirmed(
          "background",
          `setTimeout(() => { try { navigator.sendBeacon(${JSON.stringify(outside)}, 'blocked'); } catch { document.body.dataset.background = 'blocked'; } }, 0); 'scheduled'`
        );
        expect(background.evaluation?.text).toBe('"scheduled"');
        yield* Effect.tryPromise(() =>
          page
            .locator("body[data-background='blocked']")
            .waitFor({ state: "attached" })
        );
        expect(
          fixture.requests.filter((url) => url.includes("outside-eval"))
        ).toEqual([]);
        const redirect = yield* confirmed(
          "redirect",
          "new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/boundary-redirect'); xhr.addEventListener('error', () => resolve('blocked')); xhr.addEventListener('load', () => resolve('unexpected')); xhr.send(); })"
        );
        expect(redirect.evaluation?.text).toBe('"blocked"');
        expect(fixture.requests).not.toContain("/outside-boundary");
        yield* expectPageStaysResponsive(sessions, run.id, page);
        const inScope = yield* confirmed(
          "in-scope",
          "fetch('/shop.html?in-scope-eval').then(response => response.status)"
        );
        expect(inScope.evaluation).toMatchObject({
          failed: false,
          text: "200",
        });
        expect(fixture.requests).toContain("/shop.html?in-scope-eval");
        yield* sessions.devtools(run.id, {
          action: "route_add",
          operationId: "mock-eval",
          pattern: "**/eval-mocked",
          response: {
            action: "mock",
            body: "mocked eval response",
            contentType: "text/plain",
            status: 200,
          },
        });
        expect(
          (yield* confirmed(
            "mocked-fetch",
            "fetch('/eval-mocked').then(response => response.text())"
          )).evaluation?.text
        ).toBe('"mocked eval response"');
        // Application traffic uses the original APIs in its own realm.
        expect(
          yield* Effect.tryPromise(() =>
            page.evaluate(() =>
              fetch("/shop.html?page-owned").then((response) => response.status)
            )
          )
        ).toBe(200);
        expect(
          yield* Effect.tryPromise(() =>
            page.evaluate(
              (url) =>
                fetch(url, { mode: "no-cors" }).then(
                  (response) => response.type
                ),
              outside
            )
          )
        ).toBe("opaque");
        expect(fixture.requests).toContain("/shop.html?outside-eval");
        const never = yield* call("never", "new Promise(() => {})");
        if (never.intervention === undefined || never.intervention === null) {
          return yield* Effect.die("Missing timeout Confirmation");
        }
        yield* allow("allow", "allow-never");
        expect(
          yield* Effect.flip(
            sessions.resumeBoundary(run.id, never.intervention.id)
          )
        ).toMatchObject({
          code: "agent_browser_failed",
          message: expect.stringContaining("timed out"),
        });
        expect(
          yield* Effect.flip(call("never", "new Promise(() => {})"))
        ).toMatchObject({ code: "agent_browser_failed" });
        const summary = yield* runTool("agent_run_complete", {
          operationId: OperationId.make("complete"),
          sessionId: run.id,
        });
        expect(summary).toMatchObject({
          browserModifications: expect.arrayContaining([
            expect.objectContaining({ kind: "eval", operationId: "delete" }),
          ]),
        });
        const reopened = yield* runTool("open_run", { runId: summary.runId });
        expect(reopened.summary).toMatchObject({
          browserModifications: expect.arrayContaining([
            expect.objectContaining({ kind: "eval" }),
          ]),
        });
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
