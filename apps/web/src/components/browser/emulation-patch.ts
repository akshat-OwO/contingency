import type { Geolocation, PermissionDecision } from "@contingency/protocol";

/**
 * One change to an Emulation: an absent field leaves that part unchanged and
 * `null` clears it, matching the wire contract so a draft and a live session's
 * own Emulation move the same way.
 */
export interface EmulationPatch {
  readonly colorScheme?: "light" | "dark" | null;
  readonly geolocation?: Geolocation | null;
  readonly locale?: string | null;
  readonly permissions?: readonly PermissionDecision[] | null;
  readonly timezoneId?: string | null;
}
