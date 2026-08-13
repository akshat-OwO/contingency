import { randomUUID } from "node:crypto";

import {
  Flow as FlowSchema,
  hasAuthoredBrowserStep,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AuditKind,
  BrowserRpcErrorType,
  ChangeStep,
  ClickStep,
  ChromeStep,
  Flow,
  KeyStep,
  NavigateStep,
  PreStep,
  RecordedStep,
  RecordingCaptureMode,
  RecordingPhase,
  RecordingSnapshot,
  SessionId,
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

const FILE_PART_PATTERN = /[^a-z0-9]+/gu;
const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|code|password)/iu;
const SECRET_REFERENCE_PATTERN = /\{\{(?<name>[A-Z][A-Z0-9_]*)\}\}/gu;

export type CapturedAction =
  | ClickStep
  | KeyStep
  | NavigateStep
  | (ChangeStep & { readonly secretVariable?: string | undefined });

export type RecorderCaptureEvent =
  | CapturedAction
  | { readonly type: "beforeUnload" }
  | {
      readonly causedByAction?: boolean | undefined;
      readonly title?: string | undefined;
      readonly type: "navigation";
      readonly url: string;
    }
  | { readonly reason: string; readonly type: "unsupported" };

const toChromeStep = (action: CapturedAction): ChromeStep => {
  if (action.type !== "change") {
    return action;
  }
  const { secretVariable: _secretVariable, ...step } = action;
  return step;
};

const toPreStepAction = (
  action: Exclude<CapturedAction, NavigateStep>
): PreStep["step"] => {
  if (action.type !== "change") {
    return action;
  }
  const { secretVariable: _secretVariable, ...step } = action;
  return step;
};

