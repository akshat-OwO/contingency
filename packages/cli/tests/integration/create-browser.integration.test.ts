import { BrowserStreamId, BrowserTabId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { draftEmulation, fixtureServer, NEVER_ANSWERED } from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

const CreateBrowserIntegrationLive = Layer.merge(
  CreateBrowserLive,
  NodeServices.layer
);

const waitUntil = (ready: () => boolean) =>
  Effect.gen(function* waitForCondition() {
    while (!ready()) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));

it.live(
  "opens, streams, stores state, changes emulation, and closes a Create View session",
  () =>
    Effect.gen(function* browserSessionLifecycle() {
      const browser = yield* CreateBrowser;
      const sessionId = yield* browser.create("create-live", viewport);
      const opened = yield* browser.open(
        sessionId,
        "data:text/html,<title>Live</title><main>ready</main>",
        draftEmulation("chrome-windows", viewport)
      );
      expect(opened.sessionId).toBe(sessionId);

      const frame = yield* browser.stream(sessionId).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.runHead,
        Effect.flatMap((result) =>
          result._tag === "Some"
            ? Effect.succeed(result.value)
            : Effect.die("The screencast ended before emitting a frame.")
        ),
        Effect.timeout("10 seconds")
      );
      expect(frame.data.length).toBeGreaterThan(0);
      yield* browser.acknowledgeFrame(
        sessionId,
        frame.seq,
        BrowserStreamId.make(frame.streamId)
      );

      const [tab] = yield* browser.getTabs(sessionId);
      expect(tab).toBeDefined();
      expect(tab?.title).toBe("Live");
      const tabId = BrowserTabId.make(tab?.tabId ?? "missing");

      const domainOnly = yield* browser.open(
        sessionId,
        "example.com",
        draftEmulation("chrome-windows", viewport)
      );
      expect(domainOnly.url).toBe("https://example.com/");
      yield* browser.setStorage(sessionId, tabId, {
        key: "mode",
        kind: "local",
        value: "authoring",
      });
      yield* browser.setStorage(sessionId, tabId, {
        key: "draft",
        kind: "session",
        value: "kept",
      });
      yield* browser.setStorage(sessionId, tabId, {
        cookie: {
          domain: "example.com",
          httpOnly: false,
          name: "preview",
          path: "/",
          secure: true,
          value: "on",
        },
        kind: "cookies",
      });
      yield* browser.setStorage(sessionId, tabId, {
        cookie: {
          domain: "example.org",
          httpOnly: false,
          name: "other-origin",
          path: "/",
          secure: true,
          value: "kept",
        },
        kind: "cookies",
      });

      yield* browser.setUserAgent(
        sessionId,
        "https://example.com/",
        viewport,
        "safari-iphone"
      );
      expect(
        yield* browser.getStorage(sessionId, tabId, "local")
      ).toMatchObject({ entries: { mode: "authoring" } });
      expect(
        yield* browser.getStorage(sessionId, tabId, "session")
      ).toMatchObject({ entries: { draft: "kept" } });
      expect(
        yield* browser.getStorage(sessionId, tabId, "cookies")
      ).toMatchObject({
        cookies: [expect.objectContaining({ name: "preview", value: "on" })],
      });

      yield* browser.deleteStorage(sessionId, tabId, {
        key: "draft",
        kind: "session",
      });
      yield* browser.clearStorage(sessionId, tabId, "local");
      yield* browser.clearStorage(sessionId, tabId, "cookies");
      expect(
        yield* browser.getStorage(sessionId, tabId, "session")
      ).toMatchObject({ entries: {} });
      expect(
        yield* browser.getStorage(sessionId, tabId, "local")
      ).toMatchObject({
        entries: {},
      });
      yield* browser.open(
        sessionId,
        "https://example.org/",
        draftEmulation("safari-iphone", viewport)
      );
      expect(
        yield* browser.getStorage(sessionId, tabId, "cookies")
      ).toMatchObject({
        cookies: [
          expect.objectContaining({ name: "other-origin", value: "kept" }),
        ],
      });

      yield* browser.newTab(sessionId);
      expect(
        yield* browser.getStorage(sessionId, tabId, "cookies")
      ).toMatchObject({ cookies: [] });
      const inactiveWrite = yield* Effect.flip(
        browser.setStorage(sessionId, tabId, {
          key: "inactive",
          kind: "local",
          value: "blocked",
        })
      );
      expect(inactiveWrite.code).toBe("session_not_found");

      yield* browser.close(sessionId);
      expect(yield* browser.list()).not.toContain(sessionId);
    }).pipe(Effect.scoped, Effect.provide(CreateBrowserLive))
);

