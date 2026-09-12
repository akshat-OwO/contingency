import { Effect, Schema } from "effect";

import { BrowserIdentity, UserAgentProfileId } from "./browser-identity.ts";
import { optionalNullable } from "./optional-field.ts";
import { Viewport } from "./viewport.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * A named value a Flow or Agent Flow declares but does not contain. `secret`
 * marks sensitive values; `runtime` marks values supplied when running.
 * The two are independent:
 * a 2FA code is both, a target environment URL is neither.
 */
export const Variable = Schema.Struct({
  name: nonEmptyString,
  runtime: Schema.Boolean,
  secret: Schema.Boolean,
});
export type Variable = typeof Variable.Type;

/**
 * The two supported answers about a website permission. Chromium's own
 * `prompt` is absent deliberately: the native bubble sits outside the streamed
 * page, so it is neither operable in the streamed browser nor reproducible in a Run
 * ([ADR 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const PermissionState = Schema.Literals(["granted", "denied"]);
export type PermissionState = typeof PermissionState.Type;

/**
 * One explicit website permission decision and where it applies. Absent
 * `origin` means the decision is context-wide; an origin narrows it to that
 * site. Flows written before decisions were explicit list grants only, so a
 * missing `state` decodes as `granted` rather than as an absent answer.
 */
export const PermissionDecision = Schema.Struct({
  origin: optionalNullable(nonEmptyString),
  /** The engine's permission name, e.g. `geolocation`. */
  permission: nonEmptyString,
  state: PermissionState.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("granted" as const))
  ),
});
export type PermissionDecision = typeof PermissionDecision.Type;

const decisionScope = (decision: PermissionDecision): string =>
  decision.origin ?? "*";

/**
 * Reject decision sets no browser could reproduce. One scope saying both
 * `granted` and `denied` about a permission has no answer, and Chromium's
 * context-wide grant cannot be narrowed back down for a single origin, so a
 * context-wide grant beside an origin denial would silently grant.
 */
const coherentPermissionDecisions = Schema.makeFilter<
  readonly PermissionDecision[]
>((decisions) => {
  const issues: { readonly issue: string; readonly path: readonly number[] }[] =
    [];
  const seen = new Map<string, PermissionState>();
  for (const [index, decision] of decisions.entries()) {
    const key = `${decision.permission}@${decisionScope(decision)}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== decision.state) {
      issues.push({
        issue:
          `The ${decision.permission} permission is both granted and denied ` +
          `for ${decision.origin ?? "every origin"}. Declare one decision per scope.`,
        path: [index],
      });
    }
    seen.set(key, decision.state);
  }
  for (const [index, decision] of decisions.entries()) {
    if (decision.origin === undefined || decision.state !== "denied") {
      continue;
    }
    const grantedEverywhere = decisions.some(
      (other) =>
        other.origin === undefined &&
        other.permission === decision.permission &&
        other.state === "granted"
    );
    if (grantedEverywhere) {
      issues.push({
        issue:
          `The ${decision.permission} permission is granted to every origin, ` +
          `so it cannot also be denied to ${decision.origin}. Grant it to the ` +
          "origins that may have it instead.",
        path: [index],
      });
    }
  }
  return issues;
});

/**
 * A whole set of permission decisions, coherent as a set. Browser sessions,
 * RPC inputs, Flows, and Agent Flows share this validation.
 */
export const PermissionDecisions = Schema.Array(PermissionDecision).check(
  coherentPermissionDecisions
);
export type PermissionDecisions = typeof PermissionDecisions.Type;

export const Geolocation = Schema.Struct({
  accuracy: optionalNullable(Schema.Finite),
  latitude: Schema.Finite.check(
    Schema.isBetween({ maximum: 90, minimum: -90 })
  ),
  longitude: Schema.Finite.check(
    Schema.isBetween({ maximum: 180, minimum: -180 })
  ),
});
export type Geolocation = typeof Geolocation.Type;

/**
 * The device and environment characteristics a Flow declares and every Run
 * reproduces ([ADR 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 * Emulated geolocation is the location a site receives when it asks for the
 * current position. Fields the Flow does not declare stay at their defaults;
 * `offline` and extra HTTP headers are deferred.
 */
export const Emulation = Schema.Struct({
  /**
   * The concrete browser the Emulation presents, applied identically by the Workspace
   * and every Run. It supersedes `userAgent`, which stays for Flows written
   * before an identity was concrete and for custom strings that declare
   * nothing further.
   */
  browser: optionalNullable(BrowserIdentity),
  colorScheme: optionalNullable(Schema.Literals(["light", "dark"])),
  geolocation: optionalNullable(Geolocation),
  locale: optionalNullable(nonEmptyString),
  permissions: optionalNullable(
    PermissionDecisions.check(Schema.isMinLength(1))
  ),
  timezoneId: optionalNullable(nonEmptyString),
  userAgent: optionalNullable(nonEmptyString),
  viewport: optionalNullable(Viewport),
});
export type Emulation = typeof Emulation.Type;

/**
 * One whole Emulation composed but not yet applied to any session: the browser
 * identity, its viewport, and the environment around it as a single value. It
 * travels with the first navigation so the session's first request and document
 * already carry it, rather than being patched in afterwards ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const DraftEmulation = Schema.Struct({
  colorScheme: optionalNullable(Schema.Literals(["light", "dark"])),
  geolocation: optionalNullable(Geolocation),
  locale: optionalNullable(nonEmptyString),
  permissions: PermissionDecisions,
  timezoneId: optionalNullable(nonEmptyString),
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
});
export type DraftEmulation = typeof DraftEmulation.Type;
