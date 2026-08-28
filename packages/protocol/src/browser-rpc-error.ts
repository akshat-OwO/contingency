import { Schema } from "effect";

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
  ]),
  message: Schema.String,
});

export type BrowserRpcError = typeof BrowserRpcError.Type;

export const makeBrowserRpcError = (
  code: BrowserRpcError["code"],
  message: string
): BrowserRpcError => ({ _tag: "BrowserRpcError", code, message });

export const isBrowserRpcError = (value: unknown): value is BrowserRpcError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "BrowserRpcError";
