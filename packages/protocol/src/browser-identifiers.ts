import { Schema } from "effect";

const sessionIdPattern = /^create-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const SessionId = Schema.String.check(
  Schema.isPattern(sessionIdPattern)
).pipe(Schema.brand("@contingency/SessionId"));
export type SessionId = typeof SessionId.Type;

export const BrowserTabId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("@contingency/BrowserTabId")
);
export type BrowserTabId = typeof BrowserTabId.Type;
