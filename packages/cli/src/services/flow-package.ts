import { createHash } from "node:crypto";
import nodePath from "node:path";

import type {
  FlowDiagnostic,
  FlowFile,
  PlatformRequirements,
  PlatformIdentity,
} from "@contingency/protocol";
import { Option, Result, Schema } from "effect";

import {
  parseBrowserChecks,
  BROWSER_CHECKS_FILE,
} from "./browser-check-requirements.ts";
import {
  browserRequirements,
  readPlatformRequirements,
} from "./platform-requirements.ts";
import type { SavedPlatformRequirements } from "./platform-requirements.ts";
import { parseScanRequirements, SCANS_FILE } from "./scan-requirements.ts";

/**
 * The mechanical contract a proposed Flow package must meet before it
 * replaces the live directory.
 *
 * Contingency owns the package shape (ADR 0039) but does not grade prose. Every
 * check here is boolean and observable from the submitted files alone: a
 * frontmatter field, a declared input, a completion marker, a resolvable link,
 * or a forbidden literal. Nothing reads the recording, the network, or the
 * user's machine, so the same package is accepted or refused everywhere.
 */

export const FLOW_FILE = "flow.md";
export const TARGETS_FILE = "targets.md";

/** The marker that ends one procedure step with a checkable outcome. */
export const COMPLETION_MARKER = "Done when:";

/** The heading an accessibility reference uses for its selection rationale. */
export const STABILITY_HEADING = "## Why these targets are stable";

const diagnostic = (
  code: string,
  message: string,
  path: readonly string[]
): FlowDiagnostic => ({ code, message, path: [...path] });

/** Durable Dry Run evidence contains input names, never their values. */
const verificationSchema = Schema.Struct({
  completedAt: Schema.String,
  digests: Schema.optional(
    Schema.Struct({
      contracts: Schema.Struct({
        "browser-state.json": Schema.NullOr(Schema.String),
        "checks.json": Schema.NullOr(Schema.String),
        "scans.json": Schema.NullOr(Schema.String),
      }),
      procedure: Schema.String,
      version: Schema.Literal(1),
    })
  ),
  inputs: Schema.Array(
    Schema.Struct({ changed: Schema.Boolean, name: Schema.String })
  ),
  observableOutcome: Schema.String,
  origin: Schema.optional(Schema.Literals(["agent", "workspace"])),
  outcome: Schema.Literals(["passed", "failed"]),
  platform: Schema.optional(Schema.Literals(["web", "android", "ios"])),
  verifiedAt: Schema.optional(Schema.String),
});
export type FlowVerification = typeof verificationSchema.Type;
const readVerification = (
  value: string | undefined
): FlowVerification | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(verificationSchema))(value)
  );
};

