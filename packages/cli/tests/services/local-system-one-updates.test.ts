import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { LOCAL_SYSTEM_ONE_RELEASE } from "../../src/services/local-system-one-release.ts";
import {
  checkLocalSystemOneUpdates,
  localSystemOneUpdateNotice,
} from "../../src/services/local-system-one-updates.ts";
import type { LocalSystemOneState } from "../../src/services/local-system-one.ts";

const state: LocalSystemOneState = {
  current: {
    directory: "install-current",
    kevCommit: LOCAL_SYSTEM_ONE_RELEASE.kevCommit,
    model: "nev",
    modelId: LOCAL_SYSTEM_ONE_RELEASE.models.nev.id,
    nevRevision: LOCAL_SYSTEM_ONE_RELEASE.models.nev.revision,
  },
  previous: null,
  server: null,
  version: 1,
};

describe("upstream version discovery", () => {
  it.effect(
    "separates newer Kev commits from Nev revisions and excludes older ones",
    () =>
      Effect.gen(function* updates() {
        const cache = yield* checkLocalSystemOneUpdates(state, (url) =>
          Effect.succeed(
            url.includes("github.com")
              ? [
                  { sha: "a".repeat(40) },
                  { sha: state.current.kevCommit },
                  { sha: "b".repeat(40) },
                ]
              : [
                  { id: "c".repeat(40) },
                  { id: state.current.nevRevision },
                  { id: "d".repeat(40) },
                ]
          )
        );
        expect(cache.kev).toEqual(["a".repeat(40)]);
        expect(cache.nev).toEqual(["c".repeat(40)]);
        expect(localSystemOneUpdateNotice(cache)?.split("\n")).toHaveLength(1);
      })
  );
  it.effect("reports no newer upstream versions without a notice", () =>
    Effect.gen(function* currentVersion() {
      const cache = yield* checkLocalSystemOneUpdates(state, (url) =>
        Effect.succeed(
          url.includes("github.com")
            ? [{ sha: state.current.kevCommit }]
            : [{ id: state.current.nevRevision }]
        )
      );
      expect(cache.kev).toEqual([]);
      expect(cache.nev).toEqual([]);
      expect(localSystemOneUpdateNotice(cache)).toBeUndefined();
    })
  );
  it.effect(
    "validates revision identities before offering downloaded code",
    () =>
      Effect.gen(function* invalidUpstream() {
        const result = yield* Effect.result(
          checkLocalSystemOneUpdates(state, () =>
            Effect.succeed([{ sha: "../../untrusted" }])
          )
        );
        expect(Result.isFailure(result)).toBe(true);
      })
  );
  it.effect(
    "does not guess what is newer if installed history disappeared",
    () =>
      Effect.gen(function* missingHistory() {
        const result = yield* Effect.result(
          checkLocalSystemOneUpdates(state, () => Effect.succeed([]))
        );
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("not found");
        } else {
          expect.unreachable();
        }
      })
  );
});
