import {
  matchesBrowserExpectation,
  matchesBrowserRequest,
} from "@contingency/protocol";
import type {
  BrowserCheck,
  BrowserCheckReference,
  BrowserCheckResult,
} from "@contingency/protocol";
import { Effect, Result, Schema } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { Request, Response } from "playwright-core";

import type { BrowserTarget } from "./create-browser-contract.ts";

const BODY_LIMIT = 65_536;
const checkSummaries: Record<BrowserCheckResult["status"], string> = {
  failed: "The expectation was not fulfilled before its deadline.",
  inconclusive:
    "Browser evidence could not be read within the observation limits.",
  interrupted:
    "The action or watch was interrupted; its effect may already have happened.",
  passed: "The reviewed Browser Check passed with fresh evidence.",
};
const storageValue = (target: BrowserTarget, check: BrowserCheck) =>
  Effect.tryPromise(async () => {
    if (check.kind === "response") {
      return;
    }
    if (check.kind === "cookie") {
      const cookies = await target.context.cookies(check.origin);
      const cookie = cookies.find(
        (candidate) =>
          candidate.name === check.name &&
          (check.cookiePath === undefined ||
            candidate.path === check.cookiePath)
      );
      return cookie?.value;
    }
    if (new URL(target.page.url()).origin !== check.origin) {
      throw new Error("Storage origin is unavailable");
    }
    return await target.page.evaluate(
      ({ kind, name }) => {
        const store = kind === "local" ? localStorage : sessionStorage;
        return store.getItem(name) ?? undefined;
      },
      { kind: check.kind, name: check.name }
    );
  });

const storageChangeMatches = (
  check: Exclude<BrowserCheck, { kind: "response" }>,
  before: string | undefined,
  current: string | undefined
) =>
  check.change === "current" ||
  (check.change === "created"
    ? before === undefined && current !== undefined
    : current !== before);

/** The listeners belong to one dispatch. Request identity excludes already-in-flight evidence. */
export const armBrowserChecks = (
  target: BrowserTarget,
  references: readonly BrowserCheckReference[],
  operationId: string
) =>
  Effect.gen(function* armChecks() {
    const registry = AtomRegistry.make();
    const requests = new Set<Request>();
    const responses = Atom.make<readonly Response[]>([]).pipe(Atom.keepAlive);
    let overflow = false;
    let dispatchedAt: number | undefined;
    const start = () => {
      dispatchedAt ??= Date.now();
    };
    const onRequest = (request: Request) => {
      if (dispatchedAt === undefined) {
        return;
      }
      if (
        !references.some(
          ({ check }) =>
            check.kind === "response" &&
            matchesBrowserRequest(
              request.method(),
              request.url(),
              check.request
            )
        )
      ) {
        return;
      }
      if (requests.size >= 100) {
        overflow = true;
        return;
      }
      requests.add(request);
    };
    const onResponse = (response: Response) => {
      if (!requests.has(response.request())) {
        return;
      }
      const retained = registry.get(responses);
      if (retained.length >= 100) {
        overflow = true;
        return;
      }
      registry.set(responses, [...retained, response]);
    };
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach runs effects; its second argument is not an array thisArg.
    const baseline = yield* Effect.forEach(references, ({ check }) =>
      Effect.result(storageValue(target, check))
    );
    target.context.on("request", onRequest);
    target.context.on("response", onResponse);
    const dispose = () => {
      target.context.off("request", onRequest);
      target.context.off("response", onResponse);
      requests.clear();
      registry.dispose();
    };
    const result = (
      reference: BrowserCheckReference,
      status: BrowserCheckResult["status"]
    ): BrowserCheckResult => ({
      at: new Date().toISOString(),
      flowSkillName: reference.flowSkillName,
      id: reference.check.id,
      operationId,
      status,
      summary: checkSummaries[status],
    });
    const wait = () =>
      Effect.forEach(
        references,
        (reference, index) =>
          Effect.gen(function* evaluateCheck() {
            const { check } = reference;
            const before = baseline[index];
            if (before === undefined || Result.isFailure(before)) {
              return result(reference, "inconclusive");
            }
            const deadline = (dispatchedAt ?? Date.now()) + check.timeoutMs;
            let cursor = 0;
            let unreadable = false;
            while (Date.now() < deadline) {
              if (overflow) {
                return result(reference, "inconclusive");
              }
              if (check.kind === "response") {
                const pending = registry.get(responses);
                while (cursor < pending.length) {
                  const response = pending[cursor];
                  cursor += 1;
                  if (
                    response === undefined ||
                    !matchesBrowserRequest(
                      response.request().method(),
                      response.url(),
                      check.request
                    )
                  ) {
                    continue;
                  }
                  const body = yield* Effect.result(
                    Effect.tryPromise(async () => {
                      const size = Number(
                        response.headers()["content-length"] ?? 0
                      );
                      if (size > BODY_LIMIT) {
                        throw new Error("Response exceeds observation limit");
                      }
                      const bytes = await response.body();
                      if (bytes.byteLength > BODY_LIMIT) {
                        throw new Error("Response exceeds observation limit");
                      }
                      return Schema.decodeUnknownSync(Schema.Json)(
                        JSON.parse(bytes.toString())
                      );
                    }).pipe(
                      Effect.timeout(
                        Math.max(1, Math.min(1000, deadline - Date.now()))
                      )
                    )
                  );
                  if (Result.isFailure(body)) {
                    unreadable = true;
                    if (check.response === "first") {
                      return result(reference, "inconclusive");
                    }
                  } else if (
                    matchesBrowserExpectation(body.success, check.expectation)
                  ) {
                    return result(reference, "passed");
                  } else if (check.response === "first") {
                    return result(reference, "failed");
                  }
                }
              } else {
                const current = yield* Effect.result(
                  storageValue(target, check).pipe(
                    Effect.timeout(
                      Math.max(1, Math.min(1000, deadline - Date.now()))
                    )
                  )
                );
                if (Result.isFailure(current)) {
                  unreadable = true;
                } else if (
                  storageChangeMatches(
                    check,
                    before.success,
                    current.success
                  ) &&
                  matchesBrowserExpectation(current.success, check.expectation)
                ) {
                  return result(reference, "passed");
                }
              }
              yield* Effect.sleep(
                Math.max(1, Math.min(50, deadline - Date.now()))
              );
            }
            return result(reference, unreadable ? "inconclusive" : "failed");
          }),
        { concurrency: "unbounded" }
      );
    return {
      dispose,
      interrupted: () =>
        references.map((reference) => result(reference, "interrupted")),
      start,
      wait,
    };
  });