export interface FlowFrontmatter {
  readonly verification: FlowVerification | undefined;
  readonly runtime: SavedPlatformRequirements;
  /** Everything after the closing delimiter, where the procedure lives. */
  readonly body: string;
  readonly description: string | undefined;
  /**
   * The Emulation the journey was demonstrated under, as flat scalars. Written
   * by Contingency at save time, not authored by the agent.
   */
  readonly emulation: FlowEmulation | undefined;
  /** Hosts visited during Teaching or approved during a Guided Run. */
  readonly hosts: readonly string[];
  readonly inputs: readonly FlowInput[];
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
export interface FlowInput {
  readonly description: string | undefined;
  readonly name: string;
}

/**
 * The Emulation subset a Flow carries. `viewport` is one `WxH@scale`
 * scalar so the grammar stays the flat one the authoring flows teach, and a
 * demonstrated phone stays a phone when the Run reproduces it (ADR 0013).
 */
export interface FlowEmulation {
  readonly pageZoom?: number | undefined;
  readonly textScale?: number | undefined;
  readonly diagnostics?: readonly string[];
  readonly colorScheme: string | undefined;
  /**
   * The fixed position the demonstration answered location requests with, as
   * one `lat,lon[@accuracy]` scalar. A flow that only works from one place says
   * so here rather than reading as portable (#241).
   */
  readonly geolocation: FlowGeolocation | undefined;
  readonly locale: string | undefined;
  /** The website permission decisions the demonstration was granted or denied. */
  readonly permissions: readonly FlowPermission[];
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

export interface FlowGeolocation {
  readonly accuracy: number | undefined;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * One permission decision as the frontmatter carries it:
 * `<permission> <state>` for a context-wide decision, with the origin appended
 * when the decision is narrowed to one site.
 */
export interface FlowPermission {
  readonly origin: string | undefined;
  readonly permission: string;
  readonly state: "denied" | "granted";
}

const VIEWPORT_SCALAR =
  /^(?<width>\d+)x(?<height>\d+)(?:@(?<scale>\d+(?:\.\d+)?))?$/u;

const GEOLOCATION_SCALAR =
  /^(?<latitude>-?\d+(?:\.\d+)?)\s*,\s*(?<longitude>-?\d+(?:\.\d+)?)(?:\s*@\s*(?<accuracy>\d+(?:\.\d+)?))?$/u;

/**
 * Reads the fixed position scalar. Invalid coordinates return undefined so
 * the emulation parser can retain a diagnostic and refuse the saved requirement.
 */
const readGeolocationScalar = (value: string): FlowGeolocation | undefined => {
  const match = GEOLOCATION_SCALAR.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const latitude = Number(match.groups?.latitude);
  const longitude = Number(match.groups?.longitude);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined;
  }
  const raw = match.groups?.accuracy;
  return {
    accuracy: raw === undefined ? undefined : Number(raw),
    latitude,
    longitude,
  };
};

const PERMISSION_ITEM =
  /^(?<permission>[A-Za-z][\w-]*)(?:\s+(?<state>granted|denied))?(?:\s+(?<origin>\S+))?$/u;

/**
 * Reads one `permissions` entry. A decision written without a state reads as
 * `granted`, matching how flows written before decisions were explicit decode
 * in the protocol.
 */
const readPermissionItem = (item: string): FlowPermission | undefined => {
  const match = PERMISSION_ITEM.exec(item.trim());
  if (match === null) {
    return undefined;
  }
  return {
    origin: match.groups?.origin,
    permission: match.groups?.permission ?? "",
    state: match.groups?.state === "denied" ? "denied" : "granted",
  };
};

const readViewportScalar = (
  value: string
): FlowEmulation["viewport"] | undefined => {
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
  fields: Record<string, string>,
  permissions: readonly FlowPermission[],
  diagnostics: string[],
  declared: boolean
): FlowEmulation | undefined =>
  declared
    ? {
        colorScheme: fields.colorScheme,
        diagnostics,
        geolocation:
          fields.geolocation === undefined
            ? undefined
            : readGeolocationScalar(fields.geolocation),
        locale: fields.locale,
        pageZoom:
          fields.pageZoom === undefined ? undefined : Number(fields.pageZoom),
        permissions,
        textScale:
          fields.textScale === undefined ? undefined : Number(fields.textScale),
        timezone: fields.timezone,
        userAgentProfile: fields.userAgentProfile,
        viewport:
          fields.viewport === undefined
            ? undefined
            : readViewportScalar(fields.viewport),
      }
    : undefined;

/** A declared input while the parser is still filling it in. */
interface MutableFlowInput {
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
  inputs: MutableFlowInput[],
  malformed: string[]
): MutableFlowInput | undefined => {
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
  const entry: MutableFlowInput = { description: undefined, name: value };
  inputs.push(entry);
  return entry;
};

/** Records one permission entry or a diagnostic for an unreadable shape. */
const pushPermission = (
  value: string,
  permissions: FlowPermission[],
  diagnostics: string[]
): void => {
  const decision = value.length > 0 ? readPermissionItem(value) : undefined;
  if (decision !== undefined) {
    permissions.push(decision);
  } else if (value.length > 0) {
    diagnostics.push(`Invalid permission decision: ${value}`);
  }
};

/**
 * Records one indented key of the `emulation` block. Returns whether the key
 * opened the `permissions` sequence, so later items land in it.
 */
const readEmulationKey = (
  key: string,
  value: string,
  emulation: Record<string, string>,
  permissions: FlowPermission[],
  diagnostics: string[]
): boolean => {
  if (
    ![
      "viewport",
      "userAgentProfile",
      "pageZoom",
      "textScale",
      "colorScheme",
      "locale",
      "timezone",
      "geolocation",
      "permissions",
    ].includes(key)
  ) {
    diagnostics.push(`Unknown emulation field: ${key}`);
  }
  if (key !== "permissions") {
    if (Object.hasOwn(emulation, key)) {
      diagnostics.push(`Duplicate emulation field: ${key}`);
    }
    if (key === "viewport" && readViewportScalar(value) === undefined) {
      diagnostics.push("Invalid viewport scalar.");
    }
    if (key === "geolocation" && readGeolocationScalar(value) === undefined) {
      diagnostics.push("Invalid geolocation scalar.");
    }
    if (
      (key === "pageZoom" &&
        (!Number.isFinite(Number(value)) ||
          Number(value) < 25 ||
          Number(value) > 500)) ||
      (key === "textScale" &&
        (!Number.isFinite(Number(value)) ||
          Number(value) < 50 ||
          Number(value) > 300))
    ) {
      diagnostics.push(`Invalid ${key} percentage.`);
    }
    emulation[key] = value;
    return false;
  }
  pushPermission(value, permissions, diagnostics);
  return true;
};

const invalidEmulationHeader = (
  line: FrontmatterLine,
  scalars: Record<string, string>
) => Object.hasOwn(scalars, "emulation") || line.value.length > 0;

/**
 * Reads the small YAML subset a Flow is allowed to use: the `name` and
 * `description` scalars, the `hosts` sequence, the `inputs` sequence in either
 * its bare-name or its `name`/`description` mapping form, and the
 * `emulation` block of flat scalars with its one `permissions` sequence. A full YAML parser would accept shapes the rest of the
 * product cannot read back, so the grammar stays the one the authoring flows
 * teach.
 */
export const readFlowFrontmatter = (
  content: string
): FlowFrontmatter | undefined => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return undefined;
  }
  const [matched] = match;
  const lines = (match.groups?.block ?? "").split(/\r?\n/u);
  const runtimeValues = lines.flatMap((raw) => {
    const line = readFrontmatterLine(raw);
    return !line.indented && line.key === "runtime" ? [line.value] : [];
  });
  const hosts: string[] = [];
  const inputs: MutableFlowInput[] = [];
  const malformedInputs: string[] = [];
  const scalars: Record<string, string> = {};
  const emulation: Record<string, string> = {};
  const permissions: FlowPermission[] = [];
  const emulationDiagnostics: string[] = [];
  let sequence: "hosts" | "inputs" | undefined;
  let inEmulation = false;
  /** Whether an indented item belongs to `emulation.permissions`. */
  let inPermissions = false;
  /** The mapping-form input an indented key still belongs to, when any. */
  let openInput: MutableFlowInput | undefined;
  for (const raw of lines) {
    const line = readFrontmatterLine(raw);
    if (line.item !== undefined) {
      openInput = undefined;
      if (inPermissions) {
        pushPermission(line.item, permissions, emulationDiagnostics);
        continue;
      }
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
      // top-level scalar: reading `description` under an input as the flow's
      // own description is how a declared input went missing (#203).
      if (inEmulation) {
        inPermissions = readEmulationKey(
          line.key,
          line.value,
          emulation,
          permissions,
          emulationDiagnostics
        );
      } else if (openInput !== undefined && line.key === "description") {
        openInput.description = line.value.length > 0 ? line.value : undefined;
      }
      continue;
    }
    openInput = undefined;
    inPermissions = false;
    inEmulation = line.key === "emulation";
    if (inEmulation && invalidEmulationHeader(line, scalars)) {
      emulationDiagnostics.push("Emulation must be one flat mapping block.");
    }
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
    emulation: readEmulationBlock(
      emulation,
      permissions,
      emulationDiagnostics,
      Object.hasOwn(scalars, "emulation")
    ),
    hosts,
    inputs,
    malformedInputs,
    name: scalars.name,
    runtime: readPlatformRequirements(runtimeValues),
    verification: readVerification(scalars.verification),
  };
};

