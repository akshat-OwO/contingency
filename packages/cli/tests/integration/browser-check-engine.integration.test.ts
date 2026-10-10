import { createServer } from "node:http";

import { UserAgentProfileId } from "@contingency/protocol";
import type {
  BrowserCheck,
  BrowserCheckReference,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Predicate } from "effect";
import { TestClock } from "effect/testing";

import { armBrowserChecks } from "../../src/services/browser-check-engine.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { registeredSleeps } from "../helpers/registered-sleeps.ts";

const reference = (check: BrowserCheck): BrowserCheckReference => ({
  check,
  flowSkillName: "submit",
});

const observeChecks = (
  armed: Effect.Success<ReturnType<typeof armBrowserChecks>>,
  deadline?: number
) =>
  Effect.gen(function* expireCheck() {
    const sleeps = yield* registeredSleeps;
    const fiber = yield* Effect.forkChild(
      armed
        .wait()
        .pipe(Effect.ensuring(Effect.sync(armed.dispose)), sleeps.provide)
    );
    if (deadline !== undefined) {
      yield* sleeps.waitForSleep(50);
      yield* TestClock.adjust(deadline + 1);
    }
    return yield* TestClock.withLive(
      Fiber.join(fiber).pipe(Effect.timeout("30 seconds"))
    );
  });
