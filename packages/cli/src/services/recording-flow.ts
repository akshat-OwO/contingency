import { makeBrowserRpcError } from "@contingency/protocol";
import type {
  AuthoredStep,
  FlowId,
  BrowserRpcErrorType,
  BrowserTabId,
  Flow,
  PreStep,
  RecordedStep,
  RecordingCaptureMode,
  RecordingPhase,
  RecordingSnapshot,
  SessionId,
} from "@contingency/protocol";
import { Effect } from "effect";

import type { CaptureFailure } from "./recorder-events.ts";

/**
 * How a Recording becomes a Flow: the document it derives, the snapshot Create
 * View reads, and the Variable naming that keeps a captured secret out of both.
 *
 * Separated from the capture state machine because these change for different
 * reasons — this file moves when the Flow document does, `recording.ts` when
 * capture does.
 */
export interface DeletedStep {
  readonly index: number;
  readonly step: RecordedStep;
}

export interface RecordingState {
  readonly captureMode: RecordingCaptureMode;
  readonly deletedStep: DeletedStep | undefined;
  readonly flowId: FlowId;
  readonly flowPreSteps: readonly PreStep[];
  readonly incompleteFailure: CaptureFailure | undefined;
  readonly initialUrl: string;
  /**
   * When each Page last saw an action, and which Pages are leaving. Held per
   * Page rather than per Recording: a click on one Page explains a navigation
   * on that Page and on no other, and attributing across Pages would drop an
   * independent navigation a replay needs.
   */
  readonly lastActionAt: ReadonlyMap<number, number>;
  readonly phase: RecordingPhase;
  readonly pendingNavigation: ReadonlySet<number>;
  readonly revision: number;
  readonly sessionId: SessionId;
  readonly steps: readonly RecordedStep[];
  readonly stopCapture: Effect.Effect<void>;
  readonly tabId: BrowserTabId;
  readonly targetPreStepIndex: number | undefined;
  readonly targetStepId: string | undefined;
  readonly title: string;
  readonly variables: readonly string[];
}

const FILE_PART_PATTERN = /[^a-z0-9]+/gu;
const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;
const VARIABLE_REFERENCE_PATTERN = /\{\{(?<name>[A-Z][A-Z0-9_]*)\}\}/gu;

/** How long after an action a navigation still belongs to that action. */

export const recordingError = (
  code: BrowserRpcErrorType["code"],
  message: string
): BrowserRpcErrorType => makeBrowserRpcError(code, message);

const normalizePart = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(FILE_PART_PATTERN, "-")
    .replaceAll(/^-|-$/gu, "");

export const normalizeVariableName = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");

