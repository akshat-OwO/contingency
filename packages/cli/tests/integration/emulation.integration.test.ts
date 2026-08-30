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
        permissions: [{ permission: "geolocation", state: "granted" }],
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

/**
 * A denial is an answer the Flow carries, not the absence of one. The
 * coordinates stay installed, so what the site observes is refusal rather than
 * a missing override — the case an author writes deliberately to test how a
 * site behaves when location is refused ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
it.live("reproduces an explicit denial over installed coordinates", () =>
  Effect.gen(function* replayDeniedPermission() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("emulation.html") }]),
      emulation: {
        geolocation: { accuracy: 30, latitude: 52.52, longitude: 13.405 },
        permissions: [{ permission: "geolocation", state: "denied" }],
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    // `1` is `PERMISSION_DENIED`: the site was refused, not timed out, and no
    // prompt was ever shown for a headless Run to answer.
    expect(reports[0]).toMatchObject({ denied: "1" });
    expect(reports[0]?.["latitude"]).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * An origin narrows a decision. A context-wide denial with a grant for the one
 * site under test is the shape an author writes to keep a Flow's location
 * inside the site it audits.
 */
it.live("grants only the origin a decision names", () =>
  Effect.gen(function* replayOriginScopedGrant() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("emulation.html") }]),
      emulation: {
        geolocation: { accuracy: 30, latitude: 52.52, longitude: 13.405 },
        permissions: [
          { permission: "geolocation", state: "denied" },
          {
            origin: fixtures.origin,
            permission: "geolocation",
            state: "granted",
          },
        ],
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({
      latitude: "52.52",
      longitude: "13.405",
    });
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * Every other permission name travels the same road as geolocation: the
 * decision is what the browser applies, and a denial leaves the API refusing.
 */
it.live("reproduces decisions about other permission names", () =>
  Effect.gen(function* replayOtherPermissions() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("permissions.html") }]),
      emulation: {
        permissions: [
          { permission: "notifications", state: "granted" },
          { permission: "camera", state: "denied" },
        ],
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({
      camera: "denied",
      notifications: "granted",
    });
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * A context-wide grant and an origin-scoped one describe one site together.
 * Chromium's per-origin grant rejects every permission it does not name, so
 * the origin's decisions have to carry the context-wide grants with them or
 * naming one permission for a site silently withdraws the rest there.
 */
it.live("keeps context-wide grants at an origin that names another", () =>
  Effect.gen(function* replayMixedScopeGrants() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([{ type: "navigate", url: fixtures.url("permissions.html") }]),
      emulation: {
        permissions: [
          { permission: "notifications", state: "granted" },
          {
            origin: fixtures.origin,
            permission: "geolocation",
            state: "granted",
          },
        ],
      },
    });

    expect(run.outcome).toBe("completed");
    const reports = beaconReports(fixtures.requests);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({
      // The origin's own grant, and the context-wide one it must not displace.
      geolocation: "granted",
      notifications: "granted",
    });
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
