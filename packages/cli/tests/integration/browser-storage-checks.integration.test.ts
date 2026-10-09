import { createServer } from "node:http";

import { UserAgentProfileId } from "@contingency/protocol";
import type { BrowserCheck, BrowserPredicate } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Predicate } from "effect";

import { armBrowserChecks } from "../../src/services/browser-check-engine.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";

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

it.live(
  "evaluates raw and JSON local/session storage with raw change baselines",
  () =>
    Effect.gen(function* storageChecks() {
      const { origin, target } = yield* storagePage;
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
        change?: Effect.Effect<unknown, unknown>
      ) =>
        Effect.gen(function* evaluateCheck() {
          const armed = yield* armBrowserChecks(
            target,
            [{ check, flowSkillName: "storage" }],
            check.id
          );
          armed.start();
          const fiber = yield* Effect.forkChild(
            armed.wait().pipe(Effect.ensuring(Effect.sync(armed.dispose)))
          );
          if (change !== undefined) {
            yield* Effect.sleep(30);
            yield* change;
          }
          const [result] = yield* Fiber.join(fiber);
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
            })
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
            })
          )
        ).toBe("inconclusive");
        yield* write(kind, '{"private-order":');
        expect(yield* evaluate(nested)).toBe("inconclusive");
        expect(
          yield* evaluate(nested, write(kind, order).pipe(Effect.delay(30)))
        ).toBe("passed");
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
            })
          )
        ).toBe("inconclusive");
        yield* write(kind);
        expect(
          yield* evaluate(
            check("absent", {
              format: "json",
              predicates: [{ operator: "exists", path: [] }],
            })
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
        expect(yield* evaluate(changed, write(kind, order))).toBe("failed");
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

it.live("fails a storage check whose last read the deadline cut short", () =>
  Effect.gen(function* deadlineCutRead() {
    const { origin, target } = yield* storagePage;
    // The baseline and the first watched read answer; every read after them
    // stalls the Page past the check's deadline, as a busy CI renderer does.
    yield* Effect.tryPromise(() =>
      target.page.evaluate(() => {
        const read = Storage.prototype.getItem;
        let reads = 0;
        Storage.prototype.getItem = function getItem(name) {
          reads += 1;
          if (reads > 2) {
            const until = performance.now() + 3000;
            while (performance.now() < until) {
              // Hold the renderer the way a starved CI runner does.
            }
          }
          return read.call(this, name);
        };
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
    armed.start();
    const [result] = yield* armed
      .wait()
      .pipe(Effect.ensuring(Effect.sync(armed.dispose)));
    expect(result?.status).toBe("failed");
  }).pipe(
    Effect.scoped,
    Effect.provide(CreateBrowserLive),
    Effect.provide(NodeServices.layer)
  )
);
