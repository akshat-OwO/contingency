import type {
  NativeTeachingConditions,
  PlatformRequirements,
  TeachingEvent,
} from "@contingency/protocol";
import { Effect } from "effect";

import { browserRequirements } from "./platform-requirements.ts";

type Targets = NativeTeachingConditions["starting"];
const matches = (targets: Targets, nodes: Targets) =>
  targets.length > 0 &&
  targets.every(
    (target) =>
      target.role.trim() !== "" &&
      target.name.trim() !== "" &&
      nodes.some(
        (node) => node.role === target.role && node.name === target.name
      )
  );

const boundaryNodes = (
  events: readonly TeachingEvent[],
  tag: "started" | "stopped",
  platform: "android" | "ios"
) => {
  const event = events.findLast((entry) => entry._tag === tag);
  if (event?._tag !== "started" && event?._tag !== "stopped") {
    return [];
  }
  return event.observation?.[platform]?.nodes ?? [];
};

const selectConditions = (
  declared: Targets,
  proposed: Targets,
  observed: Targets
) => {
  if (declared.length > 0) {
    return Effect.succeed(declared);
  }
  return matches(proposed, observed)
    ? Effect.succeed(proposed)
    : Effect.fail({
        message:
          "Supply nativeConditions with starting targets observed after launch and outcomes observed at Stop. Each needs a non-empty role and name.",
      });
};

/** Complete only omitted conditions, using evidence from the two boundary screens. */
export const completeNativeTeachingConditions = (
  runtime: PlatformRequirements | undefined,
  conditions: NativeTeachingConditions | undefined,
  events: readonly TeachingEvent[]
) =>
  Effect.gen(function* completeConditions() {
    if (runtime === undefined || runtime.platform === "web") {
      return runtime ?? browserRequirements;
    }
    const { preparation } = runtime;
    if (preparation === undefined) {
      return yield* Effect.fail({
        message: "Native Teaching requires an app restart recipe.",
      });
    }
    const starting = yield* selectConditions(
      preparation.conditions,
      conditions?.starting ?? [],
      boundaryNodes(events, "started", runtime.platform)
    );
    const outcomes = yield* selectConditions(
      runtime.outcomes ?? [],
      conditions?.outcomes ?? [],
      boundaryNodes(events, "stopped", runtime.platform)
    );
    if (
      runtime.platform === "android" &&
      preparation.kind === "restart-activity"
    ) {
      return {
        ...runtime,
        environment: {
          ...runtime.environment,
          startingState:
            preparation.conditions.length === 0
              ? starting
                  .map((target) => `${target.role} ${target.name} is visible`)
                  .join(" and ")
              : runtime.environment.startingState,
        },
        outcomes,
        preparation: { ...preparation, conditions: starting },
      };
    }
    if (runtime.platform === "ios" && preparation.kind === "restart-app") {
      return {
        ...runtime,
        outcomes,
        preparation: { ...preparation, conditions: starting },
      };
    }
    return yield* Effect.fail({
      message: "The restart recipe does not match the native platform.",
    });
  });
