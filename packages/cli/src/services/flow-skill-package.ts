import type { FlowSkillDiagnostic, FlowSkillFile } from "@contingency/protocol";
import { Result } from "effect";

/**
 * The mechanical contract a proposed Flow Skill package must meet before it
 * replaces the live directory.
 *
 * Contingency owns the package shape (ADR 0039) but does not grade prose. Every
 * check here is boolean and observable from the submitted files alone: a
 * frontmatter field, a declared input, a completion marker, a resolvable link,
 * or a forbidden literal. Nothing reads the recording, the network, or the
 * user's machine, so the same package is accepted or refused everywhere.
 */

export const SKILL_FILE = "SKILL.md";
export const ACCESSIBILITY_FILE = "references/accessibility.md";

/** The marker that ends one procedure step with a checkable outcome. */
export const COMPLETION_MARKER = "Done when:";

/** The heading an accessibility reference uses for its selection rationale. */
export const STABILITY_HEADING = "## Why these targets are stable";

const diagnostic = (
  code: string,
  message: string,
  path: readonly string[]
): FlowSkillDiagnostic => ({ code, message, path: [...path] });

export interface FlowSkillFrontmatter {
  /** Everything after the closing delimiter, where the procedure lives. */
  readonly body: string;
  readonly description: string | undefined;
  /**
   * The Emulation the journey was demonstrated under, as flat scalars. Written
   * by Contingency at save time, not authored by the agent.
   */
  readonly emulation: FlowSkillEmulation | undefined;
  /** The hosts the Teaching Recording actually visited. */
  readonly hosts: readonly string[];
  readonly inputs: readonly FlowSkillInput[];
  /**
   * Every `inputs` entry the grammar could not read as a declaration, verbatim.
   * The validator reports the shape rather than letting the undeclared-input
   * check claim a declared input is missing (#203).
   */
  readonly malformedInputs: readonly string[];
  readonly name: string | undefined;
}

/**
 * One declared `{{placeholder}}` input. A bare-name entry carries no
 * description; the mapping form is where an author documents what the value is,
 * which is the only place a later caller looks before supplying it.
 */
export interface FlowSkillInput {
  readonly description: string | undefined;
  readonly name: string;
}

/**
 * The Emulation subset a Flow Skill carries. `viewport` is one `WxH@scale`
 * scalar so the grammar stays the flat one the authoring skills teach, and a
 * demonstrated phone stays a phone when the Run reproduces it (ADR 0013).
 */
export interface FlowSkillEmulation {
  readonly colorScheme: string | undefined;
  readonly locale: string | undefined;
  readonly timezone: string | undefined;
  readonly userAgentProfile: string | undefined;
  readonly viewport:
    | {
        readonly deviceScaleFactor: number;
        readonly height: number;
        readonly width: number;
      }
    | undefined;
}

const VIEWPORT_SCALAR =
  /^(?<width>\d+)x(?<height>\d+)(?:@(?<scale>\d+(?:\.\d+)?))?$/u;

const readViewportScalar = (
  value: string
): FlowSkillEmulation["viewport"] | undefined => {
  const match = VIEWPORT_SCALAR.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const width = Number(match.groups?.width);
  const height = Number(match.groups?.height);
  const scale = Number(match.groups?.scale ?? "1");
  if (width <= 0 || height <= 0 || !Number.isFinite(scale) || scale <= 0) {
    return undefined;
  }
  return { deviceScaleFactor: scale, height, width };
};

const FRONTMATTER = /^---\r?\n(?<block>[\s\S]*?)\r?\n---\r?\n?/u;

