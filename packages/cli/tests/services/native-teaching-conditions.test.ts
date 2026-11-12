import type {
  PlatformRequirements,
  TeachingEvent,
  TeachingObservation,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { completeNativeTeachingConditions } from "../../src/services/native-teaching-conditions.ts";

const starting = [{ name: "Welcome", role: "heading" }];
const outcomes = [{ name: "Order confirmed", role: "heading" }];
const at = "2026-11-12T00:00:00.000Z";
const observation = (
  platform: "android" | "ios",
  nodes: typeof starting
): TeachingObservation => ({
  [platform]: { nodes, observationId: "observed", screenshotCapturedAt: at },
  nodeCount: nodes.length,
  title: "Shop",
  url: "",
});
const events = (platform: "android" | "ios"): readonly TeachingEvent[] => [
  {
    _tag: "started",
    at,
    emulation: null,
    observation: observation(platform, starting),
    seq: 0,
    url: "",
  },
  {
    _tag: "stopped",
    at,
    detail: null,
    observation: observation(platform, outcomes),
    reason: "user",
    seq: 1,
  },
];
const android: PlatformRequirements = {
  capabilities: [],
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.shop",
    startingState: "Restart",
  },
  outcomes: [],
  platform: "android",
  preparation: {
    activity: "dev.shop/.Main",
    conditions: [],
    kind: "restart-activity",
  },
};
const ios: PlatformRequirements = {
  capabilities: [],
  environment: {
    build: "1",
    bundleId: "dev.shop",
    deviceType: "iPhone",
    runtimeVersion: "26.5",
  },
  outcomes: [],
  platform: "ios",
  preparation: { conditions: [], kind: "restart-app" },
};

for (const runtime of [android, ios]) {
  it.effect(
    `completes ${runtime.platform} conditions only from the two boundary screens`,
    () =>
      Effect.gen(function* boundaryConditions() {
        const completed = yield* completeNativeTeachingConditions(
          runtime,
          { outcomes, starting },
          events(runtime.platform === "android" ? "android" : "ios")
        );
        expect(completed).toMatchObject({
          outcomes,
          preparation: { conditions: starting },
        });
        const invalid = yield* Effect.flip(
          completeNativeTeachingConditions(
            runtime,
            { outcomes: starting, starting: outcomes },
            events(runtime.platform === "android" ? "android" : "ios")
          )
        );
        expect(invalid.message).toContain("observed after launch");
        const absent = yield* Effect.flip(
          completeNativeTeachingConditions(
            runtime,
            undefined,
            events(runtime.platform === "android" ? "android" : "ios")
          )
        );
        expect(absent.message).toContain("nativeConditions");
        const noEvidence = yield* Effect.flip(
          completeNativeTeachingConditions(runtime, { outcomes, starting }, [])
        );
        expect(noEvidence.message).toContain("nativeConditions");
      })
  );
}

it.effect(
  "preserves declared conditions even when the agent proposes other targets",
  () =>
    Effect.gen(function* declaredConditions() {
      const declared: PlatformRequirements = {
        ...android,
        outcomes,
        preparation: {
          activity: "dev.shop/.Main",
          conditions: starting,
          kind: "restart-activity",
        },
      };
      expect(
        yield* completeNativeTeachingConditions(
          declared,
          { outcomes: starting, starting: outcomes },
          []
        )
      ).toEqual(declared);
    })
);

it.effect(
  "derives an omitted outcome while preserving the declared starting condition",
  () =>
    Effect.gen(function* partialConditions() {
      const declared: PlatformRequirements = {
        ...ios,
        preparation: { conditions: starting, kind: "restart-app" },
      };
      expect(
        yield* completeNativeTeachingConditions(
          declared,
          { outcomes, starting: outcomes },
          events("ios")
        )
      ).toMatchObject({ outcomes, preparation: { conditions: starting } });
    })
);
