import { Schema } from "effect";

/**
 * Why a browser action failed, in words that never carry what was typed. A
 * sensitive control's failure keeps only this, so a caller can still tell a
 * target that went away from a value the page refused.
 */
export const BrowserFailureReason = Schema.Literals([
  // The control left the document or its reference went stale.
  "detached",
  // A split control has a different number of boxes than the value has
  // characters.
  "length_mismatch",
  // The browser did not finish the action within its bound.
  "timeout",
  // The controls did not end up holding the value that was entered.
  "value_mismatch",
]);

export type BrowserFailureReason = typeof BrowserFailureReason.Type;

export const BrowserRpcError = Schema.TaggedStruct("BrowserRpcError", {
  code: Schema.Literals([
    "invalid_session",
    "invalid_url",
    "session_not_found",
    "agent_browser_failed",
    // The page already received the input before the failure was detected, so
    // the attempt is not repeatable: a second selector would click twice.
    "input_already_dispatched",
    "stream_failed",
    "recording_conflict",
    "recording_invalid",
    "recording_incomplete",
    "recording_unavailable",
    // A Run is already in flight, or a Recording holds the browser. One Run at
    // a time is the Runner's own semaphore; this is the same rule answered
    // before a second one is asked for (ADR 0023).
    "run_conflict",
    // The request does not apply to the Run's current phase — answering a
    // Variable nothing is waiting on, for one.
    "run_invalid",
    // This process was opened without a Flow, so there is nothing to run.
    "run_unavailable",
    // Agent Sessions are process-owned coordination envelopes. These errors
    // are kept distinct from lower-level browser-session failures so an MCP
    // adapter cannot accidentally treat the URL selector as a browser handle.
    "agent_session_conflict",
    "agent_session_invalid",
    "agent_session_not_found",
    "agent_session_unavailable",
    // Teaching Recording lifecycle moved on, or another process owns the claim.
    "agent_teaching_conflict",
    // The Teaching Recording or its retained manifest no longer exists.
    "agent_teaching_not_found",
    // The Teaching request or learning claim is invalid.
    "agent_teaching_invalid",
    // Teaching storage could not complete an I/O operation or is unavailable.
    "agent_teaching_unavailable",
    // The element reference came from a Browser Snapshot the Page has since
    // navigated away from or mutated, so acting on it would act on nothing.
    "agent_element_stale",
    // The user holds the browser during Takeover, so agent action tools are
    // disabled until control is explicitly returned.
    "agent_control_unavailable",
    // Catalog Root failures the Workspace can act on: an unusable Catalog
    // Root, a conflicting write, or a missing Flow Skill.
    "agent_catalog_invalid",
    "agent_flow_conflict",
    "agent_flow_invalid",
    "agent_flow_not_found",
    // A persisted Run the read-only viewer could not read: absent, or written
    // by a version whose Run Summary this one cannot decode.
    "agent_run_invalid",
    "agent_run_not_found",
  ]),
  message: Schema.String,
  reason: Schema.optionalKey(BrowserFailureReason),
});

export type BrowserRpcError = typeof BrowserRpcError.Type;

export const makeBrowserRpcError = (
  code: BrowserRpcError["code"],
  message: string,
  reason?: BrowserFailureReason
): BrowserRpcError =>
  reason === undefined
    ? { _tag: "BrowserRpcError", code, message }
    : { _tag: "BrowserRpcError", code, message, reason };

export const isBrowserRpcError = (value: unknown): value is BrowserRpcError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "BrowserRpcError";
