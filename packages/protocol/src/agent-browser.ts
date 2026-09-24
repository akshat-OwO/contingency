import { Schema } from "effect";

import {
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { optionalNullable } from "./optional-field.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * A short-lived handle to one element in a Browser Snapshot. It is minted by
 * Contingency, never by the external agent, and it stops resolving once the
 * Page navigates or the element leaves the document.
 */
export const AgentElementRef = Schema.String.check(
  Schema.isPattern(/^e[0-9]+$/u)
).pipe(Schema.brand("@contingency/AgentElementRef"));
export type AgentElementRef = typeof AgentElementRef.Type;

/** Which Browser Snapshot minted a set of element references. */
export const AgentSnapshotId = nonEmptyString.pipe(
  Schema.brand("@contingency/AgentSnapshotId")
);
export type AgentSnapshotId = typeof AgentSnapshotId.Type;

/**
 * One line of a Browser Snapshot: an accessible role and name, the reference
 * an action names it by, and its depth in the accessibility tree. The tree is
 * flattened rather than nested so the whole observation stays compact and
 * decodes without a recursive schema.
 *
 * `clickable` marks an element the Page treats as a control without saying so
 * in its markup — the unlabelled `div` rows a single-page application builds
 * its menus and result lists from. Their handlers are attached in script, so
 * neither a role nor an `onclick` attribute reveals them.
 * `context` names the nearest repeated item containing a control, so two
 * buttons with the same name can be associated with different products.
 */
export const AgentSnapshotNode = Schema.Struct({
  checked: optionalNullable(Schema.Boolean),
  clickable: optionalNullable(Schema.Boolean),
  context: optionalNullable(Schema.String),
  depth: Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 0 })),
  disabled: optionalNullable(Schema.Boolean),
  name: Schema.String,
  ref: AgentElementRef,
  role: nonEmptyString,
  value: optionalNullable(Schema.String),
  valueWithheld: optionalNullable(Schema.Boolean),
});
export type AgentSnapshotNode = typeof AgentSnapshotNode.Type;

/** What a Page was still doing when a Browser Snapshot stopped waiting. */
export const AgentPageActivity = Schema.Literals(["network", "dom"]);
export type AgentPageActivity = typeof AgentPageActivity.Type;

/**
 * Whether the Page went quiet before it was read. A read waits a bounded time
 * for requests to finish and the document to stop changing; a Page that is
 * still busy at the bound is read anyway and says what it was still doing, so
 * the agent reads it again instead of acting on a half-loaded state.
 */
export const AgentPageSettle = Schema.Struct({
  pending: Schema.Array(AgentPageActivity),
  settled: Schema.Boolean,
});
export type AgentPageSettle = typeof AgentPageSettle.Type;

/**
 * A compact accessibility representation of the current Page. It is
 * deliberately not a DOM dump: the external agent receives roles, names, and
 * references, and asks for a screenshot when that is not enough.
 */
export const AgentBrowserSnapshot = Schema.Struct({
  capturedAt: nonEmptyString,
  nodes: Schema.Array(AgentSnapshotNode),
  settle: optionalNullable(AgentPageSettle),
  snapshotId: AgentSnapshotId,
  title: Schema.String,
  url: Schema.String,
});
export type AgentBrowserSnapshot = typeof AgentBrowserSnapshot.Type;

/** A visual observation, kept separate from the Browser Snapshot. */
export const AgentScreenshot = Schema.Struct({
  capturedAt: nonEmptyString,
  encoding: Schema.Literal("base64"),
  format: Schema.Literal("png"),
  image: nonEmptyString,
  url: Schema.String,
});
export type AgentScreenshot = typeof AgentScreenshot.Type;

/**
 * Where one deliberate capture landed on this machine. The bytes stay in a
 * local file the agent opens with its own file tools, because a full-density
 * mobile screenshot is around a megabyte of base64 and no agent can read a
 * tool result that size ([ADR 0040](../../../docs/adr/0040-a-screenshot-arrives-as-a-local-file.md)).
 */
export const AgentScreenshotFile = Schema.Struct({
  bytes: Schema.Number.check(Schema.isGreaterThan(0)),
  capturedAt: nonEmptyString,
  format: Schema.Literal("png"),
  path: nonEmptyString,
  url: Schema.String,
});
export type AgentScreenshotFile = typeof AgentScreenshotFile.Type;

const withRef = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ref: AgentElementRef, ...fields });