export interface RecorderCaptureStartOptions {
  readonly onEvent: (
    event: RecorderCaptureEvent
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly onFailure: (message: string) => Effect.Effect<void>;
  readonly sessionId: SessionId;
  readonly tabId: string;
}

export interface RecorderCapture {
  readonly start: (
    options: RecorderCaptureStartOptions
  ) => Effect.Effect<Effect.Effect<void>, BrowserRpcErrorType>;
}

interface DeletedStep {
  readonly index: number;
  readonly step: RecordedStep;
}

interface RecordingState {
  readonly captureMode: RecordingCaptureMode;
  readonly deletedStep: DeletedStep | undefined;
  readonly flowPreSteps: readonly PreStep[];
  readonly incompleteReason: string | undefined;
  readonly initialUrl: string;
  readonly phase: RecordingPhase;
  readonly pendingNavigation: boolean;
  readonly revision: number;
  readonly secretVariables: readonly string[];
  readonly sessionId: SessionId;
  readonly steps: readonly RecordedStep[];
  readonly stopCapture: Effect.Effect<void>;
  readonly tabId: string;
  readonly targetPreStepIndex: number | undefined;
  readonly targetStepId: string | undefined;
  readonly title: string;
}

export interface RecordingStartInput {
  readonly initialUrl: string;
  readonly sessionId: SessionId;
  readonly tabId: string;
  readonly title: string;
}

export interface RecordingService {
  readonly addAudit: (
    audit: AuditKind
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly bindSecret: (
    stepId: string,
    name: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
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
  readonly cancelCaptureMode: () => Effect.Effect<
    RecordingSnapshot,
    BrowserRpcErrorType
  >;
  readonly deleteStep: (
    stepId: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly discard: () => Effect.Effect<void, BrowserRpcErrorType>;
  readonly fail: (reason: string) => Effect.Effect<void>;
  readonly finish: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly get: () => Effect.Effect<RecordingSnapshot | null>;
  readonly pause: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly recordNavigation: (
    url: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly recover: (
    currentUrl: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly resume: () => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly renameSecret: (
    from: string,
    name: string
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly start: (
    input: RecordingStartInput
  ) => Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>;
  readonly stream: () => Stream.Stream<RecordingSnapshot>;
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

const normalizeSecretName = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");

interface SanitizedUrl {
  readonly secretVariables: readonly string[];
  readonly url: string;
}

const uniqueSecretName = (
  candidate: string,
  existing: readonly string[]
): string => {
  const base =
    candidate
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "") || "SECRET";
  if (!existing.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.includes(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
};

const replaceSecretReference = (
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

const renameStepSecret = (
  recorded: RecordedStep,
  from: string,
  name: string
): RecordedStep => {
  const { step } = recorded;
  if (step.type === "customStep") {
    return recorded;
  }
  const assertedEvents = step.assertedEvents?.map((event) => ({
    ...event,
    url: replaceSecretReference(event.url, from, name),
  }));
  let renamedStep: ChromeStep = {
    ...step,
    ...(assertedEvents === undefined ? {} : { assertedEvents }),
  };
  if (step.type === "change") {
    renamedStep = {
      ...step,
      ...(assertedEvents === undefined ? {} : { assertedEvents }),
      value: replaceSecretReference(step.value, from, name),
    };
  } else if (step.type === "navigate") {
    renamedStep = {
      ...step,
      ...(assertedEvents === undefined ? {} : { assertedEvents }),
      url: replaceSecretReference(step.url, from, name),
    };
  }
  return {
    ...recorded,
    ...(recorded.secretVariable === from ? { secretVariable: name } : {}),
    step: renamedStep,
  };
};

const renamePreStepSecret = (
  preStep: PreStep,
  from: string,
  name: string
): PreStep => ({
  ...preStep,
  step:
    preStep.step.type === "change"
      ? {
          ...preStep.step,
          value: replaceSecretReference(preStep.step.value, from, name),
        }
      : preStep.step,
});

const assignedSecretName = (
  candidate: string | undefined,
  previous: RecordedStep | undefined,
  replacesPrevious: boolean,
  existing: readonly string[]
): string | undefined => {
  if (candidate === undefined) {
    return undefined;
  }
  if (replacesPrevious && previous?.secretVariable !== undefined) {
    return previous.secretVariable;
  }
  return uniqueSecretName(candidate, existing);
};

const sanitizeUrl = (
  value: string,
  existingSecrets: readonly string[]
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
      const secretVariables = [...existingSecrets];
      for (const [name, parameterValue] of url.searchParams) {
        if (
          parameterValue.length === 0 ||
          !SENSITIVE_QUERY_PARAMETER.test(name)
        ) {
          continue;
        }
        const secretName = uniqueSecretName(name, secretVariables);
        secretVariables.push(secretName);
        url.searchParams.set(name, `{{${secretName}}}`);
      }
      return { secretVariables, url: url.href };
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

const toFlowStep = (recorded: RecordedStep): Flow["steps"][number] => {
  if (recorded.step.type === "customStep") {
    return recorded.step;
  }
  const hasExtensions =
    recorded.preSteps.length > 0 || recorded.secretVariable !== undefined;
  if (!hasExtensions) {
    return recorded.step;
  }

  return {
    ...recorded.step,
    contingency: {
      id: recorded.id,
      ...(recorded.preSteps.length === 0
        ? {}
        : { preSteps: recorded.preSteps }),
      ...(recorded.secretVariable === undefined
        ? {}
        : { secretVariable: recorded.secretVariable }),
    },
  };
};

const toFlow = (state: RecordingState): Flow => ({
  ...(state.flowPreSteps.length === 0 && state.secretVariables.length === 0
    ? {}
    : {
        contingency: {
          ...(state.flowPreSteps.length === 0
            ? {}
            : { preSteps: state.flowPreSteps }),
          ...(state.secretVariables.length === 0
            ? {}
            : {
                secretVariables: state.secretVariables.map((name) => ({
                  name,
                })),
              }),
        },
      }),
  selectorAttribute: "data-testid",
  steps: state.steps.map(toFlowStep),
  title: state.title,
});

const referencedSecretVariables = (
  state: Pick<RecordingState, "flowPreSteps" | "initialUrl" | "steps">
): readonly string[] => {
  const references = new Set<string>();
  const addReferences = (value: unknown) => {
    const serialized = JSON.stringify(value);
    for (const match of serialized.matchAll(SECRET_REFERENCE_PATTERN)) {
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
        yield* current.stopCapture;
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
      transitions.withPermit(failUnlocked(reason));

    const captureAction = (
      event: RecorderCaptureEvent
    ): Effect.Effect<void, BrowserRpcErrorType> => {
      if (event.type === "unsupported") {
        return fail(event.reason);
      }
      return mutate((state) =>
        // The reducer covers the discriminated capture event and authoring
        // mode state machines in one serialized transition.
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* appendCapturedAction() {
          const mutable = yield* requireMutable(state);
          if (event.type === "beforeUnload") {
            return [
              undefined,
              { ...mutable, pendingNavigation: true },
            ] as const;
          }
          if (event.type === "navigation") {
            if (mutable.phase === "paused") {
              yield* mutable.stopCapture;
              const next = {
                ...mutable,
                incompleteReason:
                  "The pinned tab navigated while capture was paused.",
                phase: "incomplete" as const,
                revision: mutable.revision + 1,
              };
              return [undefined, next] as const;
            }
            const sanitized = yield* sanitizeUrl(
              event.url,
              mutable.secretVariables
            );
            const last = mutable.steps.findLast(
              ({ step }) => step.type !== "customStep"
            );
            if (
              ((mutable.pendingNavigation && event.causedByAction !== false) ||
                event.causedByAction === true) &&
              last !== undefined &&
              last.step.type !== "navigate"
            ) {
              const steps = mutable.steps.map((recorded) => {
                if (recorded.id !== last.id) {
                  return recorded;
                }
                const assertedEvents =
                  "assertedEvents" in recorded.step &&
                  recorded.step.assertedEvents !== undefined
                    ? recorded.step.assertedEvents
                    : [];
                return {
                  ...recorded,
                  step: {
                    ...recorded.step,
                    assertedEvents: [
                      ...assertedEvents,
                      {
                        ...(event.title === undefined
                          ? {}
                          : { title: event.title }),
                        type: "navigation" as const,
                        url: sanitized.url,
                      },
                    ],
                  },
                };
              });
              const next = {
                ...mutable,
                pendingNavigation: true,
                revision: mutable.revision + 1,
                secretVariables: sanitized.secretVariables,
                steps,
              };
              return [undefined, next] as const;
            }
            const lastUrl =
              last?.step.type === "navigate" ? last.step.url : undefined;
            if (lastUrl === sanitized.url) {
              return [
                undefined,
                { ...mutable, pendingNavigation: false },
              ] as const;
            }
            const navigation: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { type: "navigate", url: sanitized.url },
            };
            const next = {
              ...mutable,
              pendingNavigation: false,
              revision: mutable.revision + 1,
              secretVariables: sanitized.secretVariables,
              steps: [...mutable.steps, navigation],
            };
            return [undefined, next] as const;
          }

          const action = event;
          if (
            mutable.phase !== "active" &&
            mutable.captureMode === "ordinary"
          ) {
            return [undefined, mutable] as const;
          }

          const secretVariable =
            action.type === "change" ? action.secretVariable : undefined;
          const lastRecorded = mutable.steps.at(-1);
          const replacesLastChange =
            action.type === "change" &&
            lastRecorded?.step.type === "change" &&
            JSON.stringify(lastRecorded.step.selectors) ===
              JSON.stringify(action.selectors);
          const assignedSecretVariable = assignedSecretName(
            secretVariable,
            lastRecorded,
            replacesLastChange,
            mutable.secretVariables
          );
          const step =
            action.type === "change" && assignedSecretVariable !== undefined
              ? {
                  ...toChromeStep(action),
                  value: `{{${assignedSecretVariable}}}`,
                }
              : toChromeStep(action);
          const recorded: RecordedStep = {
            id: randomUUID(),
            preSteps: [],
            ...(assignedSecretVariable === undefined
              ? {}
              : { secretVariable: assignedSecretVariable }),
            step,
          };

          if (mutable.captureMode === "ordinary") {
            const steps = replacesLastChange
              ? mutable.steps.map((existing) =>
                  existing.id === lastRecorded.id
                    ? {
                        ...existing,
                        ...(recorded.secretVariable === undefined
                          ? { secretVariable: undefined }
                          : { secretVariable: recorded.secretVariable }),
                        step: recorded.step,
                      }
                    : existing
                )
              : [...mutable.steps, recorded];
            const next = {
              ...mutable,
              deletedStep: undefined,
              pendingNavigation: false,
              revision: mutable.revision + 1,
              secretVariables:
                assignedSecretVariable === undefined
                  ? mutable.secretVariables
                  : [...mutable.secretVariables, assignedSecretVariable],
              steps,
            };
            return [
              undefined,
              {
                ...next,
                secretVariables: referencedSecretVariables(next),
              },
            ] as const;
          }

          if (mutable.captureMode === "conditionPicker") {
            const targetIndex = mutable.targetPreStepIndex;
            if (targetIndex === undefined || action.type === "navigate") {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Pick an element for the Pre-step condition."
                )
              );
            }
            const when = {
              selectors: action.selectors,
              type: "selectorVisible" as const,
            };
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
            const next = {
              ...mutable,
              captureMode: "ordinary" as const,
              flowPreSteps,
              revision: mutable.revision + 1,
              steps,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
            };
            return [undefined, next] as const;
          }

          if (action.type === "navigate") {
            return yield* Effect.fail(
              recordingError(
                "recording_invalid",
                "Navigation cannot be recorded as a Pre-step."
              )
            );
          }

          const preStepAction = toPreStepAction(action);
          const preStep: PreStep = {
            id: randomUUID(),
            step:
              preStepAction.type === "change" &&
              assignedSecretVariable !== undefined
                ? {
                    ...preStepAction,
                    value: `{{${assignedSecretVariable}}}`,
                  }
                : preStepAction,
            when: { selectors: action.selectors, type: "selectorVisible" },
          };
          if (mutable.captureMode === "flowPreStep") {
            const nextBase = {
              ...mutable,
              captureMode: "ordinary" as const,
              flowPreSteps: [...mutable.flowPreSteps, preStep],
              revision: mutable.revision + 1,
              secretVariables:
                assignedSecretVariable === undefined
                  ? mutable.secretVariables
                  : [...mutable.secretVariables, assignedSecretVariable],
              targetPreStepIndex: undefined,
              targetStepId: undefined,
            };
            const next = {
              ...nextBase,
              secretVariables: referencedSecretVariables(nextBase),
            };
            return [undefined, next] as const;
          }

          const { targetStepId } = mutable;
          const nextSteps = mutable.steps.map((recordedStep) =>
            recordedStep.id === targetStepId
              ? {
                  ...recordedStep,
                  preSteps: [...recordedStep.preSteps, preStep],
                }
              : recordedStep
          );
          const nextBase = {
            ...mutable,
            captureMode: "ordinary" as const,
            revision: mutable.revision + 1,
            secretVariables:
              assignedSecretVariable === undefined
                ? mutable.secretVariables
                : [...mutable.secretVariables, assignedSecretVariable],
            steps: nextSteps,
            targetPreStepIndex: undefined,
            targetStepId: undefined,
          };
          const next = {
            ...nextBase,
            secretVariables: referencedSecretVariables(nextBase),
          };
          return [undefined, next] as const;
        })
      ).pipe(Effect.asVoid);
    };

    // Keep the public service operations grouped by authoring concern.
    // oxlint-disable-next-line eslint/sort-keys
    const service: RecordingService = {
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
              step: {
                name: "contingency.audit",
                parameters: { kind: audit },
                type: "customStep",
              },
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
      bindSecret: (stepId, requestedName) =>
        mutate((state) =>
          Effect.gen(function* bindStepSecret() {
            const mutable = yield* requireMutable(state);
            const name = normalizeSecretName(requestedName);
            if (name.length === 0) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "A Secret Variable name is required."
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
                secretVariable: name,
                step: { ...recorded.step, value: `{{${name}}}` },
              };
            });
            if (!found) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Only recorded form changes can use a Secret Variable."
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
              secretVariables: referencedSecretVariables(nextBase),
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
                ({ id, step }) =>
                  id === scope.stepId && step.type !== "customStep"
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
            const steps = mutable.steps.filter(({ id }) => id !== stepId);
            const nextBase = {
              ...mutable,
              deletedStep: { index, step },
              revision: mutable.revision + 1,
              steps,
            };
            const next = {
              ...nextBase,
              secretVariables: referencedSecretVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
      discard: () =>
        transitions.withPermit(
          Effect.gen(function* discardRecording() {
            const current = yield* Ref.get(stateRef).pipe(
              Effect.flatMap(requireState)
            );
            if (current.phase === "active" || current.phase === "paused") {
              yield* current.stopCapture;
            }
            yield* Ref.set(stateRef, null);
          })
        ),
      fail,
      finish: () =>
        mutate((state) =>
          Effect.gen(function* finishRecording() {
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
            yield* mutable.stopCapture;
            const next = {
              ...mutable,
              deletedStep: undefined,
              phase: "finished" as const,
              revision: mutable.revision + 1,
            };
            return [{ ...toSnapshot(next), flow }, next] as const;
          })
        ),
      get: () =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => state && toSnapshot(state))
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
      recordNavigation: (url) =>
        Effect.gen(function* recordBrowserNavigation() {
          yield* captureAction({
            causedByAction: false,
            type: "navigation",
            url,
          });
          return yield* Ref.get(stateRef).pipe(
            Effect.flatMap(requireState),
            Effect.map(toSnapshot)
          );
        }),
      recover: (currentUrl) =>
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
            const sanitized = yield* sanitizeUrl(
              currentUrl,
              current.secretVariables
            );
            const stopCapture = yield* capture.start({
              onEvent: captureAction,
              onFailure: fail,
              sessionId: current.sessionId,
              tabId: current.tabId,
            });
            const checkpoint: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { type: "navigate", url: sanitized.url },
            };
            const next = {
              ...current,
              captureMode: "ordinary" as const,
              deletedStep: undefined,
              incompleteReason: undefined,
              pendingNavigation: false,
              phase: "active" as const,
              revision: current.revision + 1,
              secretVariables: sanitized.secretVariables,
              steps: [...current.steps, checkpoint],
              stopCapture,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
            };
            yield* setState(next);
            return toSnapshot(next);
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
      renameSecret: (from, requestedName) =>
        mutate((state) =>
          Effect.gen(function* renameSecretVariable() {
            const mutable = yield* requireMutable(state);
            const name = normalizeSecretName(requestedName);
            if (
              name.length === 0 ||
              !mutable.secretVariables.includes(from) ||
              (name !== from && mutable.secretVariables.includes(name))
            ) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "Choose a unique Secret Variable name."
                )
              );
            }
            const nextBase = {
              ...mutable,
              flowPreSteps: mutable.flowPreSteps.map((preStep) =>
                renamePreStepSecret(preStep, from, name)
              ),
              initialUrl: replaceSecretReference(
                mutable.initialUrl,
                from,
                name
              ),
              revision: mutable.revision + 1,
              steps: mutable.steps.map((recorded) => ({
                ...renameStepSecret(recorded, from, name),
                preSteps: recorded.preSteps.map((preStep) =>
                  renamePreStepSecret(preStep, from, name)
                ),
              })),
            };
            const next = {
              ...nextBase,
              secretVariables: referencedSecretVariables(nextBase),
            };
            return [toSnapshot(next), next] as const;
          })
        ),
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
            if (
              input.title.trim().length === 0 ||
              input.initialUrl.trim().length === 0
            ) {
              return yield* Effect.fail(
                recordingError(
                  "recording_invalid",
                  "A title and current page URL are required."
                )
              );
            }
            const sanitized = yield* sanitizeUrl(input.initialUrl, []);
            const initialStep: RecordedStep = {
              id: randomUUID(),
              preSteps: [],
              step: { type: "navigate", url: sanitized.url },
            };
            const stopCapture = yield* capture.start({
              onEvent: captureAction,
              onFailure: fail,
              sessionId: input.sessionId,
              tabId: input.tabId,
            });
            const state: RecordingState = {
              captureMode: "ordinary",
              deletedStep: undefined,
              flowPreSteps: [],
              incompleteReason: undefined,
              initialUrl: sanitized.url,
              pendingNavigation: false,
              phase: "active",
              revision: 0,
              secretVariables: sanitized.secretVariables,
              sessionId: input.sessionId,
              steps: [initialStep],
              stopCapture,
              tabId: input.tabId,
              targetPreStepIndex: undefined,
              targetStepId: undefined,
              title: input.title.trim(),
            };
            yield* setState(state);
            return toSnapshot(state);
          })
        ),
      stream: () => Stream.fromPubSub(updates),
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
              secretVariables: referencedSecretVariables(nextBase),
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