/**
 * Replace the `hosts`, `emulation`, and `runtime` keys of a flow.md's frontmatter with
 * what the Teaching Recording actually observed.
 *
 * Contingency stamps these rather than trusting the agent to author them: a
 * Run's host ceiling and device must be demonstrated rather than asserted
 * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)),
 * and the recording is deleted once the user verifies, so the package is the
 * only place left to keep them.
 */
const STAMPED_KEYS = new Set(["emulation", "hosts", "runtime", "verification"]);

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

/** Reserved contracts whose presence and content belong to verification. */
export const FLOW_CONTRACT_FILES = [
  "checks.json",
  "scans.json",
  "browser-state.json",
] as const;

const normalizedText = (content: string): string =>
  content.replaceAll("\r\n", "\n");
const sha256 = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf-8").digest("hex")}`;

/** Version 1 hashes LF-normalized authored frontmatter and the unchanged body. */
export const flowVerificationDigests = (
  content: string,
  files: readonly FlowFile[] = []
): NonNullable<FlowVerification["digests"]> => {
  const normalized = normalizedText(content);
  const match = FRONTMATTER.exec(normalized);
  const authored =
    match === null
      ? normalized
      : `---\n${withoutStampedKeys(match.groups?.block ?? "").join("\n")}\n---\n${normalized.slice(match[0].length)}`;
  const contractDigest = (name: string) => {
    const file = files.find((entry) => entry.path === name);
    return file === undefined ? null : sha256(normalizedText(file.content));
  };
  return {
    contracts: {
      "browser-state.json": contractDigest("browser-state.json"),
      "checks.json": contractDigest("checks.json"),
      "scans.json": contractDigest("scans.json"),
    },
    procedure: sha256(authored),
    version: 1,
  };
};

