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
import { Deferred, Effect, Fiber, FileSystem, Schema, Stream } from "effect";
import type { CDPSession, Page } from "playwright-core";

import { AgentSession } from "../../src/services/agent-session.ts";
import type { AgentSessionService } from "../../src/services/agent-session.ts";
import { evaluateBrowserScript } from "../../src/services/browser-evaluation.ts";
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

/** Hold the last preparation response, then interrupt before user code starts.
 * The real CDP connection supplies the final ordered renderer barrier. */
const expectInterruptedSetupDoesNotDispatch = (page: Page) =>
  Effect.gen(function* interruptSetup() {
    const cdp = yield* Effect.acquireRelease(
      Effect.tryPromise(() => page.context().newCDPSession(page)),
      (session) => Effect.tryPromise(() => session.detach()).pipe(Effect.ignore)
    );
    const prepared = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    let preparation: Promise<unknown> = Promise.resolve();
    const send = cdp.send.bind(cdp);
    const held: CDPSession = Object.assign(Object.create(cdp), {
      on: cdp.on.bind(cdp),
      send: ((method, ...params) => {
        const response = send(method, ...params);
        if (
          method !== "Runtime.evaluate" ||
          !JSON.stringify(params).includes("__contingencyEvaluationGuard")
        ) {
          return response;
        }
        const heldResponse = response.then(async (result) => {
          await Effect.runPromise(Deferred.succeed(prepared, true));
          await Effect.runPromise(Deferred.await(release));
          return result;
        });
        preparation = heldResponse;
        return heldResponse;
      }) satisfies CDPSession["send"],
    });
    const running = yield* evaluateBrowserScript(
      held,
      "document.body.dataset.cancelledEvalRan = 'yes'",
      "mutating",
      ["127.0.0.1"],
      []
    ).pipe(Effect.forkChild);
    yield* Deferred.await(prepared).pipe(Effect.timeout("30 seconds"));
    yield* Fiber.interrupt(running);
    yield* Deferred.succeed(release, true);
    yield* Effect.tryPromise(() => preparation);
    const observed = yield* Effect.tryPromise(() =>
      cdp.send("Runtime.evaluate", {
        expression: "document.body.dataset.cancelledEvalRan ?? null",
        returnByValue: true,
      })
    );
    expect(observed.result.value).toBeNull();
  }).pipe(Effect.scoped);

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
      ).pipe(Effect.timeout("30 seconds"))
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
        expect(
          yield* Effect.flip(
            call("oversized", `${click};/*${"x".repeat(2048)}*/`)
          )
        ).toMatchObject({
          code: "agent_session_invalid",
          message: expect.stringContaining("whole script"),
        });
        expect((yield* sessions.get(run.id)).pendingDecisions).toEqual([]);
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
        yield* Effect.gen(function* containAdditionalChannels() {
          const refusedChannels = [
            `new Promise(resolve => { const code = "fetch('" + ${JSON.stringify(outside)} + "', {mode: 'no-cors'}).then(() => postMessage('sent'))"; const worker = new Worker(URL.createObjectURL(new Blob([code], {type: 'text/javascript'}))); worker.onmessage = event => { worker.terminate(); resolve(event.data); }; })`,
            `new SharedWorker(URL.createObjectURL(new Blob(['onconnect = () => {}'], {type: 'text/javascript'})))`,
            `navigator.serviceWorker.register(${JSON.stringify(outside)})`,
            `ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, ${JSON.stringify(outside)})`,
            `new Promise(resolve => { const source = new EventSource(${JSON.stringify(outside)}); source.onopen = source.onerror = () => { source.close(); resolve('sent'); }; })`,
            `(() => { const peer = new RTCPeerConnection(); peer.close(); return 'created'; })()`,
            `typeof WebTransport === 'undefined' ? 'unavailable' : new WebTransport(${JSON.stringify(outside.replace("http:", "https:"))})`,
          ];
          for (const [index, script] of refusedChannels.entries()) {
            const result = yield* confirmed(`refused-channel-${index}`, script);
            expect(
              fixture.requests.filter((url) => url.includes("outside-eval"))
            ).toEqual([]);
            expect(result.evaluation?.text).toMatch(
              /not available to evaluation|unavailable/u
            );
          }
          const resourceChannels = [
            `import(${JSON.stringify(outside)}).then(() => 'sent', () => 'blocked')`,
            `new Promise(resolve => { const image = new Image(); image.onload = image.onerror = () => resolve('settled'); image.src = ${JSON.stringify(outside)}; })`,
            `new Promise(resolve => { const image = document.createElement('img'); image.onload = image.onerror = () => resolve('settled'); image.src = ${JSON.stringify(outside)}; document.body.append(image); })`,
            `new Promise(resolve => { const script = document.createElement('script'); script.onload = script.onerror = () => resolve('settled'); script.src = ${JSON.stringify(outside)}; document.body.append(script); })`,
          ];
          for (const [index, script] of resourceChannels.entries()) {
            yield* confirmed(`resource-channel-${index}`, script);
            expect(
              fixture.requests.filter((url) => url.includes("outside-eval"))
            ).toEqual([]);
          }
          expect(
            fixture.requests.filter((url) => url.includes("outside-eval"))
          ).toEqual([]);
          const backgroundWorker = yield* confirmed(
            "background-worker",
            `document.addEventListener('start-worker', () => { try { new Worker(URL.createObjectURL(new Blob(["fetch('${outside}', {mode: 'no-cors'})"], {type: 'text/javascript'}))); document.body.dataset.worker = 'escaped'; } catch (error) { document.body.dataset.worker = error.message; } }, {once: true}); 'scheduled'`
          );
          expect(backgroundWorker.evaluation?.text).toBe('"scheduled"');
          yield* Effect.tryPromise(() =>
            page.evaluate("document.dispatchEvent(new Event('start-worker'))")
          );
          expect(
            yield* Effect.tryPromise(() =>
              page.getAttribute("body", "data-worker")
            )
          ).toContain("not available to evaluation");
          expect(
            fixture.requests.filter((url) => url.includes("outside-eval"))
          ).toEqual([]);
        });
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
        yield* Effect.gen(function* interruptEvaluation() {
          const heldScript =
            "new Promise(resolve => { document.addEventListener('release-eval', () => { document.body.dataset.evalReleased = 'yes'; resolve('released'); }, {once: true}); document.body.dataset.evalStarted = 'yes'; })";
          const held = yield* call("takeover-eval", heldScript);
          if (held.intervention === undefined || held.intervention === null) {
            return yield* Effect.die("Missing Takeover Confirmation");
          }
          yield* allow("allow", "allow-takeover-eval");
          const running = yield* sessions
            .resumeBoundary(run.id, held.intervention.id)
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.tryPromise(() =>
            page
              .locator('body[data-eval-started="yes"]')
              .waitFor({ state: "attached" })
          );
          const taken = yield* sessions
            .takeover(run.id, "Interrupt evaluation", "takeover-eval-control")
            .pipe(Effect.timeout("30 seconds"));
          expect(taken.controller).toBe("user");
          const interrupted = yield* Fiber.join(running);
          expect(interrupted).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringContaining("Takeover") },
          });
          yield* Effect.tryPromise(() =>
            page.evaluate("document.dispatchEvent(new Event('release-eval'))")
          );
          expect(
            yield* Effect.flip(
              sessions.resumeBoundary(run.id, held.intervention.id)
            )
          ).toMatchObject({ message: expect.stringContaining("Takeover") });
          expect(
            yield* Effect.flip(call("takeover-eval", heldScript))
          ).toMatchObject({ message: expect.stringContaining("Takeover") });
          expect(
            modifications(
              yield* sessions.devtools(run.id, { action: "modifications_list" })
            ).modifications
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "eval",
                operationId: "takeover-eval",
              }),
            ])
          );
          expect((yield* sessions.get(run.id)).timeline).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                dispatched: true,
                id: "takeover-eval",
                outcome: "interrupted",
              }),
            ])
          );
          expect(
            (yield* sessions.get(run.id)).timeline.some(
              (entry) => entry.id === "evaluation-result-takeover-eval"
            )
          ).toBe(false);
          yield* sessions.returnControl(run.id, "return-after-eval");
          expect(
            yield* Effect.flip(call("takeover-eval", heldScript))
          ).toMatchObject({ message: expect.stringContaining("Takeover") });
        });
        yield* Effect.gen(function* containNavigations() {
          for (const [id, script] of [
            [
              "form",
              `(() => { const form = document.createElement('form'); form.action = ${JSON.stringify(outside.replace("outside-eval", "outside-form"))}; document.body.append(form); form.submit(); })()`,
            ],
            [
              "popup",
              `window.open(${JSON.stringify(outside.replace("outside-eval", "outside-popup"))}); "opened"`,
            ],
          ]) {
            // Top-level documents, including the popup's first request, use the
            // existing navigation boundary rather than initiator attribution.

            yield* confirmed(`navigation-${id}`, script ?? "");
            yield* sessions.changes(run.id).pipe(
              Stream.filter(
                (snapshot) => snapshot.boundary?.reason === "domain"
              ),
              Stream.runHead,
              Effect.timeout("30 seconds")
            );
            expect(
              fixture.requests.filter((url) => url.includes(`outside-${id}`))
            ).toEqual([]);
            expect(page.url()).not.toBe(outside);
            yield* allow("refuse", `refuse-navigation-${id}`);
          }
        });
        yield* expectInterruptedSetupDoesNotDispatch(page);
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