it.effect(
  "uses fresh response identity, deadlines, storage baselines, and interruptible watch lifetimes",
  () =>
    Effect.gen(function* browserChecks() {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/signal") {
          const body = url.searchParams.has("invalid")
            ? "not json"
            : JSON.stringify({
                status: url.searchParams.get("state"),
                token: "private-fixture-token",
              });
          if (url.searchParams.has("cookie")) {
            response.setHeader(
              "set-cookie",
              "checkout=private-fixture-cookie; Path=/; HttpOnly"
            );
          }
          response.writeHead(200, {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json",
          });
          response.end(body);
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<title>Checks</title><button onclick=\"fetch('/signal?state=ready&ref=batch=2026-10')\">Submit</button>"
        );
      });
      yield* Effect.callback<boolean, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(true)));
      });
      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          server.close(() => resume(Effect.succeed(true)));
        })
      );
      const address = server.address();
      if (address === null || Predicate.isString(address)) {
        return yield* Effect.die("No fixture port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const browser = yield* CreateBrowser;
      const viewport = { deviceScaleFactor: 1, height: 480, width: 640 };
      const sessionId = yield* TestClock.withLive(
        browser.create("create-checks", viewport, true)
      );
      yield* Effect.addFinalizer(() =>
        TestClock.withLive(browser.close(sessionId).pipe(Effect.ignore))
      );
      yield* TestClock.withLive(
        browser.open(sessionId, origin, {
          permissions: [],
          userAgentProfile: UserAgentProfileId.make("chrome-mac"),
          viewport,
        })
      );
      const target = yield* browser.activeTarget(sessionId);
      const responseCheck: BrowserCheck = {
        demonstrated: false,
        expectation: {
          itemPath: [],
          predicates: [
            { expected: "ready", operator: "equals", path: ["status"] },
          ],
        },
        id: "ready",
        kind: "response",
        request: { method: "GET", origin, path: "/signal", query: {} },
        response: "matching",
        timeoutMs: 250,
        when: "After Submit",
      };
      const trigger = (states: readonly string[]) =>
        Effect.tryPromise(() =>
          target.page.evaluate(async (values) => {
            for (const value of values) {
              // oxlint-disable-next-line no-await-in-loop -- Arrival order is the assertion in first-response mode.
              await fetch(`/signal?state=${value}`);
            }
          }, states)
        );
      yield* trigger(["ready"]);
      const stale = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "stale"
      );
      expect((yield* observeChecks(stale, 250))[0]?.status).toBe("failed");
      const matching = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "match"
      );
      yield* matching.start();
      yield* trigger(["pending", "ready"]);
      const passed = yield* observeChecks(matching);
      expect(passed[0]?.status).toBe("passed");
      expect(JSON.stringify(passed)).not.toContain("private-fixture-token");
      const completeQuery: BrowserCheck = {
        ...responseCheck,
        id: "complete-query",
        request: { ...responseCheck.request, query: { ref: "batch=2026-10" } },
      };
      yield* Effect.tryPromise(() =>
        target.page.evaluate(async () => {
          await fetch("/signal?state=ready&ref=batch=2026-10");
        })
      );
      const staleQuery = yield* armBrowserChecks(
        target,
        [reference(completeQuery)],
        "stale-query"
      );
      yield* staleQuery.start();
      expect((yield* observeChecks(staleQuery, 250))[0]?.status).toBe("failed");
      const queryChecks = yield* armBrowserChecks(
        target,
        [reference(completeQuery)],
        "query-submit"
      );
      const prefixChecks = yield* armBrowserChecks(
        target,
        [
          reference({
            ...completeQuery,
            id: "prefix-query",
            request: { ...completeQuery.request, query: { ref: "batch" } },
          }),
        ],
        "query-submit"
      );
      yield* queryChecks.start();
      yield* prefixChecks.start();
      yield* TestClock.withLive(
        Effect.tryPromise(async () => {
          const response = target.page.waitForResponse(
            (received) =>
              new URL(received.url()).searchParams.get("ref") ===
              "batch=2026-10"
          );
          await target.page.getByRole("button", { name: "Submit" }).click();
          const received = await response;
          await received.finished();
        }).pipe(Effect.timeout("30 seconds"))
      );
      const queryResults = [
        ...(yield* observeChecks(queryChecks)),
        ...(yield* observeChecks(prefixChecks, 250)),
      ];
      expect(
        queryResults.map(({ id, operationId, status }) => ({
          id,
          operationId,
          status,
        }))
      ).toEqual([
        { id: "complete-query", operationId: "query-submit", status: "passed" },
        { id: "prefix-query", operationId: "query-submit", status: "failed" },
      ]);
      expect(JSON.stringify(queryResults)).not.toContain("batch=2026-10");
      const first = yield* armBrowserChecks(
        target,
        [reference({ ...responseCheck, response: "first" })],
        "first"
      );
      yield* first.start();
      yield* trigger(["pending", "ready"]);
      expect((yield* observeChecks(first))[0]?.status).toBe("failed");
      const invalid = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "unreadable"
      );
      yield* invalid.start();
      yield* Effect.tryPromise(() =>
        target.page.evaluate(async () => {
          await fetch("/signal?invalid=1");
        })
      );
      expect((yield* observeChecks(invalid, 250))[0]?.status).toBe(
        "inconclusive"
      );
      const cookie: BrowserCheck = {
        change: "created",
        demonstrated: false,
        expectation: {
          itemPath: [],
          predicates: [{ operator: "exists", path: [] }],
        },
        id: "cookie",
        kind: "cookie",
        name: "checkout",
        origin,
        timeoutMs: 100,
        when: "After Submit",
      };
      const creation = yield* armBrowserChecks(
        target,
        [reference(cookie)],
        "create"
      );
      yield* Effect.tryPromise(() =>
        target.page.evaluate(async () => {
          await fetch("/signal?cookie=1");
        })
      );
      expect((yield* observeChecks(creation))[0]?.status).toBe("passed");
      const existing = yield* armBrowserChecks(
        target,
        [reference(cookie)],
        "existing"
      );
      expect((yield* observeChecks(existing, 100))[0]?.status).toBe("failed");
      const current = yield* armBrowserChecks(
        target,
        [reference({ ...cookie, change: "current" })],
        "current"
      );
      expect((yield* observeChecks(current))[0]?.status).toBe("passed");
      const interrupted = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "interrupted"
      );
      const sleeps = yield* registeredSleeps;
      const fiber = yield* Effect.forkChild(
        interrupted
          .wait()
          .pipe(
            Effect.ensuring(Effect.sync(interrupted.dispose)),
            sleeps.provide
          )
      );
      yield* sleeps.waitForSleep(50);
      yield* Fiber.interrupt(fiber);
      expect(interrupted.interrupted()[0]?.status).toBe("interrupted");
    }).pipe(
      Effect.scoped,
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);