export const matchesFlowVerificationDigests = (
  content: string,
  files: readonly FlowFile[],
  recorded: FlowVerification["digests"]
): boolean => {
  if (recorded === undefined) {
    return false;
  }
  const current = flowVerificationDigests(content, files);
  return (
    recorded.procedure === current.procedure &&
    FLOW_CONTRACT_FILES.every(
      (name) => recorded.contracts[name] === current.contracts[name]
    )
  );
};

const emulationLines = (emulation: FlowEmulation): string[] => {
  const lines: string[] = [];
  // 100% is the browser default; omit it so older Flows round-trip.
  if (emulation.pageZoom !== undefined && emulation.pageZoom !== 100) {
    lines.push(`  pageZoom: ${emulation.pageZoom}`);
  }
  if (emulation.textScale !== undefined && emulation.textScale !== 100) {
    lines.push(`  textScale: ${emulation.textScale}`);
  }
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
  if (emulation.geolocation !== undefined) {
    const { accuracy, latitude, longitude } = emulation.geolocation;
    const position = `${latitude},${longitude}`;
    lines.push(
      `  geolocation: ${accuracy === undefined ? position : `${position}@${accuracy}`}`
    );
  }
  if (emulation.permissions.length > 0) {
    lines.push("  permissions:");
    for (const decision of emulation.permissions) {
      const scope = decision.origin === undefined ? "" : ` ${decision.origin}`;
      lines.push(`    - ${decision.permission} ${decision.state}${scope}`);
    }
  }
  return lines;
};

const legacySecretDeclaration = /^\s+secret:\s*(?:true|false)\s*(?:#.*)?$/u;

const withoutLegacySecretDeclarations = (content: string): string => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return content;
  }
  const block = (match.groups?.block ?? "")
    .split("\n")
    .filter((line) => !legacySecretDeclaration.test(line))
    .join("\n");
  return `---\n${block}\n---${content.slice(match[0].length)}`;
};

