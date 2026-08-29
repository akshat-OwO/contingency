import type { Geolocation } from "@contingency/protocol";

/** The geolocation context option, or nothing when none is declared. */
const geolocationOption = (geolocation: Geolocation | undefined) =>
  geolocation === undefined
    ? {}
    : {
        geolocation: {
          ...(geolocation.accuracy === undefined
            ? {}
            : { accuracy: geolocation.accuracy }),
          latitude: geolocation.latitude,
          longitude: geolocation.longitude,
        },
      };

/**
 * The environment half of an Emulation — what a site senses about its place
 * and its moment — as browser context options. Create View's authoring session
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
  emulation:
    | {
        readonly colorScheme?: "light" | "dark" | undefined;
        readonly geolocation?: Geolocation | undefined;
        readonly locale?: string | undefined;
        readonly timezoneId?: string | undefined;
      }
    | undefined
): {
  colorScheme?: "light" | "dark";
  geolocation?: { accuracy?: number; latitude: number; longitude: number };
  locale?: string;
  timezoneId?: string;
} => ({
  ...(emulation?.colorScheme === undefined
    ? {}
    : { colorScheme: emulation.colorScheme }),
  ...geolocationOption(emulation?.geolocation),
  ...(emulation?.locale === undefined ? {} : { locale: emulation.locale }),
  ...(emulation?.timezoneId === undefined
    ? {}
    : { timezoneId: emulation.timezoneId }),
});