export const AgentNavigateAction = Schema.Struct({
  type: Schema.Literal("navigate"),
  url: nonEmptyString,
});
export type AgentNavigateAction = typeof AgentNavigateAction.Type;
export const AgentHistoryAction = Schema.Struct({
  action: Schema.Literals(["back", "forward", "reload"]),
  type: Schema.Literal("history"),
});
export type AgentHistoryAction = typeof AgentHistoryAction.Type;
export const AgentClickAction = withRef({ type: Schema.Literal("click") });
export const AgentHoverAction = withRef({ type: Schema.Literal("hover") });
export const AgentFillAction = withRef({
  text: Schema.String,
  type: Schema.Literal("fill"),
});
export const AgentSelectAction = withRef({
  type: Schema.Literal("select"),
  values: Schema.Array(Schema.String),
});
export const AgentPressAction = Schema.Struct({
  key: nonEmptyString,
  ref: optionalNullable(AgentElementRef),
  type: Schema.Literal("press"),
});
export const AgentScrollAction = Schema.Struct({
  deltaX: Schema.Finite,
  deltaY: Schema.Finite,
  ref: optionalNullable(AgentElementRef),
  type: Schema.Literal("scroll"),
});
/**
 * Wait until the Page says something. The phrase is matched against the
 * accessible name a Browser Snapshot reports, which for plain prose is its
 * rendered text and for a labelled control is the name the timeline calls it
 * by. A done-when line copied out of the timeline therefore waits for the
 * element the timeline named, rather than timing out on a header whose
 * visible text and accessible name differ.
 */
export const AgentWaitForTextAction = Schema.Struct({
  text: nonEmptyString,
  timeoutMs: optionalNullable(
    Schema.Int.check(Schema.isBetween({ maximum: 60_000, minimum: 1 }))
  ),
  type: Schema.Literal("wait_for_text"),
});

/**
 * Everything the agent may ask the browser to do. The Runner checks authority
 * before dispatch. Playwright, CDP, and raw evaluation stay private
 * to Contingency ([ADR 0026](../../../docs/adr/0026-external-agents-control-agent-flows-through-mcp.md)).
 */
export const AgentBrowserAction = Schema.Union([
  AgentNavigateAction,
  AgentHistoryAction,
  AgentClickAction,
  AgentHoverAction,
  AgentFillAction,
  AgentSelectAction,
  AgentPressAction,
  AgentScrollAction,
  AgentWaitForTextAction,
]);
export type AgentBrowserAction = typeof AgentBrowserAction.Type;

export const AgentActionIntent = Schema.Struct({
  irreversible: optionalNullable(Schema.Boolean),
  objective: optionalNullable(nonEmptyString),
  objectiveKind: optionalNullable(Schema.Literals(["active-step", "new"])),
});
export type AgentActionIntent = typeof AgentActionIntent.Type;

export const AgentExecutionBoundary = Schema.Struct({
  action: AgentBrowserAction,
  description: nonEmptyString,
  id: nonEmptyString,
  operationId: nonEmptyString,
  reason: Schema.Literals(["domain", "objective", "confirmation"]),
  requested: nonEmptyString,
});
export type AgentExecutionBoundary = typeof AgentExecutionBoundary.Type;

export const AgentActionOutcome = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "refused",
]);
export type AgentActionOutcome = typeof AgentActionOutcome.Type;

/** One way an action can be seen to have changed the Page. */
export const AgentActionSignal = Schema.Literals([
  "url",
  "page",
  "dom",
  "focus",
  "value",
  "scroll",
]);
export type AgentActionSignal = typeof AgentActionSignal.Type;

/**
 * What an action was seen to change, separate from its outcome. `completed`
 * says the browser performed the action; `observed` says the Page reacted, by
 * the signals listed, and `none` says it did not within the settle window.
 */
export const AgentActionEffect = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("observed"),
    signals: Schema.NonEmptyArray(AgentActionSignal),
  }),
]);
export type AgentActionEffect = typeof AgentActionEffect.Type;

/**
 * One attempt in the action timeline. `dispatched` records that the browser
 * had already been asked to perform the action, so a Takeover that interrupts
 * it cannot claim the effect did not happen. `effect` is absent when nothing
 * could be observed, such as for a wait or an action that never ran.
 */
export const AgentTimelineEntry = Schema.Struct({
  actor: AgentSessionController,
  at: nonEmptyString,
  description: nonEmptyString,
  detail: optionalNullable(Schema.String),
  dispatched: Schema.Boolean,
  effect: optionalNullable(AgentActionEffect),
  id: nonEmptyString,
  outcome: AgentActionOutcome,
});
export type AgentTimelineEntry = typeof AgentTimelineEntry.Type;

export const AgentActionResult = Schema.Struct({
  entry: AgentTimelineEntry,
  intervention: optionalNullable(AgentExecutionBoundary),
  snapshot: AgentBrowserSnapshot,
  url: Schema.String,
});
export type AgentActionResult = typeof AgentActionResult.Type;