export const stampFlowProvenance = (
  content: string,
  provenance: {
    readonly emulation: FlowEmulation | null;
    readonly hosts: readonly string[];
    readonly runtime?: PlatformRequirements | undefined;
  }
): string => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return content;
  }
  const [matched] = match;
  const stamped = [
    ...withoutStampedKeys(match.groups?.block ?? "").filter(
      (line) => !legacySecretDeclaration.test(line)
    ),
    `runtime: ${JSON.stringify(provenance.runtime ?? browserRequirements)}`,
    ...(provenance.runtime !== undefined &&
    provenance.runtime.platform !== "web"
      ? []
      : [
          "hosts:",
          ...provenance.hosts.map((host) => `  - ${host}`),
          "emulation:",
          ...(provenance.emulation === null
            ? []
            : emulationLines(provenance.emulation)),
        ]),
  ].join("\n");
  return `---\n${stamped}\n---\n${content.slice(matched.length)}`;
};

export const stampFlowVerification = (
  content: string,
  verification: FlowVerification,
  files: readonly FlowFile[] = []
): string => {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return content;
  }
  const lines = (match.groups?.block ?? "").split(/\r?\n/u);
  const kept: string[] = [];
  let dropping = false;
  for (const raw of lines) {
    const line = readFrontmatterLine(raw);
    if (line.key !== undefined && !line.indented) {
      dropping = line.key === "verification";
    }
    if (!dropping) {
      kept.push(raw);
    }
  }
  return `---\n${kept.join("\n")}\nverification: ${JSON.stringify({ ...verification, digests: flowVerificationDigests(content, files) })}\n---\n${content.slice(match[0].length)}`;
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
  "recordings/",
] as const;
const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webm", ".webp"] as const;

/** One numbered step and the text that belongs to it, for completion checks. */
export interface FlowStep {
  readonly block: string;
  readonly label: string;
}

/** A Markdown heading in the left margin, which ends the procedure above it. */
const SECTION_HEADING = /^#{1,6}\s+\S/u;

/** A fence line, so a `#` comment inside a code block never reads as a heading. */
const CODE_FENCE = /^\s*(?:`{3,}|~{3,})/u;

export const readFlowSteps = (body: string): readonly FlowStep[] => {
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
  file: FlowFile,
  report: (entry: FlowDiagnostic) => void
): void => {
  for (const marker of RESIDUE) {
    if (file.content.includes(marker)) {
      report(
        diagnostic(
          "flow_recording_residue",
          `${file.path} names the recording artifact ${marker}. A Flow must be followable after the recording is deleted.`,
          [file.path]
        )
      );
    }
  }
  if (EMBEDDED_IMAGE.test(file.content)) {
    report(
      diagnostic(
        "flow_embedded_image",
        `${file.path} embeds an image. A Flow describes targets in words so it survives a re-render.`,
        [file.path]
      )
    );
  }
  const elementRef = ELEMENT_REF.exec(file.content);
  if (elementRef !== null) {
    report(
      diagnostic(
        "flow_element_ref",
        `${file.path} names the short-lived element reference ${elementRef[0]}. Use the role, the accessible name, and the nearby context instead.`,
        [file.path]
      )
    );
  }
  const cssId = CSS_ID_SELECTOR.exec(file.content);
  if (cssId !== null) {
    report(
      diagnostic(
        "flow_generated_selector",
        `${file.path} names the selector ${cssId[0]}. A generated or positional selector does not outlive the page.`,
        [file.path]
      )
    );
  }
  if (PRIVATE_REASONING.test(file.content)) {
    report(
      diagnostic(
        "flow_private_reasoning",
        `${file.path} records private model reasoning. Keep the package to what a later reader must do.`,
        [file.path]
      )
    );
  }
  const literalContent =
    file.path === "flow.md"
      ? withoutLegacySecretDeclarations(file.content)
      : file.content;
  SECRET_LITERAL.lastIndex = 0;
  for (
    let secret = SECRET_LITERAL.exec(literalContent);
    secret !== null;
    secret = SECRET_LITERAL.exec(literalContent)
  ) {
    const value = secret.groups?.value ?? "";
    if (PLACEHOLDER.test(value)) {
      PLACEHOLDER.lastIndex = 0;
      continue;
    }
    PLACEHOLDER.lastIndex = 0;
    report(
      diagnostic(
        "flow_secret_literal",
        `${file.path} stores a captured credential literal. Declare it as an input and reference it as a placeholder.`,
        [file.path]
      )
    );
  }
};

const checkLinks = (
  file: FlowFile,
  known: ReadonlySet<string>,
  report: (entry: FlowDiagnostic) => void
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
          "flow_embedded_image",
          `${file.path} points at the captured media ${target}. A Flow carries no recording media.`,
          [file.path]
        )
      );
      continue;
    }
    if (!target.endsWith(".md")) {
      continue;
    }
    if (
      !known.has(
        nodePath.posix.normalize(
          nodePath.posix.join(nodePath.posix.dirname(file.path), target)
        )
      )
    ) {
      report(
        diagnostic(
          "flow_missing_reference",
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
  files: readonly FlowFile[],
  frontmatter: FlowFrontmatter,
  report: (entry: FlowDiagnostic) => void
): void => {
  const declared = new Set(frontmatter.inputs.map((input) => input.name));
  for (const file of files) {
    const scanned =
      file.path === FLOW_FILE
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
          "flow_undeclared_input",
          `${file.path} uses {{${input}}} but flow.md does not declare ${input} under inputs.`,
          file.path === FLOW_FILE
            ? [FLOW_FILE, "frontmatter", "inputs", input]
            : [file.path, "inputs", input]
        )
      );
    }
  }
};

const TARGET_ENTRY = /^\s*-\s+role=/u;

const checkAccessibility = (
  file: FlowFile,
  report: (entry: FlowDiagnostic) => void
): void => {
  if (!file.content.includes(STABILITY_HEADING)) {
    report(
      diagnostic(
        "flow_missing_stability_rationale",
        `${TARGETS_FILE} must carry the heading "${STABILITY_HEADING}" and say why each target outlives the page.`,
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
        "flow_missing_target",
        `${TARGETS_FILE} must list every target as \`- role=<role> name="<name>" context="<context>"\`.`,
        [file.path]
      )
    );
    return;
  }
  for (const entry of entries) {
    if (!(entry.includes("name=") && entry.includes("context="))) {
      report(
        diagnostic(
          "flow_incomplete_target",
          `${TARGETS_FILE} target \`${entry.trim()}\` needs a role, an accessible name, and the nearby context that disambiguates it.`,
          [file.path, entry.trim()]
        )
      );
    }
  }
};

