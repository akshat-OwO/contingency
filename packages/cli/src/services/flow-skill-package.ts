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

interface Frontmatter {
  /** Everything after the closing delimiter, where the procedure lives. */
  readonly body: string;
  readonly description: string | undefined;
  readonly inputs: readonly string[];
  readonly name: string | undefined;
}

const FRONTMATTER = /^---\r?\n(?<block>[\s\S]*?)\r?\n---\r?\n?/u;

/**
 * Reads the small YAML subset a Flow Skill is allowed to use: `name`,
 * `description`, and an `inputs` sequence. A full YAML parser would accept
 * shapes the rest of the product cannot read back, so the grammar stays the one
 * the authoring skills teach.
 */
const readFrontmatter = (content: string): Frontmatter | undefined => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return undefined;
  }
  const [matched] = match;
  const block = match.groups?.block ?? "";
  const inputs: string[] = [];
  let description: string | undefined;
  let name: string | undefined;
  let inInputs = false;
  for (const raw of block.split(/\r?\n/u)) {
    const item = /^\s*-\s+(?<item>\S.*?)\s*$/u.exec(raw);
    if (inInputs && item !== null) {
      inputs.push((item.groups?.item ?? "").replaceAll(/^["']|["']$/gu, ""));
      continue;
    }
    const field = /^(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$/u.exec(raw);
    if (field === null) {
      continue;
    }
    const key = field.groups?.key ?? "";
    const value = (field.groups?.value ?? "")
      .trim()
      .replaceAll(/^["']|["']$/gu, "");
    inInputs = key === "inputs";
    if (key === "name") {
      name = value;
    }
    if (key === "description") {
      description = value;
    }
    if (inInputs && value.length > 0) {
      inputs.push(value);
    }
  }
  return { body: content.slice(matched.length), description, inputs, name };
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
interface Step {
  readonly block: string;
  readonly label: string;
}

const readSteps = (body: string): readonly Step[] => {
  const lines = body.split(/\r?\n/u);
  const steps: { block: string[]; label: string }[] = [];
  for (const line of lines) {
    const start = /^\s{0,3}(?<label>\d+)[.)]\s+\S/u.exec(line);
    if (start === null) {
      const current = steps.at(-1);
      if (current !== undefined) {
        current.block.push(line);
      }
      continue;
    }
    steps.push({ block: [line], label: start.groups?.label ?? "" });
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
  frontmatter: Frontmatter,
  report: (entry: FlowSkillDiagnostic) => void
): void => {
  const declared = new Set(frontmatter.inputs);
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
  const frontmatter = readFrontmatter(skill.content);
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
    checkDeclaredInputs(files, frontmatter, report);
    const steps = readSteps(frontmatter.body);
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
