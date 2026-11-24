import { Schema } from "effect";

/**
 * Six Crockford base32 characters that name one failure whose cause stays in
 * the server's Diagnostic Log
 * ([ADR 0089](../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 */
export const FailureReference = Schema.String.check(
  Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{6}$/u)
);
export type FailureReference = typeof FailureReference.Type;

export const FailureDetailGet = Schema.Struct({
  failureReference: FailureReference,
});

/**
 * The recorded cause, for the Workspace only. It is null unless the server
 * logs at debug and still holds the cause.
 */
export const FailureDetailResult = Schema.Struct({
  detail: Schema.NullOr(Schema.String),
});