export const uniqueVariableName = (
  candidate: string,
  existing: readonly string[]
): string => {
  const base = normalizeVariableName(candidate) || "SECRET";
  if (!existing.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
};

export const replaceVariableReference = (
  value: string,
  from: string,
  name: string
): string =>
  value
    .replaceAll(`{{${from}}}`, `{{${name}}}`)
    .replaceAll(
      encodeURIComponent(`{{${from}}}`),
      encodeURIComponent(`{{${name}}}`)
    );

export const renameStepValue = (
  step: RecordedStep["step"],
  from: string,
  name: string
): RecordedStep["step"] => {
  if (step.type === "change") {
    return { ...step, value: replaceVariableReference(step.value, from, name) };
  }
  if (step.type === "navigate") {
    return { ...step, url: replaceVariableReference(step.url, from, name) };
  }
  return step;
};

export const renamePreStepVariable = (
  preStep: PreStep,
  from: string,
  name: string
): PreStep => ({
  ...preStep,
  step:
    preStep.step.type === "change"
      ? {
          ...preStep.step,
          value: replaceVariableReference(preStep.step.value, from, name),
        }
      : preStep.step,
});

export const assignedVariableName = (
  candidate: string | undefined,
  previous: RecordedStep | undefined,
  replacesPrevious: boolean,
  existing: readonly string[]
): string | undefined => {
  if (candidate === undefined) {
    return undefined;
  }
  if (replacesPrevious && previous?.variable !== undefined) {
    return previous.variable;
  }
  return uniqueVariableName(candidate, existing);
};

interface SanitizedUrl {
  readonly url: string;
  readonly variables: readonly string[];
}

export const sanitizeUrl = (
  value: string,
  existingVariables: readonly string[]
): Effect.Effect<SanitizedUrl, BrowserRpcErrorType> =>
  Effect.try({
    catch: () =>
      recordingError(
        "recording_invalid",
        "URLs with embedded credentials are not supported."
      ),
    try: () => {
      const url = new URL(value);
      if (url.username.length > 0 || url.password.length > 0) {
        throw new Error("URL credentials are not supported");
      }
      url.hash = "";
      const variables = [...existingVariables];
      const placeholders: string[] = [];
      for (const [name, parameterValue] of url.searchParams) {
        if (
          parameterValue.length === 0 ||
          !SENSITIVE_QUERY_PARAMETER.test(name)
        ) {
          continue;
        }
        const variableName = uniqueVariableName(name, variables);
        variables.push(variableName);
        placeholders.push(variableName);
        url.searchParams.set(name, `{{${variableName}}}`);
      }
      // Serializing percent-encodes the braces, and a reference is only a
      // reference in its raw form: encoded, neither the Runner's substitution
      // nor this Flow's own Variable discovery would recognise it, so the
      // value would replay as literal text and the declaration would vanish
      // the next time Variables were re-derived.
      let { href } = url;
      for (const variableName of placeholders) {
        href = href.replaceAll(
          encodeURIComponent(`{{${variableName}}}`),
          `{{${variableName}}}`
        );
      }
      return { url: href, variables };
    },
  });

export const flowDownloadName = (initialUrl: string, title: string): string => {
  const url = new URL(initialUrl);
  const hostname = url.hostname.replace(/^www\./u, "");
  const hostnameParts = hostname.split(".");
  const conciseHostname =
    hostnameParts.length === 2 ? (hostnameParts[0] ?? hostname) : hostname;
  const host = normalizePart(
    url.port.length > 0 ? `${conciseHostname}-${url.port}` : conciseHostname
  );
  const name = normalizePart(title);
  return host.length > 0 && name.length > 0
    ? `${host}-${name}.json`
    : "contingency-flow.json";
};

const toAuthoredStep = (recorded: RecordedStep): AuthoredStep => ({
  ...recorded.step,
  id: recorded.id,
  ...(recorded.preSteps.length === 0 ? {} : { preSteps: recorded.preSteps }),
  ...(recorded.variable === undefined ? {} : { variable: recorded.variable }),
});

export const toFlow = (state: RecordingState): Flow => ({
  // Always emitted, because a Flow keys its Run history on this rather than on
  // the user-editable title, which would orphan that history on a rename.
  flowId: state.flowId,
  ...(state.flowPreSteps.length === 0 ? {} : { preSteps: state.flowPreSteps }),
  steps: state.steps.map(toAuthoredStep),
  title: state.title,
  ...(state.variables.length === 0
    ? {}
    : {
        // Create View only authors withheld sensitive values, so every
        // Variable it declares is both redacted from a Run and promptable
        // when the Runner has no value for it.
        variables: state.variables.map((name) => ({
          name,
          runtime: true,
          secret: true,
        })),
      }),
});

export const referencedVariables = (
  state: Pick<RecordingState, "flowPreSteps" | "initialUrl" | "steps">
): readonly string[] => {
  const references = new Set<string>();
  const addReferences = (value: unknown) => {
    for (const match of JSON.stringify(value).matchAll(
      VARIABLE_REFERENCE_PATTERN
    )) {
      const { name } = match.groups ?? {};
      if (name !== undefined) {
        references.add(name);
      }
    }
  };
  addReferences(state.initialUrl);
  addReferences(state.flowPreSteps);
  addReferences(state.steps);
  return [...references];
};

export const toSnapshot = (state: RecordingState): RecordingSnapshot => ({
  captureMode: state.captureMode,
  ...(state.phase === "finished"
    ? { downloadName: flowDownloadName(state.initialUrl, state.title) }
    : {}),
  flow: toFlow(state),
  ...(state.incompleteFailure === undefined
    ? {}
    : { incompleteReason: state.incompleteFailure.message }),
  initialUrl: state.initialUrl,
  phase: state.phase,
  recordedSteps: state.steps,
  revision: state.revision,
  sessionId: state.sessionId,
  tabId: state.tabId,
  ...(state.targetStepId === undefined
    ? {}
    : { targetStepId: state.targetStepId }),
  undoAvailable: state.deletedStep !== undefined,
});

/**
 * The shape every edit shares: bump the revision, re-derive the Variables the
 * Flow still references, and answer with the resulting snapshot. Variables are
 * derived rather than tracked, so deleting the Step that used one drops it.
 */
export const advance = (
  mutable: RecordingState,
  patch: Partial<RecordingState>
): readonly [RecordingSnapshot, RecordingState] => {
  const next = { ...mutable, ...patch, revision: mutable.revision + 1 };
  const settled = { ...next, variables: referencedVariables(next) };
  return [toSnapshot(settled), settled] as const;
};
