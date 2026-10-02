import type { AgentRunTaskInput, FlowSkillName } from "@contingency/protocol";
import { Effect } from "effect";

import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillPackage } from "./flow-skill-catalog.ts";

/** Uppercase declarations use private on-demand Variables instead of ordinary inputs. */
export const PRIVATE_INPUT_NAME = /^[A-Z][A-Z0-9_]*$/u;

const invalid = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});

/** Resolve only explicitly requested, user-verified catalog packages. */
export const readRequestedSkills = (names: readonly FlowSkillName[]) =>
  Effect.gen(function* readSkills() {
    const catalog = yield* FlowSkillCatalog;
    const skills: FlowSkillPackage[] = [];
    for (const name of new Set(names)) {
      const skill = yield* catalog.read(name);
      if (
        !skill.files.some(
          (file) =>
            file.path === "references/verification.md" &&
            /^- Verified: .+$/mu.test(file.content)
        )
      ) {
        return yield* Effect.fail(
          invalid(`Flow Skill ${name} has not been verified by the user.`)
        );
      }
      skills.push(skill);
    }
    return skills;
  });

export const taskVariables = (skill: FlowSkillPackage) =>
  skill.inputs.flatMap((input) =>
    PRIVATE_INPUT_NAME.test(input.name)
      ? [
          {
            flowSkillName: skill.name,
            name: input.name,
            runtime: true,
            secret: true,
            supplied: false,
          },
        ]
      : []
  );

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
        PRIVATE_INPUT_NAME.test(input.name) ||
        identities.has(identity)
      ) {
        return yield* Effect.fail(
          invalid(
            `Input ${input.flowSkillName}/${input.name} must be a unique declared ordinary input. Private values use on-demand Variable decisions.`
          )
        );
      }
      identities.add(identity);
    }
  });
