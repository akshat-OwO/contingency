import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

const EMULATION_BEACON = "/emulation-beacon";

/** What the fixture reported about itself, decoded from the beacon it sent. */
const beaconReports = (requests: readonly string[]) =>
  requests
    .filter((request) => request.startsWith(`${EMULATION_BEACON}?`))
    .map(
      (request) =>
        Object.fromEntries(
          new URLSearchParams(request.split("?")[1] ?? "")
        ) as Record<string, string>
    );

/**
 * A Run reproduces the Emulation its Flow declares. Every claim here is read
 * off what the page actually received through the browser's own APIs — the
 * geolocation answer, `Intl`'s timezone and locale, the media query, the
 * viewport — because an option set on a context is not evidence a site saw it.
 */
it.live("runs at the Flow's declared Emulation", () =>
  Effect.gen(function* replayDeclaredEmulation() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("emulation.html") }]),
      emulation: {
        colorScheme: "dark",
        geolocation: {
          accuracy: 30,
          latitude: 52.52,
          longitude: 13.405,
        },
        locale: "de-DE",
        permissions: [{ permission: "geolocation" }],
        timezoneId: "Europe/Berlin",
        viewport: { deviceScaleFactor: 1, height: 760, width: 1180 },
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({
      dark: "1",
      height: "760",
      latitude: "52.52",
      longitude: "13.405",
      timezone: "Europe/Berlin",
      width: "1180",
    });
    // `Intl` resolves the emulated locale, not the machine's.
    expect(reports[0]?.["locale"]).toBe("de-DE");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * The location is real for a site because the permission was granted, not
 * merely overridden: without the grant, the same coordinates stay out of the
 * site's reach — which is exactly what distinguishes this from the old
 * session-scoped override.
 */
it.live("withholds emulated location from a site that cannot have it", () =>
  Effect.gen(function* withholdEmulatedLocation() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("emulation.html") }]),
      emulation: {
        geolocation: {
          accuracy: 30,
          latitude: 52.52,
          longitude: 13.405,
        },
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({ denied: "1" });
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
