import { FailureReference as FailureReferenceSchema } from "@contingency/protocol";
import { describe, expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Cause, Effect, Logger, Option, References, Schema } from "effect";

import { androidBackendError } from "../../src/services/android-runtime-backend.ts";
import { toSafeRecord } from "../../src/services/diagnostic-log.ts";
import type { SafeRecord } from "../../src/services/diagnostic-log.ts";
import {
  FailureReferences,
  lookupFailure,
  makeFailureReferenceStore,
  recordFailure,
} from "../../src/services/failure-reference.ts";
import { referenceRuntimeFailure } from "../../src/services/platform-runtime-error.ts";

const SECRET = "hunter2";

/** Runs an effect with its own store, collecting what the Diagnostic Log would keep. */
const observed = <A, E>(effect: Effect.Effect<A, E>) => {
  const records: SafeRecord[] = [];
  const logger = Logger.make((event) => {
    records.push(toSafeRecord(event, ""));
  });
  return effect.pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provideService(FailureReferences, makeFailureReferenceStore()),
    Effect.map((value) => ({ records, value }))
  );
};

describe("a Failure Reference", () => {
  it.effect("is six Crockford base32 characters", () =>
    Effect.gen(function* readable() {
      const { value: references } = yield* observed(
        Effect.forEach(Array.from({ length: 50 }), () =>
          recordFailure(Cause.die("boom"), "internal_failure")
        )
      );
      for (const reference of references) {
        expect(Schema.is(FailureReferenceSchema)(reference)).toBe(true);
      }
    })
  );

  it.effect("keeps the newest causes when the store is full", () =>
    Effect.gen(function* bounded() {
      const [first, second, third] = yield* Effect.forEach(
        ["a", "b", "c"],
        (defect) => recordFailure(Cause.die(defect), "internal_failure")
      );
      expect(Option.isNone(yield* lookupFailure(first ?? ""))).toBe(true);
      expect(yield* lookupFailure(second ?? "")).toEqual(
        Option.some(Cause.die("b"))
      );
      expect(yield* lookupFailure(third ?? "")).toEqual(
        Option.some(Cause.die("c"))
      );
    }).pipe(
      Effect.provideService(FailureReferences, makeFailureReferenceStore(2))
    )
  );
});

describe("an Android capture failure", () => {
  const backendFailure = new AppError(
    "COMMAND_FAILED",
    `adb printed the field value ${SECRET}`
  );

  it.effect(
    "names one Diagnostic Log record by its tag and code chain, never its message",
    () =>
      Effect.gen(function* referenced() {
        const { records, value: error } = yield* observed(
          referenceRuntimeFailure(
            androidBackendError(backendFailure, "runtime_failed", "capture"),
            backendFailure
          )
        );
        expect(error.code).toBe("runtime_failed");
        const reference = error.failureReference;
        expect(reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/u);
        const named = records.filter((record) =>
          record.fields.some(
            ([key, value]) => key === "failureReference" && value === reference
          )
        );
        expect(named).toHaveLength(1);
        expect(named[0]?.level).toBe("Error");
        expect(named[0]?.fields).toContainEqual(["code", "runtime_failed"]);
        expect(named[0]?.fields).toContainEqual(["operation", "capture"]);
        expect(named[0]?.cause[0]).toBe(
          "fail PlatformRuntimeError(runtime_failed)"
        );
        expect(named[0]?.cause).toContainEqual(
          "  caused by Error(COMMAND_FAILED)"
        );
        expect(JSON.stringify(records)).not.toContain(SECRET);
      })
  );

  it.effect("keeps the whole cause in memory under its reference", () =>
    Effect.gen(function* lookup() {
      const error = yield* referenceRuntimeFailure(
        androidBackendError(backendFailure, "runtime_failed", "capture"),
        backendFailure
      );
      const cause = yield* lookupFailure(error.failureReference ?? "");
      expect(
        cause.pipe(Option.map((recorded) => Cause.pretty(recorded)))
      ).toStrictEqual(Option.some(expect.stringContaining(SECRET)));
    }).pipe(
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
  );

  it.effect("gets no reference when the code explains it", () =>
    Effect.gen(function* selfExplaining() {
      const transition = new AppError("COMMAND_FAILED", "mid-transition", {
        androidSnapshotHelperFailureReason: "system-window-only",
      });
      const { records, value: error } = yield* observed(
        referenceRuntimeFailure(
          androidBackendError(transition, "runtime_failed", "capture"),
          transition
        )
      );
      expect(error.code).toBe("capture_incomplete");
      expect(error.failureReference).toBeUndefined();
      expect(records).toEqual([]);
    })
  );
});
