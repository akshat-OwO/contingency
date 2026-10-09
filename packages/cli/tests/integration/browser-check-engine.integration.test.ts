import { createServer } from "node:http";

import { UserAgentProfileId } from "@contingency/protocol";
import type {
  BrowserCheck,
  BrowserCheckReference,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Predicate } from "effect";

import { armBrowserChecks } from "../../src/services/browser-check-engine.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";

const reference = (check: BrowserCheck): BrowserCheckReference => ({
  check,
  flowSkillName: "submit",
});

it.live(
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
      const sessionId = yield* browser.create("create-checks", viewport, true);
      yield* Effect.addFinalizer(() =>
        browser.close(sessionId).pipe(Effect.ignore)
      );
      yield* browser.open(sessionId, origin, {
        permissions: [],
        userAgentProfile: UserAgentProfileId.make("chrome-mac"),
        viewport,
      });
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
      expect(
        (yield* stale
          .wait()
          .pipe(Effect.ensuring(Effect.sync(stale.dispose))))[0]?.status
      ).toBe("failed");
      const matching = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "match"
      );
      matching.start();
      yield* trigger(["pending", "ready"]);
      const passed = yield* matching
        .wait()
        .pipe(Effect.ensuring(Effect.sync(matching.dispose)));
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
      staleQuery.start();
      expect(
        (yield* staleQuery
          .wait()
          .pipe(Effect.ensuring(Effect.sync(staleQuery.dispose))))[0]?.status
      ).toBe("failed");
      const queryChecks = yield* armBrowserChecks(
        target,
        [
          reference(completeQuery),
          reference({
            ...completeQuery,
            id: "prefix-query",
            request: { ...completeQuery.request, query: { ref: "batch" } },
          }),
        ],
        "query-submit"
      );
      queryChecks.start();
      yield* Effect.tryPromise(() =>
        target.page.getByRole("button", { name: "Submit" }).click()
      );
      const queryResults = yield* queryChecks
        .wait()
        .pipe(Effect.ensuring(Effect.sync(queryChecks.dispose)));
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
      first.start();
      yield* trigger(["pending", "ready"]);
      expect(
        (yield* first
          .wait()
          .pipe(Effect.ensuring(Effect.sync(first.dispose))))[0]?.status
      ).toBe("failed");
      const invalid = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "unreadable"
      );
      invalid.start();
      yield* Effect.tryPromise(() =>
        target.page.evaluate(async () => {
          await fetch("/signal?invalid=1");
        })
      );
      expect(
        (yield* invalid
          .wait()
          .pipe(Effect.ensuring(Effect.sync(invalid.dispose))))[0]?.status
      ).toBe("inconclusive");
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
      expect(
        (yield* creation
          .wait()
          .pipe(Effect.ensuring(Effect.sync(creation.dispose))))[0]?.status
      ).toBe("passed");
      const existing = yield* armBrowserChecks(
        target,
        [reference(cookie)],
        "existing"
      );
      expect(
        (yield* existing
          .wait()
          .pipe(Effect.ensuring(Effect.sync(existing.dispose))))[0]?.status
      ).toBe("failed");
      const current = yield* armBrowserChecks(
        target,
        [reference({ ...cookie, change: "current" })],
        "current"
      );
      expect(
        (yield* current
          .wait()
          .pipe(Effect.ensuring(Effect.sync(current.dispose))))[0]?.status
      ).toBe("passed");
      const interrupted = yield* armBrowserChecks(
        target,
        [reference(responseCheck)],
        "interrupted"
      );
      const fiber = yield* Effect.forkChild(
        interrupted
          .wait()
          .pipe(Effect.ensuring(Effect.sync(interrupted.dispose)))
      );
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(fiber);
      expect(interrupted.interrupted()[0]?.status).toBe("interrupted");
    }).pipe(
      Effect.scoped,
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);

// gate probe