const FRONTMATTER_FIELD =
  /^(?<indent>\s*)(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$/u;
const FRONTMATTER_ITEM = /^\s*-\s+(?<item>\S.*?)\s*$/u;

const unquoted = (value: string): string =>
  value.trim().replaceAll(/^["']|["']$/gu, "");

interface FrontmatterLine {
  readonly indented: boolean;
  readonly item: string | undefined;
  readonly key: string | undefined;
  readonly value: string;
}

const readFrontmatterLine = (raw: string): FrontmatterLine => {
  const item = FRONTMATTER_ITEM.exec(raw);
  if (item !== null) {
    return {
      indented: true,
      item: unquoted(item.groups?.item ?? ""),
      key: undefined,
      value: "",
    };
  }
  const field = FRONTMATTER_FIELD.exec(raw);
  if (field === null) {
    return { indented: false, item: undefined, key: undefined, value: "" };
  }
  return {
    indented: (field.groups?.indent ?? "").length > 0,
    item: undefined,
    key: field.groups?.key ?? "",
    value: unquoted(field.groups?.value ?? ""),
  };
};

const readEmulationBlock = (
  fields: Record<string, string>
): FlowSkillEmulation | undefined =>
  Object.keys(fields).length === 0
    ? undefined
    : {
        colorScheme: fields.colorScheme,
        locale: fields.locale,
        timezone: fields.timezone,
        userAgentProfile: fields.userAgentProfile,
        viewport:
          fields.viewport === undefined
            ? undefined
            : readViewportScalar(fields.viewport),
      };

/** A declared input while the parser is still filling it in. */
interface MutableFlowSkillInput {
  description: string | undefined;
  name: string;
}

/** A declared input name, and the mapping keys an entry may carry. */
const INPUT_NAME = /^[A-Za-z][\w-]*$/u;
const INPUT_MAPPING = /^(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$/u;

const sequenceFor = (key: string): "hosts" | "inputs" | undefined => {
  if (key === "hosts") {
    return "hosts";
  }
  return key === "inputs" ? "inputs" : undefined;
};

/**
 * Reads one `inputs` entry. A bare name declares an input with no description;
 * a `name: <input>` mapping declares one that an indented `description` may
 * document. Anything else is reported as a shape problem rather than dropped,
 * so the author is told what the parser accepts.
 */
const readInputItem = (
  item: string,
  inputs: MutableFlowSkillInput[],
  malformed: string[]
): MutableFlowSkillInput | undefined => {
  if (INPUT_NAME.test(item)) {
    inputs.push({ description: undefined, name: item });
    return undefined;
  }
  const mapping = INPUT_MAPPING.exec(item);
  const key = mapping?.groups?.key;
  const value = unquoted(mapping?.groups?.value ?? "");
  if (key !== "name" || !INPUT_NAME.test(value)) {
    malformed.push(item);
    return undefined;
  }
  const entry: MutableFlowSkillInput = { description: undefined, name: value };
  inputs.push(entry);
  return entry;
};

/**
 * Reads the small YAML subset a Flow Skill is allowed to use: the `name` and
 * `description` scalars, the `hosts` sequence, the `inputs` sequence in either
 * its bare-name or its `name`/`description` mapping form, and one flat
 * `emulation` block. A full YAML parser would accept shapes the rest of the
 * product cannot read back, so the grammar stays the one the authoring skills
 * teach.
 */
export const readFlowSkillFrontmatter = (
  content: string
): FlowSkillFrontmatter | undefined => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return undefined;
  }
  const [matched] = match;
  const hosts: string[] = [];
  const inputs: MutableFlowSkillInput[] = [];
  const malformedInputs: string[] = [];
  const scalars: Record<string, string> = {};
  const emulation: Record<string, string> = {};
  let sequence: "hosts" | "inputs" | undefined;
  let inEmulation = false;
  /** The mapping-form input an indented key still belongs to, when any. */
  let openInput: MutableFlowSkillInput | undefined;
  for (const raw of (match.groups?.block ?? "").split(/\r?\n/u)) {
    const line = readFrontmatterLine(raw);
    if (line.item !== undefined) {
      openInput = undefined;
      if (sequence === "hosts") {
        hosts.push(line.item);
        continue;
      }
      if (sequence === "inputs") {
        openInput = readInputItem(line.item, inputs, malformedInputs);
      }
      continue;
    }
    if (line.key === undefined) {
      continue;
    }
    if (line.indented) {
      // An indented key belongs to whatever block opened it. It is never a
      // top-level scalar: reading `description` under an input as the skill's
      // own description is how a declared input went missing (#203).
      if (inEmulation) {
        emulation[line.key] = line.value;
      } else if (openInput !== undefined && line.key === "description") {
        openInput.description = line.value.length > 0 ? line.value : undefined;
      }
      continue;
    }
    openInput = undefined;
    inEmulation = line.key === "emulation";
    sequence = sequenceFor(line.key);
    if (sequence !== undefined) {
      if (line.value.length > 0) {
        if (sequence === "hosts") {
          hosts.push(line.value);
        } else {
          readInputItem(line.value, inputs, malformedInputs);
        }
      }
      continue;
    }
    scalars[line.key] = line.value;
  }
  return {
    body: content.slice(matched.length),
    description: scalars.description,
    emulation: readEmulationBlock(emulation),
    hosts,
    inputs,
    malformedInputs,
    name: scalars.name,
  };
};

/**
 * Replace the `hosts` and `emulation` keys of a SKILL.md's frontmatter with
 * what the Teaching Recording actually observed.
 *
 * Contingency stamps these rather than trusting the agent to author them: a
 * Run's host ceiling and device must be demonstrated rather than asserted
 * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)),
 * and the recording is deleted once the user verifies, so the package is the
 * only place left to keep them.
 */
const STAMPED_KEYS = new Set(["emulation", "hosts"]);

/** The frontmatter lines that are not part of a key Contingency owns. */
const withoutStampedKeys = (block: string): string[] => {
  const kept: string[] = [];
  let dropping = false;
  for (const raw of block.split(/\r?\n/u)) {
    const line = readFrontmatterLine(raw);
    if (dropping && (line.item !== undefined || line.indented)) {
      continue;
    }
    if (line.key !== undefined && !line.indented) {
      dropping = STAMPED_KEYS.has(line.key);
      if (dropping) {
        continue;
      }
    }
    kept.push(raw);
  }
  while (kept.at(-1)?.trim() === "") {
    kept.pop();
  }
  return kept;
};

const emulationLines = (emulation: FlowSkillEmulation): string[] => {
  const lines: string[] = [];
  if (emulation.userAgentProfile !== undefined) {
    lines.push(`  userAgentProfile: ${emulation.userAgentProfile}`);
  }
  if (emulation.viewport !== undefined) {
    const { deviceScaleFactor, height, width } = emulation.viewport;
    lines.push(`  viewport: ${width}x${height}@${deviceScaleFactor}`);
  }
  if (emulation.locale !== undefined) {
    lines.push(`  locale: ${emulation.locale}`);
  }
  if (emulation.timezone !== undefined) {
    lines.push(`  timezone: ${emulation.timezone}`);
  }
  if (emulation.colorScheme !== undefined) {
    lines.push(`  colorScheme: ${emulation.colorScheme}`);
  }
  return lines;
};

export const stampFlowSkillProvenance = (
  content: string,
  provenance: {
    readonly emulation: FlowSkillEmulation;
    readonly hosts: readonly string[];
  }
): string => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return content;
  }
  const [matched] = match;
  const stamped = [
    ...withoutStampedKeys(match.groups?.block ?? ""),
    "hosts:",
    ...provenance.hosts.map((host) => `  - ${host}`),
    "emulation:",
    ...emulationLines(provenance.emulation),
  ].join("\n");
  return `---\n${stamped}\n---\n${content.slice(matched.length)}`;
};