it.live("rolls back only implicitly created sessions when opening fails", () =>
  Effect.gen(function* failedOpenCleanup() {
    const browser = yield* CreateBrowser;
    const existingSessionId = yield* browser.create(
      "create-existing",
      viewport
    );

    yield* Effect.flip(
      browser.open(
        undefined,
        "http://127.0.0.1:1/",
        draftEmulation("chrome-windows", viewport)
      )
    );
    expect(yield* browser.list()).toEqual([existingSessionId]);

    yield* Effect.flip(
      browser.open(
        existingSessionId,
        "http://127.0.0.1:1/",
        draftEmulation("chrome-windows", viewport)
      )
    );
    expect(yield* browser.list()).toEqual([existingSessionId]);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserLive))
);

it.live("rolls back interrupted implicit opens only", () =>
  Effect.gen(function* interruptedOpenCleanup() {
    const browser = yield* CreateBrowser;
    const fixtures = yield* fixtureServer;
    const existingSessionId = yield* browser.create(
      "create-interrupted-existing",
      viewport
    );
    const neverAnsweredUrl = `${fixtures.origin}${NEVER_ANSWERED}`;

    const implicitOpen = yield* Effect.forkChild(
      browser.open(
        undefined,
        neverAnsweredUrl,
        draftEmulation("chrome-windows", viewport)
      )
    );
    yield* waitUntil(
      () =>
        fixtures.requests.filter((request) => request === NEVER_ANSWERED)
          .length === 1
    );
    yield* Fiber.interrupt(implicitOpen);
    expect(yield* browser.list()).toEqual([existingSessionId]);

    const existingOpen = yield* Effect.forkChild(
      browser.open(
        existingSessionId,
        neverAnsweredUrl,
        draftEmulation("chrome-windows", viewport)
      )
    );
    yield* waitUntil(
      () =>
        fixtures.requests.filter((request) => request === NEVER_ANSWERED)
          .length === 2
    );
    yield* Fiber.interrupt(existingOpen);
    expect(yield* browser.list()).toEqual([existingSessionId]);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

it.live("applies an opened profile to every tab in an existing session", () =>
  Effect.gen(function* multiTabUserAgent() {
    const browser = yield* CreateBrowser;
    const sessionId = yield* browser.create("create-user-agent", viewport);
    yield* browser.open(
      sessionId,
      "data:text/html,<title></title><script>document.title=navigator.userAgent</script>",
      draftEmulation("chrome-windows", viewport)
    );
    const [firstTab] = yield* browser.getTabs(sessionId);
    expect(firstTab).toBeDefined();

    yield* browser.newTab(sessionId);
    yield* browser.open(
      sessionId,
      "data:text/html,<title>second</title>",
      draftEmulation("safari-iphone", viewport)
    );
    yield* browser.switchTab(
      sessionId,
      BrowserTabId.make(firstTab?.tabId ?? "missing")
    );
    yield* browser.navigate(sessionId, "reload");
    yield* Effect.sleep("100 millis");

    const activeTab = (yield* browser.getTabs(sessionId)).find(
      ({ active }) => active
    );
    expect(activeTab?.title).toContain("iPhone");
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserLive))
);

it.live(
  "applies a session's Emulation to every Page and clears it without closing",
  () =>
    Effect.gen(function* sessionEmulationLifecycle() {
      const browser = yield* CreateBrowser;
      const fixtures = yield* fixtureServer;

      /** A page that reports what it receives through the geolocation API. */
      const locationProbe = (label: string) =>
        `${fixtures.origin}/geolocation-probe.html?label=${label}`;

      const sessionId = yield* browser.create("create-emulation", viewport);

      /**
       * A navigation applies one whole Emulation, so each probe carries the
       * settings that are meant to be in force when it loads rather than
       * inheriting whatever the session was last patched with.
       */
      const berlin = { accuracy: 25, latitude: 52.52, longitude: 13.405 };
      const granted = [
        { permission: "geolocation", state: "granted" as const },
      ];

      /** Poll until the probe page reports under its label. */
      const waitForReport = (label: string) =>
        Effect.gen(function* pollTitle() {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const tabs = yield* browser.getTabs(sessionId);
            const title =
              tabs.find((tab) => tab.title.startsWith(`${label}:`))?.title ??
              "";
            if (title.length > 0) {
              return title;
            }
            yield* Effect.sleep("25 millis");
          }
          return yield* Effect.die(
            `The probe never reported: expected ${label}.`
          );
        });

      // Nothing granted yet: a site asking for position is refused.
      yield* browser.open(
        sessionId,
        locationProbe("bare"),
        draftEmulation("default", viewport)
      );
      expect(yield* waitForReport("bare")).toBe("bare:denied");

      const applied = yield* browser.setEmulation(sessionId, {
        geolocation: { accuracy: 25, latitude: 52.52, longitude: 13.405 },
        permissions: [{ permission: "geolocation", state: "granted" }],
      });
      expect(applied.geolocation).toMatchObject({
        latitude: 52.52,
        longitude: 13.405,
      });
      expect(applied.permissions).toEqual([
        { permission: "geolocation", state: "granted" },
      ]);

      // The override is applied to the open Page without a reload being
      // Contingency's business — the probe navigates itself.
      yield* browser.open(
        sessionId,
        locationProbe("granted"),
        draftEmulation("default", viewport, {
          geolocation: berlin,
          permissions: granted,
        })
      );
      expect(yield* waitForReport("granted")).toBe("granted:52.52,13.405");

      // A new tab is one device in one place too.
      yield* browser.newTab(sessionId);
      yield* browser.open(
        sessionId,
        locationProbe("tab"),
        draftEmulation("default", viewport, {
          geolocation: berlin,
          permissions: granted,
        })
      );
      expect(yield* waitForReport("tab")).toBe("tab:52.52,13.405");

      // The picker sends a location with no accuracy, and an omitted accuracy
      // emulates *position unavailable*, so this is the payload that proves
      // the override still resolves to coordinates.
      yield* browser.setEmulation(sessionId, {
        geolocation: { latitude: 48.8566, longitude: 2.3522 },
      });
      yield* browser.open(
        sessionId,
        locationProbe("no-accuracy"),
        draftEmulation("default", viewport, {
          geolocation: { latitude: 48.8566, longitude: 2.3522 },
          permissions: granted,
        })
      );
      expect(yield* waitForReport("no-accuracy")).toBe(
        "no-accuracy:48.8566,2.3522"
      );

      // Changing the user agent rebuilds the whole Emulation, so the
      // location override and grant survive it (ADR 0013).
      yield* browser.setUserAgent(
        sessionId,
        locationProbe("after-ua"),
        viewport,
        "safari-iphone"
      );
      expect(yield* waitForReport("after-ua")).toBe("after-ua:48.8566,2.3522");

      // A locale override reaches the Page, and clearing it restores the
      // browser's own rather than leaving the old override in place.
      yield* browser.setEmulation(sessionId, { locale: "fr-FR" });
      yield* browser.open(
        sessionId,
        `${fixtures.origin}/locale-probe.html?label=locale`,
        draftEmulation("default", viewport, {
          locale: "fr-FR",
          permissions: granted,
        })
      );
      expect(yield* waitForReport("locale")).toBe("locale:fr-FR");
      yield* browser.setEmulation(sessionId, { locale: null });
      yield* browser.open(
        sessionId,
        `${fixtures.origin}/locale-probe.html?label=restored`,
        draftEmulation("default", viewport, { permissions: granted })
      );
      expect(yield* waitForReport("restored")).not.toBe("restored:fr-FR");

      // Both the grant and the override are dropped without closing anything.
      const cleared = yield* browser.setEmulation(sessionId, {
        geolocation: null,
        permissions: null,
      });
      expect(cleared.geolocation).toBeUndefined();
      expect(cleared.permissions).toEqual([]);
      // The snapshot grants nothing and declares no location, so the site is
      // refused again without the session being closed.
      yield* browser.open(
        sessionId,
        locationProbe("cleared"),
        draftEmulation("default", viewport)
      );
      expect(yield* waitForReport("cleared")).toBe("cleared:denied");

      yield* browser.close(sessionId);
    }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

/**
 * Create View reproduces a decision the same way a Run does. A denial keeps the
 * coordinates installed and still refuses the site, and an origin narrows a
 * grant to the one site under test. Neither answer waits on Chromium's native
 * permission bubble, which sits outside the streamed canvas: a prompt here
 * would never be answered, so the probe would never report at all ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
it.live("applies explicit permission decisions in a live session", () =>
  Effect.gen(function* applyPermissionDecisions() {
    const browser = yield* CreateBrowser;
    const fixtures = yield* fixtureServer;

    const locationProbe = (label: string) =>
      `${fixtures.origin}/geolocation-probe.html?label=${label}`;
    const berlin = { accuracy: 25, latitude: 52.52, longitude: 13.405 };

    const sessionId = yield* browser.create("create-decisions", viewport);

    const waitForReport = (label: string) =>
      Effect.gen(function* pollTitle() {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const tabs = yield* browser.getTabs(sessionId);
          const title =
            tabs.find((tab) => tab.title.startsWith(`${label}:`))?.title ?? "";
          if (title.length > 0) {
            return title;
          }
          yield* Effect.sleep("25 millis");
        }
        return yield* Effect.die(
          `The probe never reported: expected ${label}.`
        );
      });

    yield* browser.open(
      sessionId,
      locationProbe("denied"),
      draftEmulation("default", viewport, {
        geolocation: berlin,
        permissions: [{ permission: "geolocation", state: "denied" }],
      })
    );
    expect(yield* waitForReport("denied")).toBe("denied:denied");

    const decided = yield* browser.setEmulation(sessionId, {
      permissions: [
        { permission: "geolocation", state: "denied" },
        {
          origin: fixtures.origin,
          permission: "geolocation",
          state: "granted",
        },
      ],
    });
    expect(decided.permissions).toEqual([
      { permission: "geolocation", state: "denied" },
      { origin: fixtures.origin, permission: "geolocation", state: "granted" },
    ]);

    yield* browser.open(
      sessionId,
      locationProbe("origin"),
      draftEmulation("default", viewport, {
        geolocation: berlin,
        permissions: [
          { permission: "geolocation", state: "denied" },
          {
            origin: fixtures.origin,
            permission: "geolocation",
            state: "granted",
          },
        ],
      })
    );
    expect(yield* waitForReport("origin")).toBe("origin:52.52,13.405");

    // The same coordinates were installed under the denial all along: turning
    // the decision into a context-wide grant answers the site with them
    // without the location itself being re-applied.
    yield* browser.open(
      sessionId,
      locationProbe("context-wide"),
      draftEmulation("default", viewport, {
        geolocation: berlin,
        permissions: [{ permission: "geolocation", state: "granted" }],
      })
    );
    expect(yield* waitForReport("context-wide")).toBe(
      "context-wide:52.52,13.405"
    );

    yield* browser.close(sessionId);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

const ENVIRONMENT_BEACON = "/environment-beacon";

/** What the fixture page reported about the browser it loaded into. */
const environmentReports = (requests: readonly string[]) =>
  requests
    .filter((request) => request.startsWith(`${ENVIRONMENT_BEACON}?`))
    .map((request) =>
      Object.fromEntries(new URLSearchParams(request.split("?")[1] ?? ""))
    );

/**
 * One navigation applies one whole Emulation. Every claim is read off what the
 * document itself observed, because a setting applied after the first request
 * is exactly the defect this covers ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
it.live(
  "applies one Emulation snapshot before the session's first document",
  () =>
    Effect.gen(function* applySnapshotBeforeFirstDocument() {
      const fixtures = yield* fixtureServer;
      const browser = yield* CreateBrowser;
      const sessionId = yield* browser
        .open(undefined, `${fixtures.origin}/emulation-environment.html`, {
          colorScheme: "dark",
          geolocation: { accuracy: 25, latitude: 52.52, longitude: 13.405 },
          locale: "de-DE",
          permissions: [{ permission: "geolocation", state: "granted" }],
          timezoneId: "Europe/Berlin",
          userAgentProfile: "chrome-android-mobile",
          viewport: { deviceScaleFactor: 3, height: 892, width: 412 },
        })
        .pipe(Effect.map(({ sessionId: opened }) => opened));

      yield* waitUntil(() => environmentReports(fixtures.requests).length >= 2);
      const [environment, location] = environmentReports(fixtures.requests);
      expect(environment).toMatchObject({
        colorScheme: "dark",
        language: "de-DE",
        timezone: "Europe/Berlin",
      });
      // The grant travelled with the snapshot, so the site was answered rather
      // than refused — and with the emulated position.
      expect(location).toMatchObject({
        latitude: "52.52",
        longitude: "13.405",
      });

      // The identity reached the first request itself, not just the document.
      const document = fixtures.requestHeaders.find(({ url }) =>
        url.startsWith("/emulation-environment.html")
      );
      expect(document?.headers["user-agent"]).toContain("Android");
      expect(document?.headers["sec-ch-ua-mobile"]).toBe("?1");

      yield* browser.close(sessionId);
    }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

/**
 * Changing identity reloads the page rather than rebuilding the session, so
 * everything the author signed into or stored is still there afterwards.
 */
it.live("keeps cookies and storage across an identity change", () =>
  Effect.gen(function* retainStorageAcrossIdentityChange() {
    const fixtures = yield* fixtureServer;
    const browser = yield* CreateBrowser;
    const url = `${fixtures.origin}/emulation-environment.html`;
    const { sessionId } = yield* browser.open(
      undefined,
      url,
      draftEmulation("chrome-windows", viewport)
    );
    const [tab] = yield* browser.getTabs(sessionId);
    const tabId = BrowserTabId.make(tab?.tabId ?? "missing");
    yield* browser.setStorage(sessionId, tabId, {
      key: "cart",
      kind: "local",
      value: "two-items",
    });
    yield* browser.setStorage(sessionId, tabId, {
      cookie: {
        domain: "127.0.0.1",
        httpOnly: false,
        name: "session-token",
        path: "/",
        secure: false,
        value: "signed-in",
      },
      kind: "cookies",
    });

    yield* browser.setUserAgent(
      sessionId,
      url,
      viewport,
      "chrome-android-mobile"
    );

    expect(yield* browser.getStorage(sessionId, tabId, "local")).toMatchObject({
      entries: { cart: "two-items" },
    });
    expect(
      yield* browser.getStorage(sessionId, tabId, "cookies")
    ).toMatchObject({
      cookies: [
        expect.objectContaining({ name: "session-token", value: "signed-in" }),
      ],
    });

    yield* browser.close(sessionId);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);
