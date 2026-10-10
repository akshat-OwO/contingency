import {
  matchesBrowserExpectation,
  matchesBrowserRequest,
} from "@contingency/protocol";
import type {
  BrowserCheck,
  BrowserCheckReference,
  BrowserCheckResult,
} from "@contingency/protocol";
import { Cause, Clock, Deferred, Effect, Result, Schema } from "effect";
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

type StorageCheck = Exclude<BrowserCheck, { kind: "response" }>;
const STORAGE_JSON_LIMIT = 65_536;
const decodeStorageJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Json)
);
/** Raw values are compared for change; only an explicit JSON format decodes them for the expectation. */
const storageObservation = (
  check: StorageCheck,
  raw: string | undefined
): Result.Result<Schema.Json | undefined, unknown> => {
  if (raw === undefined || check.kind === "cookie" || check.format !== "json") {
    return Result.succeed(raw);
  }
  if (Buffer.byteLength(raw, "utf-8") > STORAGE_JSON_LIMIT) {
    return Result.fail("Storage JSON exceeds the observation limit");
  }
  return decodeStorageJson(raw);
};
const storageChangeMatches = (
  check: StorageCheck,
  before: string | undefined,
  current: string | undefined
) =>
  check.change === "current" ||
  (check.change === "created"
    ? before === undefined && current !== undefined
    : current !== before);
type StoragePoll =
  | "cut-short"
  | "passed"
  | "undecodable"
  | "unmatched"
  | "unreadable";
/**
 * Storage is evidence only once a read lands and decodes: a Page that never
 * answered within the deadline is unreadable, not a failed expectation.
 */
const storageInconclusive = (
  check: BrowserCheck,
  polls: ReadonlySet<StoragePoll>
) =>
  check.kind !== "response" &&
  (polls.has("unreadable") ||
    polls.has("undecodable") ||
    !polls.has("unmatched"));
/**
 * One storage read against the check's deadline. A read the deadline cut
 * short says nothing about the storage, unlike a read that failed before it.
 */
const pollStorage = (
  target: BrowserTarget,
  check: StorageCheck,
  before: string | undefined,
  deadline: number
): Effect.Effect<StoragePoll> =>
  Effect.gen(function* readStorage() {
    const now = yield* Clock.currentTimeMillis;
    return yield* storageValue(target, check).pipe(
      Effect.timeout(Math.max(1, Math.min(1000, deadline - now))),
      Effect.matchEffect({
        onFailure: (cause) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((at): StoragePoll =>
              Cause.isTimeoutError(cause) && at >= deadline
                ? "cut-short"
                : "unreadable"
            )
          ),
        onSuccess: (current) => {
          if (!storageChangeMatches(check, before, current)) {
            return Effect.succeed<StoragePoll>("unmatched");
          }
          const observed = storageObservation(check, current);
          if (Result.isFailure(observed)) {
            return Effect.succeed<StoragePoll>("undecodable");
          }
          return Effect.succeed<StoragePoll>(
            matchesBrowserExpectation(observed.success, check.expectation)
              ? "passed"
              : "unmatched"
          );
        },
      })
    );
  });

/** The listeners belong to one dispatch. Request identity excludes already-in-flight evidence. */
export const armBrowserChecks = (
  target: BrowserTarget,
  references: readonly BrowserCheckReference[],
  operationId: string
) =>
  Effect.gen(function* armChecks() {
    const polling = yield* Deferred.make<true>();
    const registry = AtomRegistry.make();
    const requests = new Set<Request>();
    const responses = Atom.make<readonly Response[]>([]).pipe(Atom.keepAlive);
    let overflow = false;
    let dispatchedAt: number | undefined;
    const start = () =>
      Effect.gen(function* startChecks() {
        dispatchedAt ??= yield* Clock.currentTimeMillis;
      });
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
            const deadline =
              (dispatchedAt ?? (yield* Clock.currentTimeMillis)) +
              check.timeoutMs;
            let cursor = 0;
            let unreadable = false;
            const polls = new Set<StoragePoll>();
            while ((yield* Clock.currentTimeMillis) < deadline) {
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
                        Math.max(
                          1,
                          Math.min(
                            1000,
                            deadline - (yield* Clock.currentTimeMillis)
                          )
                        )
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
                const poll = yield* pollStorage(
                  target,
                  check,
                  before.success,
                  deadline
                );
                if (poll === "passed") {
                  return result(reference, "passed");
                }
                polls.add(poll);
              }
              yield* Deferred.succeed(polling, true);
              const remaining = deadline - (yield* Clock.currentTimeMillis);
              if (remaining > 0) {
                yield* Effect.sleep(Math.min(50, remaining));
              }
            }
            return result(
              reference,
              unreadable || storageInconclusive(check, polls)
                ? "inconclusive"
                : "failed"
            );
          }),
        { concurrency: "unbounded" }
      );
    return {
      dispose,
      interrupted: () =>
        references.map((reference) => result(reference, "interrupted")),
      /** Completes after the first observation that needs another poll. */
      polling,
      start,
      wait,
    };
  });
