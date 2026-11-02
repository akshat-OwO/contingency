import type { AgentRunTaskInput, FlowSkillName } from "@contingency/protocol";
import { Effect } from "effect";

import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillPackage } from "./flow-skill-catalog.ts";
import { isVerifiedFlowSkill } from "./flow-skill-package.ts";
import {
  browserCapabilities,
  browserRequirements,
  validatePlatformRequirements,
} from "./platform-requirements.ts";

/** Variable references use uppercase names at the entry boundary. */
export const VARIABLE_REFERENCE_NAME = /^[A-Z][A-Z0-9_]*$/u;

const invalid = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});

export { isVerifiedFlowSkill } from "./flow-skill-package.ts";

/** Resolve only explicitly requested, user-verified catalog packages. */
export const readRequestedSkills = (names: readonly FlowSkillName[]) =>
  Effect.gen(function* readSkills() {
    const catalog = yield* FlowSkillCatalog;
    const skills: FlowSkillPackage[] = [];
    for (const name of new Set(names)) {
      const skill = yield* catalog.read(name);
      const runtime = skill.runtime ?? {
        diagnostics: [],
        requirements: browserRequirements,
      };
      yield* validatePlatformRequirements(runtime, "web", browserCapabilities);
      if (!isVerifiedFlowSkill(skill.files, runtime.requirements.platform)) {
        return yield* Effect.fail(
          invalid(`Flow Skill ${name} has not been verified by the user.`)
        );
      }
      skills.push(skill);
    }
    return skills;
  });

export const taskVariables = (skill: FlowSkillPackage) =>
  skill.inputs.map((input) => ({
    flowSkillName: skill.name,
    name: input.name,
    runtime: true,
    supplied: false,
  }));

export const validateTaskInputs = (
  skills: readonly FlowSkillPackage[],
  inputs: readonly AgentRunTaskInput[]
) =>
  Effect.gen(function* validateInputs() {
    const identities = new Set<string>();
    const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
    for (const input of inputs) {
      const skill = skillsByName.get(input.flowSkillName);
      const identity = JSON.stringify([input.flowSkillName, input.name]);
      if (
        skill === undefined ||
        !skill.inputs.some((declared) => declared.name === input.name) ||
        identities.has(identity)
      ) {
        return yield* Effect.fail(
          invalid(
            `Input ${input.flowSkillName}/${input.name} must be a unique declared input.`
          )
        );
      }
      identities.add(identity);
    }
  });
