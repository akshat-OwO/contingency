import { randomUUID } from "node:crypto";

import {
  FlowId,
  Flow as FlowSchema,
  hasAuthoredBrowserStep,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AuditKind,
  AuthoredStep,
  BrowserActionStep,
  BrowserRpcErrorType,
  BrowserTabId,
  Condition,
  Flow,
  PreStep,
  RecordedStep,
  RecordingCaptureMode,
  RecordingPhase,
  RecordingSnapshot,
  SessionId,
  Target,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import type {
  CapturedAction,
  RecorderCaptureEvent,
} from "./recorder-events.ts";

const FILE_PART_PATTERN = /[^a-z0-9]+/gu;
const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;
const VARIABLE_REFERENCE_PATTERN = /\{\{(?<name>[A-Z][A-Z0-9_]*)\}\}/gu;

/** How long after an action a navigation still belongs to that action. */
const ACTION_NAVIGATION_WINDOW_MS = 1000;

export interface RecorderCaptureStartOptions {
  readonly onEvent: (
    event: RecorderCaptureEvent
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly onFailure: (message: string) => Effect.Effect<void>;
  readonly sessionId: SessionId;
}

/**
 * What capture hands back: how to stop, and the identity of the Page the
 * Recording is pinned to. A Recording spans the Pages that session opens, but
 * never migrates to another session.
 */
export interface RecorderCaptureHandle {
  readonly stop: Effect.Effect<void>;
  readonly tabId: BrowserTabId;
  readonly url: string;
}

export interface RecorderCapture {
  readonly start: (
    options: RecorderCaptureStartOptions
  ) => Effect.Effect<RecorderCaptureHandle, BrowserRpcErrorType>;
}

interface DeletedStep {
  readonly index: number;
  readonly step: RecordedStep;
}

interface RecordingState {
  readonly captureMode: RecordingCaptureMode;
  readonly deletedStep: DeletedStep | undefined;
  readonly flowId: FlowId;
  readonly flowPreSteps: readonly PreStep[];
  readonly incompleteReason: string | undefined;
  readonly initialUrl: string;
  readonly lastActionAt: number;
  readonly phase: RecordingPhase;
  readonly pendingNavigation: boolean;
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

export interface RecordingStartInput {
  readonly sessionId: SessionId;
  readonly title: string;
}

export interface RecordingService {
  readonly addAudit: (
    audit: AuditKind
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly armHover: () => Effect.Effect<
    RecordingSnapshot,
    BrowserRpcErrorType
  >;
  readonly armPreStep: (
    scope:
      | { readonly type: "flow" }
      | { readonly stepId: string; readonly type: "step" }
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly armPreStepCondition: (
    scope:
      | { readonly index: number; readonly type: "flow" }
      | {
          readonly index: number;
          readonly stepId: string;
          readonly type: "step";
        }
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly bindVariable: (
    stepId: string,
    name: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly cancelCaptureMode: () => Effect.Effect<
    RecordingSnapshot,
    BrowserRpcErrorType
  >;
  readonly changes: () => Stream.Stream<RecordingSnapshot>;
  readonly deleteStep: (
    stepId: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly discard: () => Effect.Effect<void, BrowserRpcErrorType>;
  readonly fail: (reason: string) => Effect.Effect<void>;
  readonly finish: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly get: () => Effect.Effect<RecordingSnapshot | null>;
  readonly pause: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly recover: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly renameVariable: (
    from: string,
    name: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly resume: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly start: (
    input: RecordingStartInput
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly undoDelete: () => Effect.Effect<
    RecordingSnapshot,
    BrowserRpcErrorType
  >;
  readonly updateTitle: (
    title: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
}

export const Recording = Context.Service<RecordingService>(
  "@contingency/Recording"
);

const recordingError = (
  code: BrowserRpcErrorType["code"],
  message: string
): BrowserRpcErrorType => makeBrowserRpcError(code, message);

const normalizePart = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(FILE_PART_PATTERN, "-")
    .replaceAll(/^-|-$/gu, "");

const normalizeVariableName = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");

const uniqueVariableName = (
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

const replaceVariableReference = (
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

const renameStepValue = (
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

const renamePreStepVariable = (
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

const assignedVariableName = (
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

const sanitizeUrl = (
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
      for (const [name, parameterValue] of url.searchParams) {
        if (
          parameterValue.length === 0 ||
          !SENSITIVE_QUERY_PARAMETER.test(name)
        ) {
          continue;
        }
        const variableName = uniqueVariableName(name, variables);
        variables.push(variableName);
        url.searchParams.set(name, `{{${variableName}}}`);
      }
      return { url: url.href, variables };
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

const toFlow = (state: RecordingState): Flow => ({
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

const referencedVariables = (
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

/**
 * The failures a Recording can come back from: a lost recorder connection and
 * nothing else. Every other terminal reason is lost integrity — a Recording
 * that resumed past one would silently omit actions it failed to capture.
 */
const recoverableIncompleteReasons = new Set([
  "The browser recorder connection was lost.",
  "The recorder could not reach the browser session.",
]);

const isRecoverableIncompleteReason = (reason: string | undefined): boolean =>
  reason !== undefined && recoverableIncompleteReasons.has(reason);

const toSnapshot = (state: RecordingState): RecordingSnapshot => ({
  captureMode: state.captureMode,
  ...(state.phase === "finished"
    ? { downloadName: flowDownloadName(state.initialUrl, state.title) }
    : {}),
  flow: toFlow(state),
  ...(state.incompleteReason === undefined
    ? {}
    : { incompleteReason: state.incompleteReason }),
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

const requireState = (
  state: RecordingState | null
): Effect.Effect<RecordingState, BrowserRpcErrorType> =>
  state === null
    ? Effect.fail(
        recordingError("recording_unavailable", "No Recording is available.")
      )
    : Effect.succeed(state);

const requireMutable = (
  state: RecordingState
): Effect.Effect<RecordingState, BrowserRpcErrorType> =>
  state.phase === "finished" || state.phase === "incomplete"
    ? Effect.fail(
        recordingError(
          "recording_invalid",
          `A ${state.phase} Recording cannot be edited.`
        )
      )
    : Effect.succeed(state);

/** Where a Step acts, as a Step carries it: the first Page names nothing. */
const pageField = (page: number): { readonly page?: number } =>
  page === 0 ? {} : { page };

type TargetedAction = Extract<
  CapturedAction,
  { readonly target: Target | undefined }
>;

const capturedTarget = (action: CapturedAction): Target | undefined =>
  "target" in action ? action.target : undefined;

/** The Step a captured action becomes, before authoring adds anything. */
const toBrowserStep = (
  action: CapturedAction,
  page: number
): BrowserActionStep | undefined => {
  const at = pageField(page);
  switch (action.type) {
    case "click": {
      return {
        ...at,
        button: action.button,
        target: action.target,
        type: "click",
      };
    }
    case "change": {
      return {
        ...at,
        target: action.target,
        type: "change",
        value: action.value,
      };
    }
    case "selectOption": {
      return {
        ...at,
        target: action.target,
        type: "selectOption",
        values: action.values,
      };
    }
    case "press": {
      return {
        ...at,
        key: action.key,
        ...(action.target === undefined ? {} : { target: action.target }),
        type: "press",
      };
    }
    case "scroll": {
      return {
        ...at,
        ...(action.deltaX === undefined ? {} : { deltaX: action.deltaX }),
        ...(action.deltaY === undefined ? {} : { deltaY: action.deltaY }),
        type: "scroll",
      };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * What a Pre-step may act with: anything that clears interference. A Pre-step
 * does not navigate, and scrolling to reach an obstruction is the Step's own
 * problem, not the Pre-step's.
 */
const toPreStepAction = (
  step: BrowserActionStep
): PreStep["step"] | undefined =>
  step.type === "navigate" || step.type === "scroll" || step.type === "waitFor"
    ? undefined
    : step;

/** Whether an action replaces the Step before it rather than following it. */
const replacesPreviousStep = (
  previous: RecordedStep | undefined,
  step: BrowserActionStep
): boolean => {
  if (previous === undefined) {
    return false;
  }
  const before = previous.step;
  if (before.type !== step.type) {
    return false;
  }
  if (step.type !== "change" && step.type !== "selectOption") {
    return false;
  }
  return (
    "target" in before &&
    JSON.stringify(before.target) === JSON.stringify(step.target)
  );
};

export const makeRecordingService = (
  capture: RecorderCapture
): Effect.Effect<RecordingService> =>
  Effect.gen(function* makeRecording() {
    const stateRef = yield* Ref.make<RecordingState | null>(null);
    const updates = yield* PubSub.sliding<RecordingSnapshot>(32);
    const transitions = yield* Semaphore.make(1);

    const publish = (state: RecordingState) =>
      PubSub.publish(updates, toSnapshot(state)).pipe(Effect.asVoid);

    const setState = (state: RecordingState) =>
      Ref.set(stateRef, state).pipe(Effect.andThen(publish(state)));

    const mutate = <A>(
      update: (
        state: RecordingState
      ) => Effect.Effect<readonly [A, RecordingState], BrowserRpcErrorType>
    ): Effect.Effect<A, BrowserRpcErrorType> =>
      transitions.withPermit(
        Effect.gen(function* mutateState() {
          const current = yield* Ref.get(stateRef).pipe(
            Effect.flatMap(requireState)
          );
          const [result, next] = yield* update(current);
          yield* setState(next);
          return result;
        })
      );

    const failUnlocked = (reason: string) =>
      Effect.gen(function* failRecording() {
        const current = yield* Ref.get(stateRef);
        if (
          current === null ||
          current.phase === "finished" ||
          current.phase === "incomplete"
        ) {
          return;
        }
        yield* setState({
          ...current,
          captureMode: "ordinary",
          incompleteReason: reason,
          phase: "incomplete",
          revision: current.revision + 1,
          targetStepId: undefined,
        });
      });

    const fail = (reason: string) =>
      Effect.gen(function* stopAndFailRecording() {
        const stopCapture = yield* transitions.withPermit(
          Effect.gen(function* findCaptureToStop() {
            const current = yield* Ref.get(stateRef);
            return current === null ||
              current.phase === "finished" ||
              current.phase === "incomplete"
              ? undefined
              : current.stopCapture;
          })
        );
        if (stopCapture === undefined) {
          return;
        }
        yield* stopCapture;
        yield* transitions.withPermit(failUnlocked(reason));
      });

    const reduceNavigation = (
      mutable: RecordingState,
      event: Extract<RecorderCaptureEvent, { readonly type: "navigation" }>
    ): Effect.Effect<
      readonly [undefined, RecordingState],
      BrowserRpcErrorType
    > =>
      Effect.gen(function* reduceCapturedNavigation() {
        if (mutable.phase === "paused") {
          yield* mutable.stopCapture;
          return [
            undefined,
            {
              ...mutable,
              incompleteReason:
                "The pinned tab navigated while capture was paused.",
              phase: "incomplete" as const,
              revision: mutable.revision + 1,
            },
          ] as const;
        }
        const sanitized = yield* sanitizeUrl(event.url, mutable.variables);
        // A navigation a Step caused is that Step's consequence, not another
        // Step: replaying the click navigates again by itself.
        const causedByAction =
          event.causedByAction === true ||
          (event.causedByAction !== false &&
            (mutable.pendingNavigation ||
              Date.now() - mutable.lastActionAt <=
                ACTION_NAVIGATION_WINDOW_MS));
        if (causedByAction) {
          return [
            undefined,
            {
              ...mutable,
              pendingNavigation: false,
              variables: sanitized.variables,
            },
          ] as const;
        }
        const last = mutable.steps.at(-1);
        if (
          last?.step.type === "navigate" &&
          last.step.url === sanitized.url &&
          (last.step.page ?? 0) === event.page
        ) {
          return [undefined, { ...mutable, pendingNavigation: false }] as const;
        }
        const navigation: RecordedStep = {
          id: randomUUID(),
          preSteps: [],
          step: {
            ...pageField(event.page),
            type: "navigate",
            url: sanitized.url,
          },
        };
        return [
          undefined,
          {
            ...mutable,
            pendingNavigation: false,
            revision: mutable.revision + 1,
            steps: [...mutable.steps, navigation],
            variables: sanitized.variables,
          },
        ] as const;
      });

    const requireCapturedTarget = (
      action: CapturedAction
    ): Effect.Effect<Target, BrowserRpcErrorType> => {
      const target = capturedTarget(action);
      return target === undefined
        ? Effect.fail(
            recordingError(
              "recording_invalid",
              "Pick an element on the page for this."
            )
          )
        : Effect.succeed(target);
    };

    const pickPreStepCondition = (
      mutable: RecordingState,
      action: CapturedAction
    ): Effect.Effect<
      readonly [undefined, RecordingState],
      BrowserRpcErrorType
    > =>
      Effect.gen(function* selectPreStepCondition() {
        const targetIndex = mutable.targetPreStepIndex;
        if (targetIndex === undefined) {
          return yield* Effect.fail(
            recordingError(
              "recording_invalid",
              "Pick an element for the Pre-step condition."
            )
          );
        }
        const target = yield* requireCapturedTarget(action);
        const when: Condition = { target, type: "selectorVisible" };
        const flowPreSteps =
          mutable.targetStepId === undefined
            ? mutable.flowPreSteps.map((existing, index) =>
                index === targetIndex ? { ...existing, when } : existing
              )
            : mutable.flowPreSteps;
        const steps = mutable.steps.map((existing) =>
          existing.id === mutable.targetStepId
            ? {
                ...existing,
                preSteps: existing.preSteps.map((preStep, index) =>
                  index === targetIndex ? { ...preStep, when } : preStep
                ),
              }
            : existing
        );
        return [
          undefined,
          {
            ...mutable,
            captureMode: "ordinary" as const,
            flowPreSteps,
            revision: mutable.revision + 1,
            steps,
            targetPreStepIndex: undefined,
            targetStepId: undefined,
          },
        ] as const;
      });

    /** Hover is the element the author picked while hover capture was armed. */
    const pickHover = (
      mutable: RecordingState,
      action: CapturedAction,
      page: number
    ): Effect.Effect<
      readonly [undefined, RecordingState],
      BrowserRpcErrorType
    > =>
      Effect.gen(function* captureHover() {
        const target = yield* requireCapturedTarget(action);
        const hover: RecordedStep = {
          id: randomUUID(),
          preSteps: [],
          step: { ...pageField(page), target, type: "hover" },
        };
        return [
          undefined,
          {
            ...mutable,
            captureMode: "ordinary" as const,
            deletedStep: undefined,
            lastActionAt: Date.now(),
            pendingNavigation: false,
            revision: mutable.revision + 1,
            steps: [...mutable.steps, hover],
          },
        ] as const;
      });

    const capturePreStep = (
      mutable: RecordingState,
      action: TargetedAction,
      step: BrowserActionStep,
      assignedVariable: string | undefined
    ): Effect.Effect<
      readonly [undefined, RecordingState],
      BrowserRpcErrorType
    > =>
      Effect.gen(function* appendPreStep() {
        const preStepAction = toPreStepAction(step);
        if (preStepAction === undefined) {
          return yield* Effect.fail(
            recordingError(
              "recording_invalid",
              `A ${step.type} cannot be recorded as a Pre-step.`
            )
          );
        }
        const target = yield* requireCapturedTarget(action);
        const preStep: PreStep = {
          id: randomUUID(),
          step:
            preStepAction.type === "change" && assignedVariable !== undefined
              ? { ...preStepAction, value: `{{${assignedVariable}}}` }
              : preStepAction,
          when: { target, type: "selectorVisible" },
        };
        const variables =
          assignedVariable === undefined
            ? mutable.variables
            : [...mutable.variables, assignedVariable];
        const nextBase =
          mutable.captureMode === "flowPreStep"
            ? {
                ...mutable,
                flowPreSteps: [...mutable.flowPreSteps, preStep],
                variables,
              }
            : {
                ...mutable,
                steps: mutable.steps.map((recordedStep) =>
                  recordedStep.id === mutable.targetStepId
                    ? {
                        ...recordedStep,
                        preSteps: [...recordedStep.preSteps, preStep],
                      }
                    : recordedStep
                ),
                variables,
              };
        const next = {
          ...nextBase,
          captureMode: "ordinary" as const,
          revision: mutable.revision + 1,
          targetPreStepIndex: undefined,
          targetStepId: undefined,
        };
        return [
          undefined,
          { ...next, variables: referencedVariables(next) },
        ] as const;
      });

    const captureAction = (
      event: RecorderCaptureEvent
    ): Effect.Effect<void, BrowserRpcErrorType> => {
      if (event.type === "unsupported") {
        return fail(event.reason);
      }
      return mutate((state) =>
        Effect.gen(function* appendCapturedAction() {
          const mutable = yield* requireMutable(state);
          if (event.type === "beforeUnload") {
            return [
              undefined,
              { ...mutable, pendingNavigation: true },
            ] as const;
          }
          if (event.type === "navigation") {
            return yield* reduceNavigation(mutable, event);
          }

          const { page, ...action } = event;
          if (
            mutable.phase !== "active" &&
            mutable.captureMode === "ordinary"
          ) {
            return [undefined, mutable] as const;
          }
          if (mutable.captureMode === "conditionPicker") {
            return yield* pickPreStepCondition(mutable, action);
          }
          if (mutable.captureMode === "hoverPicker") {
            return yield* pickHover(mutable, action, page);
          }

          const step = toBrowserStep(action, page);
          if (step === undefined) {
            return [undefined, mutable] as const;
          }
          const variable =
            action.type === "change" ? action.variable : undefined;
          const lastRecorded = mutable.steps.at(-1);
          const replaces = replacesPreviousStep(lastRecorded, step);
          const assignedVariable = assignedVariableName(
            variable,
            lastRecorded,
            replaces,
            mutable.variables
          );
          if (mutable.captureMode !== "ordinary") {
            return yield* capturePreStep(
              mutable,
              action as TargetedAction,
              step,
              assignedVariable
            );
          }

          const recordedStep =
            step.type === "change" && assignedVariable !== undefined
              ? { ...step, value: `{{${assignedVariable}}}` }
              : step;
          const recorded: RecordedStep = {
            id: randomUUID(),
            preSteps: [],
            step: recordedStep,
            ...(assignedVariable === undefined
              ? {}
              : { variable: assignedVariable }),
          };
          const steps =
            replaces && lastRecorded !== undefined
              ? mutable.steps.map((existing) =>
                  existing.id === lastRecorded.id
                    ? { ...recorded, id: existing.id }
                    : existing
                )
              : [...mutable.steps, recorded];
          const next = {
            ...mutable,
            deletedStep: undefined,
            lastActionAt: Date.now(),
            pendingNavigation: false,
            revision: mutable.revision + 1,
            steps,
            variables:
              assignedVariable === undefined
                ? mutable.variables
                : [...mutable.variables, assignedVariable],
          };
          return [
            undefined,
            { ...next, variables: referencedVariables(next) },
          ] as const;
        })
      ).pipe(Effect.asVoid);
    };

    const finishRecording = (
      state: RecordingState
    ): Effect.Effect<
      readonly [RecordingSnapshot, RecordingState],
      BrowserRpcErrorType
    > =>
      Effect.gen(function* validateAndFinishRecording() {
        const mutable = yield* requireMutable(state);
        if (mutable.captureMode !== "ordinary") {
          return yield* Effect.fail(
            recordingError(
              "recording_invalid",
              "Finish or cancel Pre-step authoring first."
            )
          );
        }
        if (mutable.steps.length < 2 || mutable.title.trim().length === 0) {
          return yield* Effect.fail(
            recordingError(
              "recording_invalid",
              "A Flow requires a title and at least one authored Step."
            )
          );
        }
        if (!hasAuthoredBrowserStep(mutable.steps)) {
          return yield* Effect.fail(
            recordingError(
              "recording_invalid",
              "A Flow requires at least one authored browser Step."
            )
          );
        }
        const flow = yield* Schema.decodeUnknownEffect(FlowSchema)(
          toFlow(mutable)
        ).pipe(
          Effect.mapError(() =>
            recordingError(
              "recording_invalid",
              "The captured Flow failed validation."
            )
          )
        );
        const next = {
          ...mutable,
          deletedStep: undefined,
          phase: "finished" as const,
          revision: mutable.revision + 1,
        };
        return [{ ...toSnapshot(next), flow }, next] as const;
      });

    const startCapture = (sessionId: SessionId) =>
      capture.start({
        onEvent: captureAction,
        onFailure: fail,
        sessionId,
      });

    // Keep the public service operations grouped by authoring concern.
    // oxlint-disable-next-line eslint/sort-keys
    const service: RecordingService = {
      start: (input) =>
        transitions.withPermit(
          Effect.gen(function* startRecording() {
            const existing = yield* Ref.get(stateRef);
            if (existing !== null) {
              return yield* Effect.fail(
                recordingError(
                  "recording_conflict",
                  "Finish or discard the existing Recording first."
                )
              );
            }
            if (input.title.trim().length === 0) {
              return yield* Effect.fail(
                recordingError("recording_invalid", "A title is required.")
              );
            }
            const handle = yield* startCapture(input.sessionId);
            const sanitized = yield* sanitizeUrl(handle.url, []).pipe(
              Effect.tapError(() => handle.stop)
            );
            const initialStep: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { type: "navigate", url: sanitized.url },
            };
            const state: RecordingState = {
              captureMode: "ordinary",
              deletedStep: undefined,
              flowId: FlowId.make(randomUUID()),
              flowPreSteps: [],
              incompleteReason: undefined,
              initialUrl: sanitized.url,
              lastActionAt: 0,
              pendingNavigation: false,
              phase: "active",
              revision: 0,
              sessionId: input.sessionId,
              steps: [initialStep],
              stopCapture: handle.stop,
              tabId: handle.tabId,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
              title: input.title.trim(),
              variables: sanitized.variables,
            };
            yield* setState(state);
            return toSnapshot(state);
          })
        ),
      recover: () =>
        transitions.withPermit(
          Effect.gen(function* recoverRecording() {
            const current = yield* Ref.get(stateRef).pipe(
              Effect.flatMap(requireState)
            );
            if (current.phase !== "incomplete") {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Only an incomplete Recording can be recovered."
                )
              );
            }
            if (!isRecoverableIncompleteReason(current.incompleteReason)) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "This Recording cannot be recovered because capture integrity was lost."
                )
              );
            }
            // Capture restarts against the session the Recording is pinned to,
            // and nowhere else: a Recording never migrates to another browser
            // session.
            const handle = yield* startCapture(current.sessionId);
            const sanitized = yield* sanitizeUrl(
              handle.url,
              current.variables
            ).pipe(Effect.tapError(() => handle.stop));
            const checkpoint: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { type: "navigate", url: sanitized.url },
            };
            const next: RecordingState = {
              ...current,
              captureMode: "ordinary",
              deletedStep: undefined,
              incompleteReason: undefined,
              pendingNavigation: false,
              phase: "active",
              revision: current.revision + 1,
              steps: [...current.steps, checkpoint],
              stopCapture: handle.stop,
              tabId: handle.tabId,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
              variables: sanitized.variables,
            };
            yield* setState(next);
            return toSnapshot(next);
          })
        ),
      pause: () =>
        mutate((state) =>
          Effect.gen(function* pauseRecording() {
            const mutable = yield* requireMutable(state);
            if (mutable.phase !== "active") {
              return yield* Effect.fail(
                recordingError("recording_invalid", "Recording is not active.")
              );
            }
            const next = {
              ...mutable,
              phase: "paused" as const,
              revision: mutable.revision + 1,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      resume: () =>
        mutate((state) =>
          Effect.gen(function* resumeRecording() {
            const mutable = yield* requireMutable(state);
            if (mutable.phase !== "paused") {
              return yield* Effect.fail(
                recordingError("recording_invalid", "Recording is not paused.")
              );
            }
            const next = {
              ...mutable,
              phase: "active" as const,
              revision: mutable.revision + 1,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      finish: () =>
        Effect.gen(function* stopAndFinishRecording() {
          const stopCapture = yield* transitions.withPermit(
            Effect.gen(function* validateBeforeStopping() {
              const mutable = yield* Ref.get(stateRef).pipe(
                Effect.flatMap(requireState),
                Effect.flatMap(requireMutable)
              );
              yield* finishRecording(mutable);
              return mutable.stopCapture;
            })
          );
          yield* stopCapture;
          return yield* mutate(finishRecording);
        }),
      discard: () =>
        Effect.gen(function* stopAndDiscardRecording() {
          const stopCapture = yield* transitions.withPermit(
            Effect.gen(function* findCaptureToDiscard() {
              const current = yield* Ref.get(stateRef).pipe(
                Effect.flatMap(requireState)
              );
              return current.phase === "active" || current.phase === "paused"
                ? current.stopCapture
                : Effect.void;
            })
          );
          yield* stopCapture;
          yield* transitions.withPermit(
            Effect.gen(function* discardRecording() {
              yield* Ref.get(stateRef).pipe(Effect.flatMap(requireState));
              yield* Ref.set(stateRef, null);
            })
          );
        }),
      fail,
      get: () =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => state && toSnapshot(state))
        ),
      changes: () => Stream.fromPubSub(updates),
      addAudit: (audit) =>
        mutate((state) =>
          Effect.gen(function* addAuditStep() {
            const mutable = yield* requireMutable(state);
            if (mutable.captureMode !== "ordinary") {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Finish or cancel Pre-step authoring before adding an Audit."
                )
              );
            }
            const auditStep: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { kind: audit, type: "audit" },
            };
            const next = {
              ...mutable,
              deletedStep: undefined,
              revision: mutable.revision + 1,
              steps: [...mutable.steps, auditStep],
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      armHover: () =>
        mutate((state) =>
          Effect.gen(function* armHoverCapture() {
            const mutable = yield* requireMutable(state);
            if (mutable.phase !== "active") {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Hover capture requires an active Recording."
                )
              );
            }
            const next = {
              ...mutable,
              captureMode: "hoverPicker" as const,
              revision: mutable.revision + 1,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      armPreStep: (scope) =>
        mutate((state) =>
          Effect.gen(function* arm() {
            const mutable = yield* requireMutable(state);
            if (mutable.phase !== "active" && mutable.phase !== "paused") {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Pre-steps require an active or paused Recording."
                )
              );
            }
            if (
              scope.type === "step" &&
              !mutable.steps.some(
                ({ id, step }) => id === scope.stepId && step.type !== "audit"
              )
            ) {
              return yield* Effect.fail(
                recordingError("recording_invalid", "Step was not found.")
              );
            }
            const next = {
              ...mutable,
              captureMode:
                scope.type === "flow"
                  ? ("flowPreStep" as const)
                  : ("stepPreStep" as const),
              revision: mutable.revision + 1,
              targetPreStepIndex: undefined,
              targetStepId: scope.type === "step" ? scope.stepId : undefined,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      armPreStepCondition: (scope) =>
        mutate((state) =>
          Effect.gen(function* armConditionPicker() {
            const mutable = yield* requireMutable(state);
            const preSteps =
              scope.type === "flow"
                ? mutable.flowPreSteps
                : mutable.steps.find(({ id }) => id === scope.stepId)?.preSteps;
            if (preSteps?.[scope.index] === undefined) {
              return yield* Effect.fail(
                recordingError("recording_invalid", "Pre-step was not found.")
              );
            }
            const next = {
              ...mutable,
              captureMode: "conditionPicker" as const,
              revision: mutable.revision + 1,
              targetPreStepIndex: scope.index,
              targetStepId: scope.type === "step" ? scope.stepId : undefined,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      cancelCaptureMode: () =>
        mutate((state) =>
          Effect.gen(function* cancel() {
            const mutable = yield* requireMutable(state);
            const next = {
              ...mutable,
              captureMode: "ordinary" as const,
              revision: mutable.revision + 1,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      bindVariable: (stepId, requestedName) =>
        mutate((state) =>
          Effect.gen(function* bindStepVariable() {
            const mutable = yield* requireMutable(state);
            const name = normalizeVariableName(requestedName);
            if (name.length === 0) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "A Variable name is required."
                )
              );
            }
            let found = false;
            const steps = mutable.steps.map((recorded) => {
              if (recorded.id !== stepId || recorded.step.type !== "change") {
                return recorded;
              }
              found = true;
              return {
                ...recorded,
                step: { ...recorded.step, value: `{{${name}}}` },
                variable: name,
              };
            });
            if (!found) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Only recorded form changes can use a Variable."
                )
              );
            }
            const nextBase = {
              ...mutable,
              revision: mutable.revision + 1,
              steps,
            };
            const next = {
              ...nextBase,
              variables: referencedVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      renameVariable: (from, requestedName) =>
        mutate((state) =>
          Effect.gen(function* renameFlowVariable() {
            const mutable = yield* requireMutable(state);
            const name = normalizeVariableName(requestedName);
            if (
              name.length === 0 ||
              !mutable.variables.includes(from) ||
              (name !== from && mutable.variables.includes(name))
            ) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Choose a unique Variable name."
                )
              );
            }
            const nextBase = {
              ...mutable,
              flowPreSteps: mutable.flowPreSteps.map((preStep) =>
                renamePreStepVariable(preStep, from, name)
              ),
              initialUrl: replaceVariableReference(
                mutable.initialUrl,
                from,
                name
              ),
              revision: mutable.revision + 1,
              steps: mutable.steps.map((recorded) => ({
                ...recorded,
                ...(recorded.variable === from ? { variable: name } : {}),
                preSteps: recorded.preSteps.map((preStep) =>
                  renamePreStepVariable(preStep, from, name)
                ),
                step: renameStepValue(recorded.step, from, name),
              })),
            };
            const next = {
              ...nextBase,
              variables: referencedVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      deleteStep: (stepId) =>
        mutate((state) =>
          Effect.gen(function* deleteRecordedStep() {
            const mutable = yield* requireMutable(state);
            const index = mutable.steps.findIndex(({ id }) => id === stepId);
            const step = mutable.steps[index];
            if (index < 1 || step === undefined) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "The initial navigation cannot be deleted."
                )
              );
            }
            const nextBase = {
              ...mutable,
              deletedStep: { index, step },
              revision: mutable.revision + 1,
              steps: mutable.steps.filter(({ id }) => id !== stepId),
            };
            const next = {
              ...nextBase,
              variables: referencedVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      undoDelete: () =>
        mutate((state) =>
          Effect.gen(function* restoreDeletedStep() {
            const mutable = yield* requireMutable(state);
            const deleted = mutable.deletedStep;
            if (deleted === undefined) {
              return yield* Effect.fail(
                recordingError("recording_invalid", "There is nothing to undo.")
              );
            }
            const steps = [...mutable.steps];
            steps.splice(deleted.index, 0, deleted.step);
            const nextBase = {
              ...mutable,
              deletedStep: undefined,
              revision: mutable.revision + 1,
              steps,
            };
            const next = {
              ...nextBase,
              variables: referencedVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      updateTitle: (title) =>
        mutate((state) =>
          Effect.gen(function* renameFlow() {
            const mutable = yield* requireMutable(state);
            const next = {
              ...mutable,
              revision: mutable.revision + 1,
              title,
            };
            return [toSnapshot(next), next] as const;
          })
        ),
    };

    return service;
  });
