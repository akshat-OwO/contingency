import path from "node:path";

import { Effect, FileSystem, Layer } from "effect";
import { McpServer } from "effect/unstable/ai";

/**
 * The authoring skills a learning agent must read before it writes a Flow
 * Skill (ADR 0039).
 *
 * Contingency serves them itself. A user who never installed these skills still
 * gets a Flow Skill written to the same standard, and a user who keeps other
 * skills on disk never has them picked up: nothing here reads `$HOME`, the
 * host IDE, or any directory outside the CLI install. `skill-creator` is not
 * served and is not vendored.
 */

export const AUTHORING_SKILL_URI_PREFIX = "contingency://skill/";

interface AuthoringSkillFile {
  readonly description: string;
  /** Path under the vendored skill directory. */
  readonly file: string;
  readonly skill: string;
}

/**
 * Every vendored file, named explicitly. A directory scan would make the
 * advertised resource list depend on whatever happened to be copied, so the
 * manifest is the contract and a missing file is a refusal, not a silent gap.
 */
export const AUTHORING_SKILL_FILES: readonly AuthoringSkillFile[] = [
  {
    description:
      "How to write a document an agent follows: context pointers, the two loads, and pruning. Read before writing SKILL.md.",
    file: "SKILL.md",
    skill: "writing-for-agents",
  },
  {
    description:
      "The skill-specific branch of writing-for-agents: frontmatter, invocation, and router skills.",
    file: "SKILL-MECHANICS.md",
    skill: "writing-for-agents",
  },
  {
    description:
      "Diátaxis structure, Google developer style, STE instruction rules, and Global English syntax for the Flow Skill's prose.",
    file: "SKILL.md",
    skill: "technical-writing",
  },
  {
    description:
      "Cut AI tells from the written package. Apply last, before agent_flow_skill_save.",
    file: "SKILL.md",
    skill: "unslop",
  },
];

export const authoringSkillUri = ({
  file,
  skill,
}: AuthoringSkillFile): string =>
  file === "SKILL.md"
    ? `${AUTHORING_SKILL_URI_PREFIX}${skill}`
    : `${AUTHORING_SKILL_URI_PREFIX}${skill}/${file}`;

/**
 * Where the vendored skills sit at runtime. Built output keeps them beside the
 * bundle under `dist/skills`, the same shape `resolveWebRoot` uses for the web
 * UI; a source checkout reads the package directory so tests need no build.
 */
export const resolveAuthoringSkillRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "skills")
    : path.resolve(moduleDirectory, "../../skills");

const skillRoot = resolveAuthoringSkillRoot(import.meta.dirname);

export const readAuthoringSkill = (
  entry: AuthoringSkillFile,
  root: string = skillRoot
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* readVendoredSkill() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readFileString(path.join(root, entry.skill, entry.file))
      .pipe(Effect.orDie);
  });

const LEARN_PROMPT_NAME = "learn-flow-skill";

/**
 * The reading order a learning agent follows. It is a prompt rather than a
 * sentence in a tool description because the host must be able to hand the
 * whole procedure to the agent in one call.
 */
const learnFlowSkillPrompt = [
  "Learn one Contingency Teaching Recording and write its Flow Skill.",
  "",
  "1. Read these MCP resources from this server first. Do not use skill-creator, and do not read skills from the host's own directories:",
  ...AUTHORING_SKILL_FILES.map(
    (entry) => `   - ${authoringSkillUri(entry)} (${entry.skill}/${entry.file})`
  ),
  "2. Claim the recording with agent_teaching_recording_claim.",
  "3. Page the semantic timeline with agent_teaching_timeline_get until nextCursor is null. Fetch a keyframe with agent_teaching_keyframe_get only when the timeline is not enough.",
  '4. Write SKILL.md: YAML frontmatter with name equal to the Flow Skill name, a description that states the task and its trigger, and an inputs list naming every value a later run may change. Use {{placeholder}} for each declared input and end every numbered step with a "Done when:" line.',
  '5. Put conditional target detail in references/accessibility.md, as `- role=<role> name="<name>" context="<context>"` entries, plus a "Why these targets are stable" heading. Link every reference file from SKILL.md.',
  "6. Save with agent_flow_skill_save. A refusal returns one diagnostic per broken property; fix those exact paths and save again.",
].join("\n");

const authoringSkillResources = AUTHORING_SKILL_FILES.map((entry) =>
  McpServer.resource({
    audience: ["assistant"],
    content: readAuthoringSkill(entry),
    description: entry.description,
    mimeType: "text/markdown",
    name: `${entry.skill}/${entry.file}`,
    uri: authoringSkillUri(entry),
  })
);

export const McpAuthoringSkillsLayer: Layer.Layer<
  never,
  never,
  FileSystem.FileSystem
> = Layer.mergeAll(
  McpServer.prompt({
    content: () => Effect.succeed(learnFlowSkillPrompt),
    description:
      "The reading order for learning a Contingency Teaching Recording into a Flow Skill, including the authoring skills this server serves.",
    name: LEARN_PROMPT_NAME,
  }),
  ...authoringSkillResources
);