export const AgentBrowserObserve = Schema.Struct({
  sessionId: AgentSessionId,
});
export type AgentBrowserObserve = typeof AgentBrowserObserve.Type;

export const AgentBrowserAct = Schema.Struct({
  action: AgentBrowserAction,
  intent: optionalNullable(AgentActionIntent),
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentBrowserAct = typeof AgentBrowserAct.Type;

/**
 * The acted-on control as the capture-time Browser Snapshot saw it. Actions
 * name elements by reference, and a reference names nothing outside the
 * Snapshot that minted it, so the role and accessible name travel with the
 * description instead.
 */
export interface AgentActionSubject {
  readonly name: string;
  readonly role: string;
}

/**
 * What is known about an attempt beyond the action itself: the agent's own
 * one-line objective, and the control the reference resolved to when the
 * action was dispatched.
 */
export interface AgentActionContext {
  readonly objective?: string | undefined;
  readonly subject?: AgentActionSubject | undefined;
}

/** Keep one timeline line readable when a control carries a whole paragraph. */
const SUBJECT_NAME_LIMIT = 60;

const truncate = (value: string): string =>
  value.length <= SUBJECT_NAME_LIMIT
    ? value
    : `${value.slice(0, SUBJECT_NAME_LIMIT - 1).trimEnd()}\u2026`;

/**
 * Redaction placeholders are already their own sentence — quoting them reads
 * as though the literal text `[sensitive input]` was typed into the field.
 */
const isPlaceholder = (value: string): boolean =>
  value.startsWith("[") && value.endsWith("]");

const quoted = (value: string): string =>
  isPlaceholder(value) ? value : `"${truncate(value)}"`;

/**
 * Whether a captured value stands in for one the record must not carry: a
 * Variable reference such as `{{ACCOUNT_ID}}`, or a redaction placeholder such
 * as `[sensitive input]`. A reader that sees one of these knows the control
 * held something it is not being shown, which an empty string could never be
 * told apart from an empty field.
 */
export const isWithheldValue = (value: string): boolean =>
  isPlaceholder(value) || (value.startsWith("{{") && value.endsWith("}}"));

/**
 * How one control reads on its own: its role and accessible name. Exported for
 * the paths that phrase an action by hand rather than through
 * `describeAgentAction`, so every surface names a control the same way.
 */
export const describeActionSubject = (subject: AgentActionSubject): string => {
  const name = subject.name.trim();
  return name.length === 0 ? subject.role : `${subject.role} ${quoted(name)}`;
};

/** How the acted-on control reads: its role and accessible name, else its ref. */
const describeSubject = (
  ref: string,
  subject: AgentActionSubject | undefined
): string => (subject === undefined ? ref : describeActionSubject(subject));

/**
 * How an action reads in the timeline and in Agent View. The raw reference
 * stays on the action payload as the join back to its Snapshot; this is the
 * label a person reads, so it prefers the agent's stated objective, then the
 * control's role and accessible name, and falls back to the reference only
 * when the Snapshot no longer describes it.
 */
export const describeAgentAction = (
  action: AgentBrowserAction,
  context: AgentActionContext = {}
): string => {
  const objective = context.objective?.trim();
  if (objective !== undefined && objective.length > 0) {
    return objective;
  }
  switch (action.type) {
    case "navigate": {
      return `Navigate to ${action.url}`;
    }
    case "history": {
      return action.action === "reload"
        ? "Reload the page"
        : `Go ${action.action}`;
    }
    case "click": {
      return `Click ${describeSubject(action.ref, context.subject)}`;
    }
    case "hover": {
      return `Hover ${describeSubject(action.ref, context.subject)}`;
    }
    case "fill": {
      return `Fill ${describeSubject(action.ref, context.subject)} with ${quoted(action.text)}`;
    }
    case "select": {
      return `Select ${action.values.map(quoted).join(", ")} in ${describeSubject(action.ref, context.subject)}`;
    }
    case "press": {
      return action.ref === undefined
        ? `Press ${action.key}`
        : `Press ${action.key} on ${describeSubject(action.ref, context.subject)}`;
    }
    case "scroll": {
      return action.ref === undefined
        ? `Scroll the page by ${action.deltaX}, ${action.deltaY}`
        : `Scroll ${describeSubject(action.ref, context.subject)} by ${action.deltaX}, ${action.deltaY}`;
    }
    case "wait_for_text": {
      return `Wait for "${action.text}"`;
    }
    default: {
      // A new action member fails to compile here rather than being described
      // as whichever branch happened to be last.
      throw new Error(`Unhandled agent action: ${JSON.stringify(action)}`);
    }
  }
};