const sourceDocumentDiagnostics = (
  content: string
): readonly FlowDiagnostic[] => {
  const source = (FRONTMATTER.exec(content)?.groups?.block ?? "")
    .split(/\r?\n/u)
    .some((raw) => {
      const line = readFrontmatterLine(raw);
      return !line.indented && line.key === "source";
    });
  if (source) {
    return [
      diagnostic(
        "flow_source_forbidden",
        "A Flow must not link or store its Source Document. Remove source frontmatter.",
        [FLOW_FILE, "frontmatter", "source"]
      ),
    ];
  }
  return [];
};

/**
 * Validates one proposed Flow package against the observable contract.
 * Returns the files unchanged on success so the caller can keep writing the
 * exact bytes the agent submitted.
 */
export const validateFlowPackage = (
  flowName: string,
  files: readonly FlowFile[]
): Result.Result<readonly FlowFile[], readonly FlowDiagnostic[]> => {
  const diagnostics: FlowDiagnostic[] = [];
  const report = (entry: FlowDiagnostic) => {
    diagnostics.push(entry);
  };
  const browserChecks = parseBrowserChecks(files);
  if (Result.isFailure(browserChecks)) {
    report(
      diagnostic("flow_invalid_browser_checks", browserChecks.failure.message, [
        BROWSER_CHECKS_FILE,
      ])
    );
  }
  const scans = parseScanRequirements(files);
  if (Result.isFailure(scans)) {
    report(
      diagnostic("flow_invalid_scans", scans.failure.message, [SCANS_FILE])
    );
  }
  const known = new Set(files.map((file) => file.path));
  const flow = files.find((file) => file.path === FLOW_FILE);
  if (flow === undefined) {
    return Result.fail([
      diagnostic(
        "flow_missing_flow_file",
        "A Flow package must contain flow.md.",
        [FLOW_FILE]
      ),
    ]);
  }
  for (const entry of sourceDocumentDiagnostics(flow.content)) {
    report(entry);
  }
  const frontmatter = readFlowFrontmatter(flow.content);
  if (frontmatter === undefined) {
    report(
      diagnostic(
        "flow_missing_frontmatter",
        "flow.md must open with a YAML frontmatter block carrying name, description, and inputs.",
        [FLOW_FILE, "frontmatter"]
      )
    );
  } else {
    for (const message of frontmatter.runtime.diagnostics) {
      report(
        diagnostic("flow_invalid_runtime", message, [
          FLOW_FILE,
          "frontmatter",
          "runtime",
        ])
      );
    }
    if (frontmatter.name !== flowName) {
      report(
        diagnostic(
          "flow_name_mismatch",
          `flow.md declares name "${frontmatter.name ?? ""}" but the package is saved as "${flowName}".`,
          [FLOW_FILE, "frontmatter", "name"]
        )
      );
    }
    if ((frontmatter.description ?? "").trim().length === 0) {
      report(
        diagnostic(
          "flow_missing_description",
          "flow.md must declare a description that states the task and when to run it.",
          [FLOW_FILE, "frontmatter", "description"]
        )
      );
    }
    for (const entry of frontmatter.malformedInputs) {
      report(
        diagnostic(
          "flow_invalid_input",
          `flow.md declares the input entry \`- ${entry}\` in a shape Contingency cannot read. Each entry under inputs is either a bare name (\`- sku\`) or a mapping opening with \`- name: sku\` and an optional indented \`description:\` line.`,
          [FLOW_FILE, "frontmatter", "inputs", entry]
        )
      );
    }
    checkDeclaredInputs(files, frontmatter, report);
    const steps = readFlowSteps(frontmatter.body);
    if (steps.length === 0) {
      report(
        diagnostic(
          "flow_missing_steps",
          "flow.md must carry a numbered procedure. A how-to without ordered work cannot be followed.",
          [FLOW_FILE, "steps"]
        )
      );
    }
    for (const step of steps) {
      if (!step.block.includes(COMPLETION_MARKER)) {
        report(
          diagnostic(
            "flow_missing_completion_condition",
            `Step ${step.label} of flow.md must carry a "${COMPLETION_MARKER} <observable outcome>" line so a later run can tell it finished.`,
            [FLOW_FILE, "steps", step.label]
          )
        );
      }
    }
  }
  for (const file of files) {
    checkResidue(file, report);
    checkLinks(file, known, report);
  }
  const accessibility = files.find((file) => file.path === TARGETS_FILE);
  if (accessibility !== undefined) {
    checkAccessibility(accessibility, report);
  }
  return diagnostics.length === 0
    ? Result.succeed(files)
    : Result.fail(diagnostics);
};

