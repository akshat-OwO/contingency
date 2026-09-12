import type { Geolocation } from "@contingency/protocol";

export interface EnvironmentContextOptions {
  readonly colorScheme?: "light" | "dark";
  readonly geolocation?: {
    readonly accuracy?: number;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly locale?: string;
  readonly timezoneId?: string;
}

export interface EnvironmentEmulation {
  readonly colorScheme?: "light" | "dark" | undefined;
  readonly geolocation?: Geolocation | undefined;
  readonly locale?: string | undefined;
  readonly timezoneId?: string | undefined;
}

/**
 * The environment half of an Emulation — what a site senses about its place
 * and its moment — as browser context options. A live browser session
 * and every Run translate it here, so a headless Run and the session the Flow
 * was authored in present the same environment ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 *
 * These belong to a context rather than to a Page: a locale or timezone
 * installed through CDP belongs to one renderer process, so the first
 * navigation — which usually swaps processes — would drop it, and the first
 * request's own `Accept-Language` would never carry it at all.
 */
export const environmentContextOptions = (
  emulation: EnvironmentEmulation | undefined
): EnvironmentContextOptions => {
  let options: EnvironmentContextOptions = {};
  if (emulation?.colorScheme !== undefined) {
    options = { ...options, colorScheme: emulation.colorScheme };
  }
  if (emulation?.geolocation !== undefined) {
    const { accuracy, latitude, longitude } = emulation.geolocation;
    const geolocation =
      accuracy === undefined
        ? { latitude, longitude }
        : { accuracy, latitude, longitude };
    options = { ...options, geolocation };
  }
  if (emulation?.locale !== undefined) {
    options = { ...options, locale: emulation.locale };
  }
  if (emulation?.timezoneId !== undefined) {
    options = { ...options, timezoneId: emulation.timezoneId };
  }
  return options;
};
