import type { AgentRunTaskInput, FlowName } from "@contingency/protocol";
import { Effect } from "effect";

import { FlowCatalog } from "./flow-catalog.ts";
import type { FlowPackage } from "./flow-catalog.ts";
import { isVerifiedFlow } from "./flow-package.ts";
import {
  browserCapabilities,
  browserRequirements,
  validatePlatformRequirements,
} from "./platform-requirements.ts";

/** Variable references use uppercase names at the entry boundary. */
export const VARIABLE_REFERENCE_NAME = /^[A-Z][A-Z0-9_]*$/u;

const invalid = (message: string) => ({
  code: "flow_invalid" as const,
  message,
});

export { isVerifiedFlow } from "./flow-package.ts";

/** Resolve only explicitly requested, user-verified catalog packages. */
export const readRequestedFlows = (names: readonly FlowName[]) =>
  Effect.gen(function* readFlows() {
    const catalog = yield* FlowCatalog;
    const flows: FlowPackage[] = [];
    for (const name of new Set(names)) {
      const flow = yield* catalog.read(name);
      const runtime = flow.runtime ?? {
        diagnostics: [],
        requirements: browserRequirements,
      };
      yield* validatePlatformRequirements(runtime, "web", browserCapabilities);
      if (!isVerifiedFlow(flow.files, runtime.requirements.platform)) {
        return yield* Effect.fail(
          invalid(`Flow ${name} has not been verified by the user.`)
        );
      }
      flows.push(flow);
    }
    return flows;
  });

export const taskVariables = (flow: FlowPackage) =>
  flow.inputs.map((input) => ({
    flowName: flow.name,
    name: input.name,
    runtime: true,
    supplied: false,
  }));

export const validateTaskInputs = (
  flows: readonly FlowPackage[],
  inputs: readonly AgentRunTaskInput[]
) =>
  Effect.gen(function* validateInputs() {
    const identities = new Set<string>();
    const flowsByName = new Map(flows.map((flow) => [flow.name, flow]));
    for (const input of inputs) {
      const flow = flowsByName.get(input.flowName);
      const identity = JSON.stringify([input.flowName, input.name]);
      if (
        flow === undefined ||
        !flow.inputs.some((declared) => declared.name === input.name) ||
        identities.has(identity)
      ) {
        return yield* Effect.fail(
          invalid(
            `Input ${input.flowName}/${input.name} must be a unique declared input.`
          )
        );
      }
      identities.add(identity);
    }
  });
