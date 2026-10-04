import path from "node:path";

import { Effect, FileSystem, Layer } from "effect";
import { McpServer } from "effect/ai";

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
 * The same procedure as a resource. Some clients never surface MCP prompts to
 * the model, and a user should not have to invoke one by hand, so both access
 * methods serve this one text.
 */
export const LEARN_FLOW_SKILL_URI = "contingency://prompt/learn-flow-skill";

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
  '2. Claim the recording with agent_teaching_recording_claim, action "take".',
  "3. Page the semantic timeline with agent_teaching_timeline_get until nextCursor is null. Fetch a keyframe with agent_teaching_keyframe_get only when the timeline is not enough.",
  "Navigation observations and keyframes marked capture:transitional do not prove that the destination rendered. Each keyframe URL describes its own capture instant. Missing capture metadata is not proof of readiness. Use later evidence to establish destination content, and give the Flow Skill an observable completion condition beyond the URL.",
  '4. Write SKILL.md: YAML frontmatter with name equal to the Flow Skill name, a description that states the task and its trigger, and an inputs list naming every value a later run may change. Declare each input either as a bare name (`- sku`) or as a mapping that opens with `- name: sku` and carries an indented `description:` line saying what the value is. Use {{placeholder}} for each declared input and end every numbered step with a "Done when:" line.',
  '5. Put conditional target detail in references/accessibility.md, as `- role=<role> name="<name>" context="<context>"` entries, plus a "Why these targets are stable" heading. Link every reference file from SKILL.md.',
  'When instructions carry scan settings, preserve each start ID and mode in references/scans.json: {"schemaVersion":1,"requirements":[{"id":"<taught-id>","mode":"accessibility|reload|navigation|timespan","when":"<observable journey condition>","endWhen":"<timespan stop condition>","expectedUrl":"<navigation destination>"}]}. Only timespans have endWhen; navigation requires expectedUrl. Infer conditions from ordered comments, targets, and recording evidence, and ask for clarification if ambiguous. Link the file and IDs at the relevant procedure points. An unmatched timespan may remain a draft without endWhen, but must be repaired before a Dry Run. During Runs use agent_run_scan start/stop for these required scans, and inspect scan coverage before completion.',
  "6. Save with agent_flow_skill_save. A refusal returns one diagnostic per broken property; fix those exact paths and save again.",
  "7. Ask for ordinary inputs again and change at least one demonstrated input when the task permits it. Start a fresh-context Dry Run with agent_flow_skill_dry_run_start. For a secret input pass its name with secret:true and no value; ask the user to supply it in the returned Workspace, then use its uppercase Variable name with agent_variable_enter. Follow the saved skill outcome under its Teaching hosts and Emulation; you may explore, recover, or choose another route.",
  "If setup requires user-requested verified Flow Skills, pass their names in prerequisites and all their ordinary inputs in prerequisiteInputs, scoped by flowSkillName and name. This set is fixed at startup; changes require a fresh Dry Run. The start result includes their procedures. Request prerequisite private inputs on demand with agent_variable_request, have the user supply or refuse them in Workspace, and enter them with agent_variable_enter using their declaring flowSkillName. Set replace:true to request a fresh private value for a retry. Prerequisites share the tested skill's fresh context, Teaching hosts, and Emulation; they do not replace its complete outcome or widen Domain Scope.",
  "8. Report your model judgment of the complete skill outcome with agent_run_assess: outcome, explanation, evidence as Snapshot or attempt references produced by this Dry Run, and outcomeComplete explicitly true or false. Findings and assessments leave the browser open. A partial attempt or any user Takeover cannot pass. When finished, call agent_run_complete to seal the report, close the browser, and persist the Dry Run result. Completion is required for a passing report too.",
  "9. A failed report keeps the Teaching Recording and this claim. Fix the package and call agent_flow_skill_save with the same claim operation id, then start another Dry Run.",
  "10. After a pass, show the result and link the Workspace. The user may verify or reject there, or tell you. Wait with agent_session_get, afterCursor:eventCursor, waitMs:45000 for the Workspace event. Relay a conversation choice with agent_flow_skill_decide. A pass retains the Teaching Recording until explicit verification.",
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
  McpServer.resource({
    audience: ["assistant"],
    content: Effect.succeed(learnFlowSkillPrompt),
    description:
      "The learn-flow-skill procedure: how to learn a Teaching Recording into a Flow Skill, Dry Run it, and record the user's verification. The same text as the learn-flow-skill prompt.",
    mimeType: "text/markdown",
    name: LEARN_PROMPT_NAME,
    uri: LEARN_FLOW_SKILL_URI,
  }),
  McpServer.prompt({
    content: () => Effect.succeed(learnFlowSkillPrompt),
    description:
      "The reading order for learning a Contingency Teaching Recording into a Flow Skill, including the authoring skills this server serves.",
    name: LEARN_PROMPT_NAME,
  }),
  ...authoringSkillResources
);
