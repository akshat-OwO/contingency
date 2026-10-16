import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import {
  EXECUTION_VALUE_LIMITS,
  ExecutionValues,
  ExecutionValuesLive,
} from "../../src/services/execution-values.ts";

const idOf = (uri: string) => uri.split("/").at(-2) ?? "";

describe("execution values", () => {
  it.effect("reads a kept value until it expires", () =>
    Effect.gen(function* expiry() {
      const values = yield* ExecutionValues;
      const link = yield* values.keep('{"rows":[1,2,3]}');
      expect(link.uri).toMatch(/^contingency:\/\/executions\/exec-.+\/value$/u);
      expect(yield* values.read(idOf(link.uri))).toEqual(
        Option.some('{"rows":[1,2,3]}')
      );
      yield* TestClock.adjust(EXECUTION_VALUE_LIMITS.ttlMs);
      expect(yield* values.read(idOf(link.uri))).toEqual(Option.none());
    }).pipe(Effect.provide(ExecutionValuesLive))
  );

  it.effect("lets the oldest value go when the store is full", () =>
    Effect.gen(function* eviction() {
      const values = yield* ExecutionValues;
      const links = yield* Effect.forEach(
        Array.from({ length: EXECUTION_VALUE_LIMITS.entries + 1 }, (_, index) =>
          String(index)
        ),
        (text) => values.keep(text)
      );
      const [oldest, second] = links;
      expect(yield* values.read(idOf(oldest?.uri ?? ""))).toEqual(
        Option.none()
      );
      expect(yield* values.read(idOf(second?.uri ?? ""))).toEqual(
        Option.some("1")
      );
      expect(yield* values.read(idOf(links.at(-1)?.uri ?? ""))).toEqual(
        Option.some(String(EXECUTION_VALUE_LIMITS.entries))
      );
    }).pipe(Effect.provide(ExecutionValuesLive))
  );
});
