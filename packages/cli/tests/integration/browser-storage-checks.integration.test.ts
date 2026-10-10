import { createServer } from "node:http";

import { UserAgentProfileId } from "@contingency/protocol";
import type { BrowserCheck, BrowserPredicate } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Predicate } from "effect";
import { TestClock } from "effect/testing";

import { armBrowserChecks } from "../../src/services/browser-check-engine.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { registeredSleeps } from "../helpers/registered-sleeps.ts";

const order = JSON.stringify({
  order: {
    items: [
      { qty: 2, sku: "a" },
      { qty: 1, sku: "b" },
    ],
    status: "ready",
    total: 42,
  },
});

/** A real Page on a loopback origin whose storage the checks read. */
const storagePage = Effect.gen(function* openStoragePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Storage</title>");
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
  const sessionId = yield* browser.create("create-storage", viewport, true);
  yield* Effect.addFinalizer(() =>
    browser.close(sessionId).pipe(Effect.ignore)
  );
  yield* browser.open(sessionId, origin, {
    permissions: [],
    userAgentProfile: UserAgentProfileId.make("chrome-mac"),
    viewport,
  });
  const target = yield* browser.activeTarget(sessionId);
  return { origin, target };
});

it.effect(
  "evaluates raw and JSON local/session storage with raw change baselines",
  () =>
    Effect.gen(function* storageChecks() {
      const { origin, target } = yield* TestClock.withLive(storagePage);
      const write = (kind: "local" | "session", value?: string) =>
        Effect.tryPromise(() =>
          target.page.evaluate(
            ({ area, next }) => {
              const store = area === "local" ? localStorage : sessionStorage;
              if (next === null) {
                store.removeItem("order");
              } else {
                store.setItem("order", next);
              }
            },
            { area: kind, next: value ?? null }
          )
        );
      const evaluate = (
        check: BrowserCheck,
        change?: Effect.Effect<unknown, unknown>,
        expire = false
      ) =>
        Effect.gen(function* evaluateCheck() {
          const armed = yield* armBrowserChecks(
            target,
            [{ check, flowSkillName: "storage" }],
            check.id
          );
          yield* armed.start();
          const sleeps = yield* registeredSleeps;
          const fiber = yield* Effect.forkChild(
            armed
              .wait()
              .pipe(Effect.ensuring(Effect.sync(armed.dispose)), sleeps.provide)
          );
          if (change !== undefined) {
            yield* sleeps.waitForSleep(50);
            yield* change;
            yield* TestClock.adjust(50);
          }
          if (expire) {
            yield* sleeps.waitForSleep(50);
            yield* TestClock.adjust(check.timeoutMs + 1);
          }
          const [result] = yield* TestClock.withLive(
            Fiber.join(fiber).pipe(Effect.timeout("30 seconds"))
          );
          expect(JSON.stringify(result)).not.toContain("private-order");
          return result?.status;
        });
      for (const kind of ["local", "session"] as const) {
        const check = (
          id: string,
          fields: {
            readonly change?: "current" | "created" | "changed";
            readonly format?: "raw" | "json";
            readonly itemPath?: readonly (string | number)[];
            readonly predicates: readonly BrowserPredicate[];
          }
        ): BrowserCheck => {
          const base: BrowserCheck = {
            change: fields.change ?? "current",
            demonstrated: false,
            expectation: {
              itemPath: fields.itemPath ?? [],
              predicates: fields.predicates,
            },
            id: `${kind}-${id}`,
            kind,
            name: "order",
            origin,
            timeoutMs: 150,
            when: "After the action",
          };
          return fields.format === undefined
            ? base
            : { ...base, format: fields.format };
        };
        const nested = check("nested", {
          format: "json",
          predicates: [
            {
              expected: "ready",
              operator: "equals",
              path: ["order", "status"],
            },
            { expected: 40, operator: "gt", path: ["order", "total"] },
          ],
        });
        yield* write(kind, order);
        expect(yield* evaluate(nested)).toBe("passed");
        expect(
          yield* evaluate(
            check("grouped", {
              format: "json",
              itemPath: ["order", "items", "*"],
              predicates: [
                { expected: "b", operator: "equals", path: ["sku"] },
                { expected: 1, operator: "equals", path: ["qty"] },
              ],
            })
          )
        ).toBe("passed");
        expect(
          yield* evaluate(
            check("grouped-mismatch", {
              format: "json",
              itemPath: ["order", "items", "*"],
              predicates: [
                { expected: "b", operator: "equals", path: ["sku"] },
                { expected: 2, operator: "equals", path: ["qty"] },
              ],
            }),
            undefined,
            true
          )
        ).toBe("failed");
        const rawOrder = {
          predicates: [
            { expected: order, operator: "equals" as const, path: [] },
          ],
        };
        expect(yield* evaluate(check("omitted-raw", rawOrder))).toBe("passed");
        expect(
          yield* evaluate(check("explicit-raw", { ...rawOrder, format: "raw" }))
        ).toBe("passed");
        expect(
          yield* evaluate(
            check("raw-not-decoded", {
              format: "raw",
              predicates: [
                { expected: "order", operator: "contains", path: [] },
              ],
            })
          )
        ).toBe("passed");
        yield* write(kind, "null");
        expect(
          yield* evaluate(
            check("root-null", {
              format: "json",
              predicates: [{ expected: null, operator: "equals", path: [] }],
            })
          )
        ).toBe("passed");
        yield* write(kind, "");
        expect(
          yield* evaluate(
            check("raw-empty", {
              predicates: [{ expected: "", operator: "equals", path: [] }],
            })
          )
        ).toBe("passed");
        expect(
          yield* evaluate(
            check("json-empty", {
              format: "json",
              predicates: [{ operator: "exists", path: [] }],
            }),
            undefined,
            true
          )
        ).toBe("inconclusive");
        yield* write(kind, '{"private-order":');
        expect(yield* evaluate(nested, undefined, true)).toBe("inconclusive");
        expect(yield* evaluate(nested, write(kind, order))).toBe("passed");
        yield* write(
          kind,
          JSON.stringify({
            order: { padding: "x".repeat(65_536), status: "ready" },
          })
        );
        expect(
          yield* evaluate(
            check("oversized", {
              format: "json",
              predicates: [
                {
                  expected: "ready",
                  operator: "equals",
                  path: ["order", "status"],
                },
              ],
            }),
            undefined,
            true
          )
        ).toBe("inconclusive");
        yield* write(kind);
        expect(
          yield* evaluate(
            check("absent", {
              format: "json",
              predicates: [{ operator: "exists", path: [] }],
            }),
            undefined,
            true
          )
        ).toBe("failed");
        expect(
          yield* evaluate(
            check("created", {
              change: "created",
              format: "json",
              predicates: [
                {
                  expected: "ready",
                  operator: "equals",
                  path: ["order", "status"],
                },
              ],
            }),
            write(kind, order)
          )
        ).toBe("passed");
        const changed = check("changed", {
          change: "changed",
          format: "json",
          predicates: [
            {
              expected: "ready",
              operator: "equals",
              path: ["order", "status"],
            },
          ],
        });
        expect(yield* evaluate(changed, write(kind, order), true)).toBe(
          "failed"
        );
        expect(
          yield* evaluate(
            changed,
            write(kind, JSON.stringify(JSON.parse(order), undefined, 2))
          )
        ).toBe("passed");
        yield* write(kind);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);

it.effect("fails a storage check whose last read the deadline cut short", () =>
  Effect.gen(function* deadlineCutRead() {
    const { origin, target } = yield* TestClock.withLive(storagePage);
    // The baseline and the first watched read answer; every read after them
    // stays pending past the check's deadline, as a busy CI renderer does.
    yield* Effect.tryPromise(() =>
      target.page.evaluate(() => {
        const read = Storage.prototype.getItem;
        let reads = 0;
        Object.defineProperty(Storage.prototype, "getItem", {
          value(name: string) {
            reads += 1;
            if (reads > 2) {
              console.debug("storage-read-stalled");
              // Leave the Page read pending until the watch cuts it short.
              return Promise.withResolvers<never>().promise;
            }
            return read.call(this, name);
          },
        });
      })
    );
    const armed = yield* armBrowserChecks(
      target,
      [
        {
          check: {
            change: "current",
            demonstrated: false,
            expectation: {
              itemPath: [],
              predicates: [{ operator: "exists", path: [] }],
            },
            format: "json",
            id: "absent",
            kind: "local",
            name: "order",
            origin,
            timeoutMs: 1000,
            when: "After the action",
          },
          flowSkillName: "storage",
        },
      ],
      "deadline-cut"
    );
    yield* armed.start();
    const stalled = target.page.waitForEvent("console", {
      predicate: (message) => message.text() === "storage-read-stalled",
    });
    const sleeps = yield* registeredSleeps;
    const fiber = yield* Effect.forkChild(
      armed
        .wait()
        .pipe(Effect.ensuring(Effect.sync(armed.dispose)), sleeps.provide)
    );
    yield* sleeps.waitForSleep(50);
    yield* TestClock.adjust(50);
    yield* TestClock.withLive(
      Effect.tryPromise(() => stalled).pipe(Effect.timeout("30 seconds"))
    );
    yield* sleeps.waitForSleep(950);
    yield* TestClock.adjust(1001);
    const [result] = yield* TestClock.withLive(
      Fiber.join(fiber).pipe(Effect.timeout("30 seconds"))
    );
    expect(result?.status).toBe("failed");
  }).pipe(
    Effect.scoped,
    Effect.provide(CreateBrowserLive),
    Effect.provide(NodeServices.layer)
  )
);
