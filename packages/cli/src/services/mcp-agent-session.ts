import {
  AGENT_ACTION_SEQUENCE_MAX,
  AgentActSequenceResult,
  AgentActionResult,
  AgentActionSnapshotFormat,
  AgentBrowserAct,
  AgentBrowserActSequence,
  AgentBrowserObserve,
  AgentBrowserSnapshot,
  AgentBrowserSnapshotRead,
  AgentScreenshotFile,
  AgentSessionClose,
  AgentSessionGet,
  AgentSessionHistoryGet,
  AgentSessionHistoryPage,
  AgentSessionStart,
  AgentSessionTakeover,
  AgentTeachingSetupHandoff,
  AgentSetupVariableRequest,
  AgentVariableEnter,
  compactAgentSession,
  optionalNullable,
} from "@contingency/protocol";
import type {
  AgentActionSignal,
  AgentSequenceStopReason,
  AgentSessionId,
} from "@contingency/protocol";
import { Effect, Layer, Result, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import type { AgentSessionError } from "./agent-session.ts";
import { AgentSession } from "./agent-session.ts";
import {
  diffSnapshotLines,
  isWholePage,
  snapshotLines,
  textSnapshot,
} from "./agent-snapshot-text.ts";
import {
  SessionResult,
  UnpublishedSession,
  encodeUnpublishedSession,
  inView,
  sessionViewParameter,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

type BrowserSnapshot = typeof AgentBrowserSnapshot.Type;

/** How many sessions keep a diff base. A closed session's base ages out. */
const BASELINE_LIMIT = 64;

/**
 * The last whole-page text Snapshot each session was handed, which an action
 * answering in `diff` compares against. It is replaced by every whole-page
 * read, whatever its format, so a diff is always relative to the newest full
 * picture the agent holds of that Page.
 */
const makeSnapshotBaselines = () => {
  const baselines = new Map<
    AgentSessionId,
    { readonly text: string; readonly url: string }
  >();
  const remember = (sessionId: AgentSessionId, snapshot: BrowserSnapshot) => {
    if (!isWholePage(snapshot)) {
      return;
    }
    baselines.delete(sessionId);
    baselines.set(sessionId, {
      text: snapshotLines(snapshot),
      url: snapshot.url,
    });
    while (baselines.size > BASELINE_LIMIT) {
      const oldest = baselines.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      baselines.delete(oldest);
    }
  };
  /** Hand a Snapshot over in the format the agent asked for. */
  const present = (
    sessionId: AgentSessionId,
    snapshot: BrowserSnapshot,
    format: AgentActionSnapshotFormat
  ): BrowserSnapshot => {
    const base = baselines.get(sessionId);
    remember(sessionId, snapshot);
    if (format === "structured") {
      return snapshot;
    }
    // A diff against another document, or against a read that saw only part
    // of this one, would describe changes that did not happen.
    if (
      format === "diff" &&
      base !== undefined &&
      base.url === snapshot.url &&
      isWholePage(snapshot)
    ) {
      return {
        ...snapshot,
        nodes: [],
        text: diffSnapshotLines(base.text, snapshotLines(snapshot)),
      };
    }
    return textSnapshot(snapshot);
  };
  return { present };
};

const actionSnapshotFormat = optionalNullable(AgentActionSnapshotFormat);

const AgentBrowserActSequenceParameters = Schema.Struct({
  ...AgentBrowserActSequence.fields,
  format: actionSnapshotFormat,
});

const AgentSessionStartParameters = Schema.Struct({
  activity: AgentSessionStart.fields.activity,
  clientName: AgentSessionStart.fields.clientName,
  clientVersion: AgentSessionStart.fields.clientVersion,
  emulation: AgentSessionStart.fields.emulation,
  name: AgentSessionStart.fields.name,
  operationId: AgentSessionStart.fields.operationId,
  url: AgentSessionStart.fields.url,
  view: sessionViewParameter,
  viewport: AgentSessionStart.fields.viewport,
});

const AgentSessionGetParameters = Schema.Struct({
  sessionId: AgentSessionGet.fields.sessionId,
  view: sessionViewParameter,
});

const AgentSessionCloseParameters = Schema.Struct({
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
  view: sessionViewParameter,
});

/**
 * The failure an MCP client actually reads. It is an Error subclass on purpose:
 * the MCP server surfaces `error.message` only for declared failures that are
 * `instanceof Error`, and reports every other shape as "an internal server
 * error" — which tells the agent nothing about a stale reference or a timeout.
 */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentSessionFailure extends Schema.Error<AgentSessionFailure>(
  "AgentSessionFailure"
)({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (cause: AgentSessionError) =>
  new AgentSessionFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

const AgentBrowserObserveParameters = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
});

const AgentBrowserActParameters = Schema.Struct({
  action: AgentBrowserAct.fields.action,
  format: actionSnapshotFormat,
  intent: AgentBrowserAct.fields.intent,
  operationId: AgentBrowserAct.fields.operationId,
  sessionId: AgentBrowserAct.fields.sessionId,
});

const AgentTakeoverParameters = Schema.Struct({
  operationId: AgentSessionTakeover.fields.operationId,
  reason: AgentSessionTakeover.fields.reason,
  sessionId: AgentSessionTakeover.fields.sessionId,
  view: sessionViewParameter,
});

const AgentTeachingSetupHandoffParameters = Schema.Struct({
  operationId: AgentTeachingSetupHandoff.fields.operationId,
  sessionId: AgentTeachingSetupHandoff.fields.sessionId,
  view: sessionViewParameter,
});

/** MCP tool names use underscores; dots break common clients such as Cursor. */
const AgentSessionsGetTool = readOnly(
  Tool.make("agent_sessions_get", {
    dependencies: [AgentSession],
    description:
      'List running Agent Sessions owned by this MCP process. Pass view:"compact" for decision-sized entries.',
    failure: AgentSessionFailure,
    parameters: Schema.Struct({ view: sessionViewParameter }),
    success: Schema.Struct({ sessions: Schema.Array(UnpublishedSession) }),
  })
);

const AgentSessionStartTool = Tool.make("agent_session_start", {
  dependencies: [AgentSession],
  description:
    "Start a process-owned Agent Session and return its loopback Workspace URL. A Teaching session you start opens in setup with you holding the browser: prepare prerequisites such as signing in or choosing a delivery location with agent_browser_act, then call agent_teaching_setup_handoff so the user can start recording. Nothing you do in setup is recorded. Pass `emulation` to run under a whole browser identity — a user agent profile such as chrome-iphone or safari-iphone, its viewport, and the environment around it — rather than a default desktop identity at `viewport`. For Teaching, `name` becomes the Flow Skill name: 1 to 128 characters of letters, numbers, spaces, dots, dashes, and underscores, starting with a letter or a number.",
  failure: AgentSessionFailure,
  parameters: AgentSessionStartParameters,
  success: SessionResult,
});

const AgentSessionGetTool = readOnly(
  Tool.make("agent_session_get", {
    dependencies: [AgentSession],
    description:
      'Read one Agent Session by id, including a ready Teaching recording after capture has stopped. Every tool that answers with a session accepts view:"compact": open Pending Decisions, Takeover, the newest attempt, Run lifecycle, assessment, and Variables, with older history counted rather than repeated. Page that history with agent_session_history_get.',
    failure: AgentSessionFailure,
    parameters: AgentSessionGetParameters,
    success: SessionResult,
  })
);

const AgentSessionHistoryGetTool = readOnly(
  Tool.make("agent_session_history_get", {
    dependencies: [AgentSession],
    description:
      "Page an Agent Session's retained timeline attempts or resolved decisions, newest first, at most 50 per page (default 20). Pass nextBefore from one page as before for the next older page; it is null at the oldest retained entry. A cursor that has aged out of the retained timeline is refused with agent_session_history_cursor_expired.",
    failure: AgentSessionFailure,
    parameters: AgentSessionHistoryGet,
    success: AgentSessionHistoryPage,
  })
);

const AgentSessionCloseTool = Tool.make("agent_session_close", {
  dependencies: [AgentSession],
  description:
    "Close an Agent Session and release its owned browser. For Teaching, this finalizes the local video and Trace so the Teaching Recording becomes ready to learn from.",
  failure: AgentSessionFailure,
  parameters: AgentSessionCloseParameters,
  success: SessionResult,
});

const AgentBrowserSnapshotTool = readOnly(
  Tool.make("agent_browser_snapshot", {
    dependencies: [AgentSession],
    description:
      'Read a bounded Browser Snapshot. The default text format answers one line per node in text, with nodes empty: indentation is nesting, then role, quoted name, and [state]. Only controls carry an @eN reference; text and landmarks have none. An element keeps its reference across reads until it leaves the document or the Page navigates. format:"structured" returns the node array instead. What the viewport shows is read first. coverage reports eligible nodes, scope, truncation, and nextCursor. Pass interactive:true to read only controls, urls:true to add link destinations, selector to scope to a CSS section before budgeting, or cursor to continue the same stable observation. A changed Page expires continuation: take a fresh snapshot. settle describes readiness, not coverage. Read again after effect none, an unsettled action snapshot, a stale ref, or a change you did not cause.',
    failure: AgentSessionFailure,
    parameters: AgentBrowserSnapshotRead,
    success: AgentBrowserSnapshot,
  })
);

const AgentBrowserScreenshotTool = readOnly(
  Tool.make("agent_browser_screenshot", {
    dependencies: [AgentSession],
    description:
      "Capture a PNG screenshot of the Agent Session's Page when the accessibility representation is not enough. The answer is the local file the capture landed in, not the image bytes: open that path with your own file tools. The file lives as long as the Agent Session does.",
    failure: AgentSessionFailure,
    parameters: AgentBrowserObserveParameters,
    success: AgentScreenshotFile,
  })
);

const AgentBrowserActTool = Tool.make("agent_browser_act", {
  dependencies: [AgentSession],
  description:
    'Perform one browser action during a Run, or while preparing the setup of a Teaching session you started. Teaching refuses this tool once you hand control to the user: the user demonstrates the journey and you observe it. The action contributes to the user-requested task, and intent.objective may describe it in your own words. Set intent.objectiveKind to "new" when starting an unrelated objective. Declare known irreversible or high-impact effects in intent.irreversible. Contingency enforces Domain Scope and requires user Confirmation for an irreversible action. An intervention means the action was refused; resolve its Pending Decision before retrying the exact operation id. A new operation id needs fresh confirmation. The result\'s Snapshot is read once the Page settles, up to two seconds, in the text format unless format says otherwise; format:"diff" answers only the lines that changed since your previous whole-page read of the same Page, and the full text when there is none, and entry.effect says what the action was seen to change: observed with its signals (url, page, dom, focus, value, scroll), or none. After effect none, or a Snapshot whose settle.settled is false, read the Page again with agent_browser_snapshot before repeating the action: it may still be reacting, and a repeat can act twice. Otherwise the returned Snapshot is current: reason from it without another read.',
  failure: AgentSessionFailure,
  parameters: AgentBrowserActParameters,
  success: AgentActionResult,
});

const AgentBrowserActSequenceTool = Tool.make("agent_browser_act_sequence", {
  dependencies: [AgentSession],
  description: `Perform up to ${AGENT_ACTION_SEQUENCE_MAX} browser actions in order, such as filling a known form, when each target is in the current Snapshot. Each action has its own operation id and intent and passes every check agent_browser_act applies. The sequence is not atomic. It stops at the first action that is refused or interrupted, needs a Pending Decision, fails, has effect none, leaves the Page unsettled, or navigates before the last action. stopped names that action and why, and earlier effects remain. The answer carries each attempt and one Snapshot read after the last action that ran, formatted as agent_browser_act formats it. Replaying the same operation ids replays completed attempts instead of repeating them. Do not continue past a stop without reading the Page.`,
  failure: AgentSessionFailure,
  parameters: AgentBrowserActSequenceParameters,
  success: AgentActSequenceResult,
});

const AgentTakeoverRequestTool = Tool.make("agent_session_takeover_request", {
  dependencies: [AgentSession],
  description:
    "Ask the user to take control of an Interactive Run. This pauses agent actions and answers immediately with the Workspace link; only the user can return control. Teaching has no Takeover: hand a prepared Teaching setup to the user with agent_teaching_setup_handoff.",
  failure: AgentSessionFailure,
  parameters: AgentTakeoverParameters,
  success: SessionResult,
});

const AgentTeachingSetupHandoffTool = Tool.make(
  "agent_teaching_setup_handoff",
  {
    dependencies: [AgentSession],
    description:
      "Hand an agent-prepared Teaching browser to the user once setup is done. The user then starts recording and demonstrates the journey; you cannot act in this Teaching session again. Retrying answers with the same user-held session.",
    failure: AgentSessionFailure,
    parameters: AgentTeachingSetupHandoffParameters,
    success: SessionResult,
  }
);

const AgentVariableEnterTool = Tool.make("agent_variable_enter", {
  dependencies: [AgentSession],
  description:
    "Enter a supplied private Variable into one element from the latest Browser Snapshot. The literal stays inside Contingency. During agent-held Teaching setup, request it with agent_teaching_setup_variable_request and omit flowSkillName. For a task Run, supply flowSkillName and name; request inputs with agent_run_variable_request and relay its decision. Dry Run secrets are supplied in Workspace. Setup access ends at handoff.",
  failure: AgentSessionFailure,
  parameters: Schema.Struct({
    flowSkillName: AgentVariableEnter.fields.flowSkillName,
    name: AgentVariableEnter.fields.name,
    operationId: AgentVariableEnter.fields.operationId,
    ref: AgentVariableEnter.fields.ref,
    sessionId: AgentVariableEnter.fields.sessionId,
  }),
  success: AgentActionResult,
});

const AgentSetupVariableRequestTool = Tool.make(
  "agent_teaching_setup_variable_request",
  {
    dependencies: [AgentSession],
    description:
      "Request a private Setup Variable by uppercase name and purpose while you hold Teaching setup. The user supplies or refuses it directly in Workspace; you never receive the literal. Set replace:true to invalidate the old usable value and request a fresh one, otherwise reuse an existing request or supplied value. Enter a supplied Variable with agent_variable_enter without flowSkillName. Handoff cancels requests and ends access. Setup inputs are never declared in the learned Flow Skill.",
    failure: AgentSessionFailure,
    parameters: Schema.Struct({
      ...AgentSetupVariableRequest.fields,
      view: sessionViewParameter,
    }),
    success: SessionResult,
  }
);

/** Why a sequence must stop after an attempt, or `null` to continue. */
const sequenceStop = (
  result: AgentActionResult,
  last: boolean
): AgentSequenceStopReason | null => {
  if (result.intervention !== undefined) {
    return "intervention";
  }
  if (result.entry.outcome !== "completed") {
    return "not-completed";
  }
  if (result.entry.effect?.kind === "none") {
    return "no-effect";
  }
  if (result.snapshot.settle?.settled === false) {
    return "unsettled";
  }
  const signals: readonly AgentActionSignal[] =
    result.entry.effect?.kind === "observed" ? result.entry.effect.signals : [];
  // Navigation retires every element reference the later actions name.
  return !last && (signals.includes("url") || signals.includes("page"))
    ? "navigated"
    : null;
};

/**
 * The external agent's whole surface. Observation, Run action, and the
 * Takeover request are MCP tools and nothing else: Workspace's loopback RPC
 * exposes only what the user does, and during Teaching that is everything ([ADR 0026](../../../../docs/adr/0026-external-agents-control-agent-flows-through-mcp.md)).
 */
export const AgentSessionTools = withStrictParameters(
  Toolkit.make(
    AgentSessionsGetTool,
    AgentSessionStartTool,
    AgentSessionGetTool,
    AgentSessionHistoryGetTool,
    AgentSessionCloseTool,
    AgentBrowserSnapshotTool,
    AgentBrowserScreenshotTool,
    AgentBrowserActTool,
    AgentBrowserActSequenceTool,
    AgentTakeoverRequestTool,
    AgentTeachingSetupHandoffTool,
    AgentSetupVariableRequestTool,
    AgentVariableEnterTool
  )
);

/**
 * The handlers behind those tools, shared by MCP and its tests. Every call the
 * agent makes on a session counts as agent activity, which is what Workspace
 * reads to say how long a Run's agent has been idle.
 */
export const AgentSessionToolHandlersLive = AgentSessionTools.toLayer(
  Effect.sync(() => {
    const baselines = makeSnapshotBaselines();
    return {
      agent_browser_act: (params) =>
        Effect.gen(function* actInAgentSession() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          const result = yield* service
            .act(
              params.sessionId,
              params.action,
              params.operationId,
              params.intent
            )
            .pipe(Effect.mapError(failure));
          return {
            ...result,
            snapshot: baselines.present(
              params.sessionId,
              result.snapshot,
              params.format ?? "text"
            ),
          };
        }),
      agent_browser_act_sequence: (params) =>
        Effect.gen(function* actInSequence() {
          const service = yield* AgentSession;
          const operationIds = new Set(
            params.actions.map((step) => step.operationId)
          );
          if (operationIds.size !== params.actions.length) {
            return yield* Effect.fail(
              new AgentSessionFailure({
                code: "agent_session_invalid",
                message:
                  "Each action in a sequence needs its own operation id. (agent_session_invalid)",
              })
            );
          }
          yield* service.noteAgentActivity(params.sessionId);
          const actions: AgentActSequenceResult["actions"][number][] = [];
          let lastResult: AgentActionResult | null = null;
          let stopped: AgentActSequenceResult["stopped"] = null;
          for (const [index, step] of params.actions.entries()) {
            const attempt = yield* Effect.result(
              service.act(
                params.sessionId,
                step.action,
                step.operationId,
                step.intent
              )
            );
            if (Result.isFailure(attempt)) {
              stopped = {
                code: attempt.failure.code,
                index,
                message: attempt.failure.message,
                reason: "error",
              };
              break;
            }
            const result = attempt.success;
            lastResult = result;
            actions.push({
              entry: result.entry,
              intervention: result.intervention ?? null,
              operationId: step.operationId,
            });
            const reason = sequenceStop(
              result,
              index === params.actions.length - 1
            );
            if (reason !== null) {
              stopped = { code: null, index, message: null, reason };
              break;
            }
          }
          return {
            actions,
            snapshot:
              lastResult === null
                ? null
                : baselines.present(
                    params.sessionId,
                    lastResult.snapshot,
                    params.format ?? "text"
                  ),
            stopped,
            url: lastResult?.url ?? null,
          };
        }),
      agent_browser_screenshot: (params) =>
        Effect.gen(function* screenshotAgentSession() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .screenshot(params.sessionId)
            .pipe(Effect.mapError(failure));
        }),
      agent_browser_snapshot: (params) =>
        Effect.gen(function* snapshotAgentSession() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .snapshot(params.sessionId, {
              cursor: params.cursor,
              interactive: params.interactive,
              selector: params.selector,
              urls: params.urls,
            })
            .pipe(
              Effect.mapError(failure),
              Effect.map((snapshot) =>
                baselines.present(
                  params.sessionId,
                  snapshot,
                  params.format ?? "text"
                )
              )
            );
        }),
      agent_session_close: (params) =>
        Effect.gen(function* closeAgentSession() {
          const service = yield* AgentSession;
          return yield* service
            .close(params.sessionId, params.operationId)
            .pipe(Effect.mapError(failure), inView(params.view));
        }),
      agent_session_get: (params) =>
        Effect.gen(function* getAgentSession() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .get(params.sessionId)
            .pipe(Effect.mapError(failure), inView(params.view));
        }),
      agent_session_history_get: (params) =>
        Effect.gen(function* pageAgentSessionHistory() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          const snapshot = yield* service
            .get(params.sessionId)
            .pipe(Effect.mapError(failure));
          const limit = params.limit ?? 20;
          const page = <T>(
            entries: readonly T[],
            idOf: (entry: T) => string
          ) => {
            const newestFirst = entries.toReversed();
            const cursor =
              params.before === undefined
                ? -1
                : newestFirst.findIndex(
                    (entry) => idOf(entry) === params.before
                  );
            if (params.before !== undefined && cursor === -1) {
              return Effect.fail(
                new AgentSessionFailure({
                  code: "agent_session_history_cursor_expired",
                  message:
                    "That entry is no longer retained. Start again without before. (agent_session_history_cursor_expired)",
                })
              );
            }
            const start = cursor + 1;
            const items = newestFirst.slice(start, start + limit);
            const oldest = items.at(-1);
            return Effect.succeed({
              items,
              nextBefore:
                oldest === undefined || start + limit >= newestFirst.length
                  ? null
                  : idOf(oldest),
              total: entries.length,
            });
          };
          if (params.kind === "timeline") {
            const timeline = yield* page(
              snapshot.timeline,
              (entry) => entry.id
            );
            return {
              decisions: [],
              nextBefore: timeline.nextBefore,
              timeline: timeline.items,
              total: timeline.total,
            };
          }
          const decisions = yield* page(
            snapshot.decisionHistory,
            (entry) => entry.pendingDecisionId
          );
          return {
            decisions: decisions.items,
            nextBefore: decisions.nextBefore,
            timeline: [],
            total: decisions.total,
          };
        }),
      agent_session_start: ({ view, ...params }) =>
        Effect.gen(function* startAgentSession() {
          const service = yield* AgentSession;
          return yield* service
            .start({ ...params, openedBy: "agent" })
            .pipe(Effect.mapError(failure), inView(view));
        }),
      agent_session_takeover_request: (params) =>
        Effect.gen(function* requestAgentTakeover() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .requestTakeover(
              params.sessionId,
              params.reason,
              params.operationId
            )
            .pipe(Effect.mapError(failure), inView(params.view));
        }),
      agent_sessions_get: (params) =>
        Effect.gen(function* listAgentSessions() {
          const service = yield* AgentSession;
          const sessions = yield* service.list();
          return {
            // oxlint-disable-next-line unicorn/no-array-method-this-argument -- `Effect.forEach` is not an array method.
            sessions: yield* Effect.forEach(sessions, (session) =>
              encodeUnpublishedSession(
                params.view === "compact"
                  ? compactAgentSession(session)
                  : session
              )
            ),
          };
        }),
      agent_teaching_setup_handoff: (params) =>
        Effect.gen(function* handOffTeachingSetup() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .handOffTeachingSetup(params.sessionId, params.operationId)
            .pipe(Effect.mapError(failure), inView(params.view));
        }),
      agent_teaching_setup_variable_request: (params) =>
        Effect.gen(function* requestSetupVariable() {
          const service = yield* AgentSession;
          return yield* service
            .requestSetupVariable(params)
            .pipe(Effect.mapError(failure), inView(params.view));
        }),
      agent_variable_enter: (params) =>
        Effect.gen(function* enterSuppliedVariable() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          return yield* service
            .enterSuppliedVariable(
              params.sessionId,
              params.name,
              params.ref,
              params.operationId,
              params.flowSkillName
            )
            .pipe(Effect.mapError(failure));
        }),
    };
  })
);

/** MCP's typed tool surface over the process-owned Agent Session service. */
export const McpAgentSessionLayer = McpServer.toolkit(AgentSessionTools).pipe(
  Layer.provide(AgentSessionToolHandlersLive)
);
