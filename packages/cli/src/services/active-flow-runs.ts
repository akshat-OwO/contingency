import { Effect, Option } from "effect";

import { AgentSession } from "./agent-session.ts";
import { AndroidWorkspace } from "./android-workspace.ts";
import { IosWorkspace } from "./ios-workspace.ts";

/** Query live registries, excluding Teaching and finished Runs. */
export const isFlowInActiveRun = (flowName: string) =>
  Effect.gen(function* queryActiveRuns() {
    const sessions = yield* AgentSession;
    const android = yield* Effect.serviceOption(AndroidWorkspace);
    const ios = yield* Effect.serviceOption(IosWorkspace);
    const active = yield* sessions.list();
    const androidFlows = yield* Option.match(android, {
      onNone: () => Effect.succeed<readonly string[]>([]),
      onSome: (workspace) => workspace.activeRunFlowNames(),
    });
    const iosFlows = yield* Option.match(ios, {
      onNone: () => Effect.succeed<readonly string[]>([]),
      onSome: (workspace) => workspace.activeRunFlowNames(),
    });
    return (
      androidFlows.includes(flowName) ||
      iosFlows.includes(flowName) ||
      active.some((session) => {
        if (session.activity !== "run") {
          return false;
        }
        const { run } = session;
        return (
          session.flowName === flowName ||
          session.dryRun?.flowName === flowName ||
          (run !== null &&
            ("referencedFlows" in run
              ? run.referencedFlows.some((flow) => flow.flowName === flowName)
              : run.flowName === flowName))
        );
      })
    );
  });