const PLACEHOLDER = /\{\{\s*(?<input>[A-Za-z][\w-]*)\s*\}\}/gu;
const ELEMENT_REF = /(?<![\w-])e\d+(?![\w-])/u;
const CSS_ID_SELECTOR = /(?<![\w#(])#[A-Za-z][\w-]*\b/u;
const MARKDOWN_LINK = /\]\((?<target>[^)\s]+)\)/gu;
const EMBEDDED_IMAGE = /!\[[^\]]*\]\(/u;
const PRIVATE_REASONING =
  /\b(?:I think|I believe|I'm not sure|I am not sure|let me|I'll|I will now|as an AI|chain of thought)\b/iu;
const SECRET_LITERAL =
  /\b(?:password|passphrase|secret|token|api[\s_-]?key)\b\s*[:=]\s*(?<value>\S+)/giu;
const RESIDUE = [
  "trace.zip",
  "recording.webm",
  "events.jsonl",
  ".recordings/",
] as const;
const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webm", ".webp"] as const;

/** One numbered step and the text that belongs to it, for completion checks. */
export interface FlowSkillStep {
  readonly block: string;
  readonly label: string;
}

/** A Markdown heading in the left margin, which ends the procedure above it. */
const SECTION_HEADING = /^#{1,6}\s+\S/u;

/** A fence line, so a `#` comment inside a code block never reads as a heading. */
const CODE_FENCE = /^\s*(?:`{3,}|~{3,})/u;

export const readFlowSkillSteps = (body: string): readonly FlowSkillStep[] => {
  const lines = body.split(/\r?\n/u);
  const steps: { block: string[]; label: string }[] = [];
  let open = false;
  let fenced = false;
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      fenced = !fenced;
    }
    const start = fenced ? null : /^\s{0,3}(?<label>\d+)[.)]\s+\S/u.exec(line);
    if (start === null) {
      if (!fenced && SECTION_HEADING.test(line)) {
        open = false;
        continue;
      }
      const current = steps.at(-1);
      if (open && current !== undefined) {
        current.block.push(line);
      }
      continue;
    }
    steps.push({ block: [line], label: start.groups?.label ?? "" });
    open = true;
  }
  return steps.map((step) => ({
    block: step.block.join("\n"),
    label: step.label,
  }));
};

const checkResidue = (
  file: FlowSkillFile,
  report: (entry: FlowSkillDiagnostic) => void
): void => {
  for (const marker of RESIDUE) {
    if (file.content.includes(marker)) {
      report(
        diagnostic(
          "flow_skill_recording_residue",
          `${file.path} names the recording artifact ${marker}. A Flow Skill must be followable after the recording is deleted.`,
          [file.path]
        )
      );
    }
  }
  if (EMBEDDED_IMAGE.test(file.content)) {
    report(
      diagnostic(
        "flow_skill_embedded_image",
        `${file.path} embeds an image. A Flow Skill describes targets in words so it survives a re-render.`,
        [file.path]
      )
    );
  }
  const elementRef = ELEMENT_REF.exec(file.content);
  if (elementRef !== null) {
    report(
      diagnostic(
        "flow_skill_element_ref",
        `${file.path} names the short-lived element reference ${elementRef[0]}. Use the role, the accessible name, and the nearby context instead.`,
        [file.path]
      )
    );
  }
  const cssId = CSS_ID_SELECTOR.exec(file.content);
  if (cssId !== null) {
    report(
      diagnostic(
        "flow_skill_generated_selector",
        `${file.path} names the selector ${cssId[0]}. A generated or positional selector does not outlive the page.`,
        [file.path]
      )
    );
  }
  if (PRIVATE_REASONING.test(file.content)) {
    report(
      diagnostic(
        "flow_skill_private_reasoning",
        `${file.path} records private model reasoning. Keep the package to what a later reader must do.`,
        [file.path]
      )
    );
  }
  SECRET_LITERAL.lastIndex = 0;
  for (
    let secret = SECRET_LITERAL.exec(file.content);
    secret !== null;
    secret = SECRET_LITERAL.exec(file.content)
  ) {
    const value = secret.groups?.value ?? "";
    if (PLACEHOLDER.test(value)) {
      PLACEHOLDER.lastIndex = 0;
      continue;
    }
    PLACEHOLDER.lastIndex = 0;
    report(
      diagnostic(
        "flow_skill_secret_literal",
        `${file.path} stores a captured credential literal. Declare it as an input and reference it as a placeholder.`,
        [file.path]
      )
    );
  }
};

const checkLinks = (
  file: FlowSkillFile,
  known: ReadonlySet<string>,
  report: (entry: FlowSkillDiagnostic) => void
): void => {
  MARKDOWN_LINK.lastIndex = 0;
  for (
    let link = MARKDOWN_LINK.exec(file.content);
    link !== null;
    link = MARKDOWN_LINK.exec(file.content)
  ) {
    const target = link.groups?.target ?? "";
    if (target.includes("://") || target.startsWith("#")) {
      continue;
    }
    if (
      IMAGE_SUFFIXES.some((suffix) => target.toLowerCase().endsWith(suffix))
    ) {
      report(
        diagnostic(
          "flow_skill_embedded_image",
          `${file.path} points at the captured media ${target}. A Flow Skill carries no recording media.`,
          [file.path]
        )
      );
      continue;
    }
    if (!target.endsWith(".md")) {
      continue;
    }
    const resolved = target.startsWith("references/")
      ? target
      : `references/${target.replace(/^\.\//u, "")}`;
    if (!(known.has(target) || known.has(resolved))) {
      report(
        diagnostic(
          "flow_skill_missing_reference",
          `${file.path} points at ${target}, which the package does not contain.`,
          [file.path, target]
        )
      );
    }
  }
};

/**
 * Every submitted file is scanned, not only the procedure. A reference that
 * introduces `{{city}}` on its own would leave a Dry Run with nothing to
 * re-prompt for, which is the whole reason inputs are declared.
 */
const checkDeclaredInputs = (
  files: readonly FlowSkillFile[],
  frontmatter: FlowSkillFrontmatter,
  report: (entry: FlowSkillDiagnostic) => void
): void => {
  const declared = new Set(frontmatter.inputs.map((input) => input.name));
  for (const file of files) {
    const scanned =
      file.path === SKILL_FILE
        ? `${frontmatter.description ?? ""}\n${frontmatter.body}`
        : file.content;
    const used = new Set<string>();
    PLACEHOLDER.lastIndex = 0;
    for (
      let placeholder = PLACEHOLDER.exec(scanned);
      placeholder !== null;
      placeholder = PLACEHOLDER.exec(scanned)
    ) {
      used.add(placeholder.groups?.input ?? "");
    }
    for (const input of used) {
      if (declared.has(input)) {
        continue;
      }
      report(
        diagnostic(
          "flow_skill_undeclared_input",
          `${file.path} uses {{${input}}} but SKILL.md does not declare ${input} under inputs.`,
          file.path === SKILL_FILE
            ? [SKILL_FILE, "frontmatter", "inputs", input]
            : [file.path, "inputs", input]
        )
      );
    }
  }
};

const TARGET_ENTRY = /^\s*-\s+role=/u;

const checkAccessibility = (
  file: FlowSkillFile,
  report: (entry: FlowSkillDiagnostic) => void
): void => {
  if (!file.content.includes(STABILITY_HEADING)) {
    report(
      diagnostic(
        "flow_skill_missing_stability_rationale",
        `${ACCESSIBILITY_FILE} must carry the heading "${STABILITY_HEADING}" and say why each target outlives the page.`,
        [file.path, STABILITY_HEADING]
      )
    );
  }
  const entries = file.content
    .split(/\r?\n/u)
    .filter((line) => TARGET_ENTRY.test(line));
  if (entries.length === 0) {
    report(
      diagnostic(
        "flow_skill_missing_target",
        `${ACCESSIBILITY_FILE} must list every target as \`- role=<role> name="<name>" context="<context>"\`.`,
        [file.path]
      )
    );
    return;
  }
  for (const entry of entries) {
    if (!(entry.includes("name=") && entry.includes("context="))) {
      report(
        diagnostic(
          "flow_skill_incomplete_target",
          `${ACCESSIBILITY_FILE} target \`${entry.trim()}\` needs a role, an accessible name, and the nearby context that disambiguates it.`,
          [file.path, entry.trim()]
        )
      );
    }
  }
};

/**
 * Validates one proposed Flow Skill package against the observable contract.
 * Returns the files unchanged on success so the caller can keep writing the
 * exact bytes the agent submitted.
 */
export const validateFlowSkillPackage = (
  flowSkillName: string,
  files: readonly FlowSkillFile[]
): Result.Result<readonly FlowSkillFile[], readonly FlowSkillDiagnostic[]> => {
  const diagnostics: FlowSkillDiagnostic[] = [];
  const report = (entry: FlowSkillDiagnostic) => {
    diagnostics.push(entry);
  };
  const known = new Set(files.map((file) => file.path));
  const skill = files.find((file) => file.path === SKILL_FILE);
  if (skill === undefined) {
    return Result.fail([
      diagnostic(
        "flow_skill_missing_skill_file",
        "A Flow Skill package must contain SKILL.md.",
        [SKILL_FILE]
      ),
    ]);
  }
  const frontmatter = readFlowSkillFrontmatter(skill.content);
  if (frontmatter === undefined) {
    report(
      diagnostic(
        "flow_skill_missing_frontmatter",
        "SKILL.md must open with a YAML frontmatter block carrying name, description, and inputs.",
        [SKILL_FILE, "frontmatter"]
      )
    );
  } else {
    if (frontmatter.name !== flowSkillName) {
      report(
        diagnostic(
          "flow_skill_name_mismatch",
          `SKILL.md declares name "${frontmatter.name ?? ""}" but the package is saved as "${flowSkillName}".`,
          [SKILL_FILE, "frontmatter", "name"]
        )
      );
    }
    if ((frontmatter.description ?? "").trim().length === 0) {
      report(
        diagnostic(
          "flow_skill_missing_description",
          "SKILL.md must declare a description that states the task and when to run it.",
          [SKILL_FILE, "frontmatter", "description"]
        )
      );
    }
    for (const entry of frontmatter.malformedInputs) {
      report(
        diagnostic(
          "flow_skill_invalid_input",
          `SKILL.md declares the input entry \`- ${entry}\` in a shape Contingency cannot read. Each entry under inputs is either a bare name (\`- sku\`) or a mapping opening with \`- name: sku\` and an optional indented \`description:\` line.`,
          [SKILL_FILE, "frontmatter", "inputs", entry]
        )
      );
    }
    checkDeclaredInputs(files, frontmatter, report);
    const steps = readFlowSkillSteps(frontmatter.body);
    if (steps.length === 0) {
      report(
        diagnostic(
          "flow_skill_missing_steps",
          "SKILL.md must carry a numbered procedure. A how-to without ordered work cannot be followed.",
          [SKILL_FILE, "steps"]
        )
      );
    }
    for (const step of steps) {
      if (!step.block.includes(COMPLETION_MARKER)) {
        report(
          diagnostic(
            "flow_skill_missing_completion_condition",
            `Step ${step.label} of SKILL.md must carry a "${COMPLETION_MARKER} <observable outcome>" line so a later run can tell it finished.`,
            [SKILL_FILE, "steps", step.label]
          )
        );
      }
    }
  }
  for (const file of files) {
    checkResidue(file, report);
    checkLinks(file, known, report);
  }
  const accessibility = files.find((file) => file.path === ACCESSIBILITY_FILE);
  if (accessibility !== undefined) {
    checkAccessibility(accessibility, report);
  }
  return diagnostics.length === 0
    ? Result.succeed(files)
    : Result.fail(diagnostics);
};

/** One ordered step of a saved Flow Skill, as a Run executes it. */
export interface FlowSkillProcedureStep {
  /** The step's whole text, placeholders included. */
  readonly description: string;
  /** The observable outcome that ends the step. */
  readonly doneWhen: string;
  readonly index: number;
  /** The step's first line, for a compact label. */
  readonly name: string;
}

const STEP_NUMBER = /^\s{0,3}\d+[.)]\s+/u;
const NAME_LIMIT = 80;

const firstLine = (block: string): string => {
  const [line] = block.split(/\r?\n/u);
  const text = (line ?? "").replace(STEP_NUMBER, "").trim();
  return text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT - 1)}…` : text;
};

const completionOf = (block: string): string => {
  const marker = block.indexOf(COMPLETION_MARKER);
  return marker === -1
    ? ""
    : (block
        .slice(marker + COMPLETION_MARKER.length)
        .split(/\r?\n\s*\r?\n/u)[0]
        ?.trim() ?? "");
};

/**
 * The ordered steps a Run follows, read from the saved `SKILL.md`. The Flow
 * Skill is the single reusable format (ADR 0039), so a Run derives its Agent
 * Steps from the same numbered procedure a person reads. Validation already
 * refused a package whose steps lack a completion condition, so a saved
 * package always yields a `doneWhen` for every step.
 */
export const flowSkillProcedureSteps = (
  skillContent: string
): readonly FlowSkillProcedureStep[] => {
  const frontmatter = readFlowSkillFrontmatter(skillContent);
  if (frontmatter === undefined) {
    return [];
  }
  return readFlowSkillSteps(frontmatter.body).map((step, index) => ({
    description: step.block.trim(),
    doneWhen: completionOf(step.block),
    index,
    name: firstLine(step.block),
  }));
};
