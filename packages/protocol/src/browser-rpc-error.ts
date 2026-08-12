import { Schema } from "effect";

export const BrowserRpcError = Schema.TaggedStruct("BrowserRpcError", {
  code: Schema.Literals([
    "invalid_session",
    "invalid_url",
    "session_not_found",
    "agent_browser_failed",
    "stream_failed",
    "recording_conflict",
    "recording_invalid",
    "recording_incomplete",
    "recording_unavailable",
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