/** One ordered step of a saved Flow, as a Run executes it. */
export interface FlowProcedureStep {
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
 * The ordered steps a Run follows, read from the saved `flow.md`. The Flow
 * Flow is the single reusable format (ADR 0039), so a Run derives its Agent
 * Steps from the same numbered procedure a person reads. Validation already
 * refused a package whose steps lack a completion condition, so a saved
 * package always yields a `doneWhen` for every step.
 */
export const flowProcedureSteps = (
  flowContent: string
): readonly FlowProcedureStep[] => {
  const frontmatter = readFlowFrontmatter(flowContent);
  if (frontmatter === undefined) {
    return [];
  }
  return readFlowSteps(frontmatter.body).map((step, index) => ({
    description: step.block.trim(),
    doneWhen: completionOf(step.block),
    index,
    name: firstLine(step.block),
  }));
};

/** Whether frontmatter records explicit user verification on this platform. */
export const isVerifiedFlow = (
  files: readonly { readonly content: string; readonly path: string }[],
  platform: PlatformIdentity = "web"
): boolean =>
  files.some((file) => {
    if (file.path !== FLOW_FILE) {
      return false;
    }
    const stamp = readFlowFrontmatter(file.content)?.verification;
    return (
      stamp?.outcome === "passed" &&
      (stamp.verifiedAt?.length ?? 0) > 0 &&
      stamp.platform === platform &&
      matchesFlowVerificationDigests(file.content, files, stamp.digests)
    );
  });
