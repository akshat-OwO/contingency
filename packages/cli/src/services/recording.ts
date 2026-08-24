import { randomUUID } from "node:crypto";

import {
  FlowId,
  Flow as FlowSchema,
  hasAuthoredBrowserStep,
} from "@contingency/protocol";
import type {
  AuditKind,
  BrowserActionStep,
  BrowserRpcErrorType,
  BrowserTabId,
  Condition,
  PreStep,
  RecordedStep,
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

import { integrityLost } from "./recorder-events.ts";
import type {
  CaptureFailure,
  CapturedAction,
  RecorderCaptureEvent,
  ReducibleCaptureEvent,
} from "./recorder-events.ts";
import {
  advance,
  recordingError,
  referencedVariables,
  renamePreStepVariable,
  renameStepValue,
  replaceVariableReference,
  assignedVariableName,
  normalizeVariableName,
  sanitizeUrl,
  toFlow,
  toSnapshot,
} from "./recording-flow.ts";
import type { RecordingState } from "./recording-flow.ts";

const ACTION_NAVIGATION_WINDOW_MS = 1000;

/** The same set without one Page, since a navigation settles that Page only. */
const withoutPage = (
  pages: ReadonlySet<number>,
  page: number
): ReadonlySet<number> => {
  if (!pages.has(page)) {
    return pages;
  }
  const next = new Set(pages);
  next.delete(page);
  return next;
};

/** The Page a Recording is pinned to: the one it started on. */
const PINNED_PAGE = 0;

export interface RecorderCaptureStartOptions {
  readonly onEvent: (
    event: ReducibleCaptureEvent
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly onFailure: (failure: CaptureFailure) => Effect.Effect<void>;
  readonly sessionId: SessionId;
  /** The Page to pin to, when recovery re-pins the one already recorded. */
  readonly tabId: BrowserTabId | undefined;
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
  readonly fail: (failure: CaptureFailure) => Effect.Effect<void>;
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
const pickPreStepCondition = (
  mutable: RecordingState,
  target: Target
): readonly [undefined, RecordingState] => {
  const targetIndex = mutable.targetPreStepIndex;
  if (targetIndex === undefined) {
    // Arming the picker is what sets the index, so this is unreachable — and
    // if it were reached, staying armed asks again rather than ending a
    // Recording over an authoring slip.
    return [undefined, mutable] as const;
  }
  {
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
  }
};

/** Hover is the element the author picked while hover capture was armed. */
const pickHover = (
  mutable: RecordingState,
  target: Target,
  page: number
): readonly [undefined, RecordingState] => {
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
      lastActionAt: new Map(mutable.lastActionAt).set(page, Date.now()),
      pendingNavigation: withoutPage(mutable.pendingNavigation, page),
      revision: mutable.revision + 1,
      steps: [...mutable.steps, hover],
    },
  ] as const;
};

/**
 * What an armed picking mode does with the next action.
 *
 * `undefined` means this is not a pick to consume — either nothing is armed,
 * or the armed mode records the action itself as a Pre-step.
 */
const reducePick = (
  mutable: RecordingState,
  target: Target | undefined,
  page: number
): readonly [undefined, RecordingState] | undefined => {
  if (mutable.captureMode === "ordinary") {
    return undefined;
  }
  if (target === undefined) {
    // While a pick is armed, an action with no element behind it — a scroll, a
    // Page-level keystroke — is not the author picking. Ignored, because
    // scrolling to reach the element you mean to pick must not end the
    // Recording.
    return [undefined, mutable] as const;
  }
  if (mutable.captureMode === "conditionPicker") {
    return pickPreStepCondition(mutable, target);
  }
  return mutable.captureMode === "hoverPicker"
    ? pickHover(mutable, target, page)
    : undefined;
};

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

    const failUnlocked = (failure: CaptureFailure) =>
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
          incompleteFailure: failure,
          phase: "incomplete",
          revision: current.revision + 1,
          targetStepId: undefined,
        });
      });

    const fail = (failure: CaptureFailure) =>
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
        yield* transitions.withPermit(failUnlocked(failure));
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
          // Only the pinned Page. A background Page refreshing itself is not
          // the author navigating away from what they paused on, and ending
          // the Recording over it would be a defect, not integrity.
          if (event.page !== PINNED_PAGE) {
            return [undefined, mutable] as const;
          }
          yield* mutable.stopCapture;
          return [
            undefined,
            {
              ...mutable,
              incompleteFailure: integrityLost(
                "The pinned tab navigated while capture was paused."
              ),
              phase: "incomplete" as const,
              revision: mutable.revision + 1,
            },
          ] as const;
        }
        const sanitized = yield* sanitizeUrl(event.url, mutable.variables);
        // A navigation a Step caused is that Step's consequence, not another
        // Step: replaying the click navigates again by itself.
        const causedByAction =
          mutable.pendingNavigation.has(event.page) ||
          Date.now() - (mutable.lastActionAt.get(event.page) ?? 0) <=
            ACTION_NAVIGATION_WINDOW_MS;
        if (causedByAction) {
          return [
            undefined,
            {
              ...mutable,
              pendingNavigation: withoutPage(
                mutable.pendingNavigation,
                event.page
              ),
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
          return [
            undefined,
            {
              ...mutable,
              pendingNavigation: withoutPage(
                mutable.pendingNavigation,
                event.page
              ),
            },
          ] as const;
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
            pendingNavigation: withoutPage(
              mutable.pendingNavigation,
              event.page
            ),
            revision: mutable.revision + 1,
            steps: [...mutable.steps, navigation],
            variables: sanitized.variables,
          },
        ] as const;
      });

    const capturePreStep = (
      mutable: RecordingState,
      target: Target,
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
        const placed =
          mutable.captureMode === "flowPreStep"
            ? { flowPreSteps: [...mutable.flowPreSteps, preStep] }
            : {
                steps: mutable.steps.map((recordedStep) =>
                  recordedStep.id === mutable.targetStepId
                    ? {
                        ...recordedStep,
                        preSteps: [...recordedStep.preSteps, preStep],
                      }
                    : recordedStep
                ),
              };
        const [, next] = advance(mutable, {
          ...placed,
          captureMode: "ordinary",
          targetPreStepIndex: undefined,
          targetStepId: undefined,
          variables,
        });
        return [undefined, next] as const;
      });

    // `unsupported` never arrives here: the ordered handler turns a page
    // giving up into a failure before any reduction runs.
    const captureAction = (
      event: ReducibleCaptureEvent
    ): Effect.Effect<void, BrowserRpcErrorType> =>
      mutate((state) =>
        Effect.gen(function* appendCapturedAction() {
          const mutable = yield* requireMutable(state);
          if (event.type === "beforeUnload") {
            return [
              undefined,
              {
                ...mutable,
                pendingNavigation: new Set(mutable.pendingNavigation).add(
                  event.page
                ),
              },
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

          const target = capturedTarget(action);
          const picked = reducePick(mutable, target, page);
          if (picked !== undefined) {
            return picked;
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
          if (mutable.captureMode !== "ordinary" && target !== undefined) {
            return yield* capturePreStep(
              mutable,
              target,
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
            lastActionAt: new Map(mutable.lastActionAt).set(page, Date.now()),
            pendingNavigation: withoutPage(mutable.pendingNavigation, page),
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

    const startCapture = (sessionId: SessionId, tabId?: BrowserTabId) =>
      capture.start({
        onEvent: captureAction,
        onFailure: fail,
        sessionId,
        tabId,
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
              incompleteFailure: undefined,
              initialUrl: sanitized.url,
              lastActionAt: new Map(),
              pendingNavigation: new Set(),
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
            if (current.incompleteFailure?.kind !== "connectionLost") {
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
            const handle = yield* startCapture(
              current.sessionId,
              current.tabId
            );
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
              incompleteFailure: undefined,
              pendingNavigation: new Set(),
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
            return advance(mutable, { steps });
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
            return advance(mutable, {
              flowPreSteps: mutable.flowPreSteps.map((preStep) =>
                renamePreStepVariable(preStep, from, name)
              ),
              initialUrl: replaceVariableReference(
                mutable.initialUrl,
                from,
                name
              ),
              steps: mutable.steps.map((recorded) => ({
                ...recorded,
                ...(recorded.variable === from ? { variable: name } : {}),
                preSteps: recorded.preSteps.map((preStep) =>
                  renamePreStepVariable(preStep, from, name)
                ),
                step: renameStepValue(recorded.step, from, name),
              })),
            });
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
            return advance(mutable, {
              deletedStep: { index, step },
              steps: mutable.steps.filter(({ id }) => id !== stepId),
            });
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
            return advance(mutable, { deletedStep: undefined, steps });
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
