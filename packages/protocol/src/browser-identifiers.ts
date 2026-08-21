import { Schema } from "effect";

/**
 * `create-` sessions author a Recording in Create View. `run-` sessions execute
 * a Flow in the Runner: headless, non-streaming, no recorder sidecar. The
 * prefix keeps the two distinguishable wherever a session name is read.
 */
export const sessionPrefixes = ["create-", "run-"] as const;
export type SessionPrefix = (typeof sessionPrefixes)[number];

const sessionIdPattern = /^(?:create|run)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const SessionId = Schema.String.check(
  Schema.isPattern(sessionIdPattern)
).pipe(Schema.brand("@contingency/SessionId"));
export type SessionId = typeof SessionId.Type;

export const BrowserTabId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("@contingency/BrowserTabId")
);
export type BrowserTabId = typeof BrowserTabId.Type;
