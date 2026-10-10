import { BrowserStreamId, BrowserTabId } from "@contingency/protocol";
import type { BrowserTab, SessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import type { CreateBrowserService } from "../../src/services/create-browser.ts";
import { beginScanCollection } from "../../src/services/scan-engine.ts";
import {
  CLOUDFLARE_BLOCK,
  draftEmulation,
  fixtureServer,
  NEVER_ANSWERED,
} from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

interface BrowserNavigator extends Navigator {
  readonly webdriver: boolean;
}
const readWebdriver = () => {
  // SAFETY: This callback executes in Chromium, whose Navigator exposes webdriver; Node's Navigator type omits it.
  const browserNavigator = navigator as BrowserNavigator;
  return browserNavigator.webdriver;
};

const CreateBrowserIntegrationLive = Layer.merge(
  CreateBrowserLive,
  NodeServices.layer
);

/**
 * The first tabs `ready` accepts, read off the browser stream. The stream
 * replays the latest tabs on subscribe, so a change made before this call
 * still counts.
 */
const awaitTabs = (
  browser: CreateBrowserService,
  sessionId: SessionId,
  ready: (tabs: readonly BrowserTab[]) => boolean
) =>
  browser.stream(sessionId).pipe(
    Stream.filter((event) => event.type === "tabs"),
    Stream.map((event) => event.tabs),
    Stream.filter(ready),
    Stream.runHead,
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : Effect.die("The stream ended before the tabs were ready.")
    ),
    Effect.timeout("10 seconds")
  );

/** The title of the tab the session is showing. */
const activeTitle = (tabs: readonly BrowserTab[]) =>
  tabs.find(({ active }) => active)?.title ?? "";

/** The title of the first tab whose title starts with `label:`. */
const reportedTitle = (tabs: readonly BrowserTab[], label: string) =>
  tabs.find((tab) => tab.title.startsWith(`${label}:`))?.title;

/** Wait until a probe Page reports under its label, and read the report. */
const awaitReport = (
  browser: CreateBrowserService,
  sessionId: SessionId,
  label: string
) =>
  awaitTabs(
    browser,
    sessionId,
    (tabs) => reportedTitle(tabs, label) !== undefined
  ).pipe(Effect.map((tabs) => reportedTitle(tabs, label)));

/**
 * A tab's title follows the page after load, whether or not the tab is
 * active, and the site cannot see how Contingency watches it.
 */
it.live("follows title changes after load on every tab", () =>
  Effect.gen(function* lateTabTitles() {
    const browser = yield* CreateBrowser;
    const sessionId = yield* browser.create("create-late-titles", viewport);
    yield* browser.open(
      sessionId,
      "data:text/html,<title>Initial</title><main>ready</main>",
      draftEmulation("default", viewport)
    );
    const firstPage = yield* browser.activePage(sessionId);
    const [firstTab] = yield* browser.getTabs(sessionId);
    yield* browser.newTab(sessionId);
    yield* browser.open(
      sessionId,
      "data:text/html,<title>Second</title>",
      draftEmulation("default", viewport)
    );
    const secondPage = yield* browser.activePage(sessionId);
    yield* Effect.promise(() =>
      firstPage.evaluate('document.title = "Late first"')
    );
    // A replaced head takes the observed title element with it.
    yield* Effect.promise(() =>
      secondPage.evaluate(`{
        const head = document.createElement("head");
        const title = document.createElement("title");
        title.textContent = "Late second";
        head.append(title);
        document.head.replaceWith(head);
      }`)
    );
    const titles = (tabs: readonly BrowserTab[]) => [
      tabs.find((tab) => tab.tabId === firstTab?.tabId)?.title,
      tabs.find((tab) => tab.active)?.title,
    ];
    const reported = yield* awaitTabs(browser, sessionId, (tabs) => {
      const [first, active] = titles(tabs);
      return first === "Late first" && active === "Late second";
    });
    expect(titles(reported)).toEqual(["Late first", "Late second"]);
    expect(
      yield* Effect.promise(() =>
        secondPage.evaluate("typeof globalThis.contingencyReportTitle")
      )
    ).toBe("undefined");
    yield* browser.close(sessionId);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

/**
 * A viewer that subscribes late still learns the current tabs, however much
 * the page logged since: console output must not push them out of the replay.
 */
it.live("replays the latest tabs to a late viewer after console output", () =>
  Effect.gen(function* lateViewerTabs() {
    const browser = yield* CreateBrowser;
    const sessionId = yield* browser.create("create-late-tabs", viewport);
    yield* browser.open(
      sessionId,
      "data:text/html,<title>Initial</title><main>ready</main>",
      draftEmulation("default", viewport)
    );
    const page = yield* browser.activePage(sessionId);
    // The watcher holds the screencast, so the late viewer does not start it
    // and learns the tabs only from what the stream replays.
    const titled = yield* Deferred.make<true>();
    const logged = yield* Deferred.make<true>();
    const watcher = yield* browser.stream(sessionId).pipe(
      Stream.runForEach((event) => {
        if (event.type === "tabs" && activeTitle(event.tabs) === "Late") {
          return Deferred.succeed(titled, true);
        }
        if (event.type === "console" && event.text === "last") {
          return Deferred.succeed(logged, true);
        }
        return Effect.void;
      }),
      Effect.forkChild
    );
    yield* Effect.promise(() => page.evaluate('document.title = "Late"'));
    yield* Deferred.await(titled).pipe(Effect.timeout("10 seconds"));
    // More lines than the control events' replay window holds.
    yield* Effect.promise(() =>
      page.evaluate(`{
        for (let line = 0; line < 40; line += 1) console.log(String(line));
        console.log("last");
      }`)
    );
    yield* Deferred.await(logged).pipe(Effect.timeout("10 seconds"));

    const replayed = yield* awaitTabs(
      browser,
      sessionId,
      (tabs) => activeTitle(tabs) === "Late"
    );
    expect(activeTitle(replayed)).toBe("Late");
    yield* Fiber.interrupt(watcher);
    yield* browser.close(sessionId);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

it.live(
  "opens, streams, stores state, changes emulation, and closes a live browser session",
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

      // The title is reported after the first frame can arrive.
      const [tab] = yield* awaitTabs(
        browser,
        sessionId,
        (tabs) => activeTitle(tabs) === "Live"
      );
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
    const implicitRequest = yield* fixtures.awaitRequest(
      (request) => request === NEVER_ANSWERED
    );

    const implicitOpen = yield* Effect.forkChild(
      browser.open(
        undefined,
        neverAnsweredUrl,
        draftEmulation("chrome-windows", viewport)
      )
    );
    yield* Deferred.await(implicitRequest).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(implicitOpen);
    expect(yield* browser.list()).toEqual([existingSessionId]);

    const existingRequest = yield* fixtures.awaitRequest(
      (request) => request === NEVER_ANSWERED
    );
    const existingOpen = yield* Effect.forkChild(
      browser.open(
        existingSessionId,
        neverAnsweredUrl,
        draftEmulation("chrome-windows", viewport)
      )
    );
    yield* Deferred.await(existingRequest).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(existingOpen);
    expect(yield* browser.list()).toEqual([existingSessionId]);
  }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

it.live(
  "presents the browser default identity without headless or automation markers",
  () =>
    Effect.gen(function* headedDefaultIdentity() {
      const browser = yield* CreateBrowser;
      const fixtures = yield* fixtureServer;
      const sessionId = yield* browser.create(
        "create-headed-default",
        viewport
      );
      const identityBeacon = yield* fixtures.awaitRequest((request) =>
        request.startsWith("/identity-beacon?")
      );
      // Served over HTTP rather than as a `data:` URL: client hints exist only
      // in a secure context, which loopback is and an opaque origin is not.
      yield* browser.open(
        sessionId,
        fixtures.url("browser-identity.html"),
        draftEmulation("default", viewport)
      );
      const beacon = yield* Deferred.await(identityBeacon).pipe(
        Effect.timeout("10 seconds")
      );
      const page = new URLSearchParams(beacon.split("?")[1]);
      expect(page.get("userAgent")).toMatch(/ Chrome\//u);
      expect(page.get("userAgent")).not.toContain("HeadlessChrome");
      expect(page.get("webdriver")).toBe("false");
      expect(page.get("brands")).toContain("Chromium/");
      expect(page.get("brands")).not.toMatch(/headless/iu);

      const document = fixtures.requestHeaders.find(({ url }) =>
        url.startsWith("/browser-identity.html")
      );
      expect(document?.headers["user-agent"]).not.toContain("HeadlessChrome");
      expect(document?.headers["sec-ch-ua"]).toContain("Chromium");
      expect(document?.headers["sec-ch-ua"]).not.toMatch(/headless/iu);
    }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);

it.live("reports a Cloudflare bot protection block on the stream", () =>
  Effect.gen(function* cloudflareBlock() {
    const browser = yield* CreateBrowser;
    const fixtures = yield* fixtureServer;
    const sessionId = yield* browser.create("create-bot-block", viewport);
    yield* browser.open(
      sessionId,
      `${fixtures.origin}${CLOUDFLARE_BLOCK}`,
      draftEmulation("default", viewport)
    );
    const block = yield* browser.stream(sessionId).pipe(
      Stream.filter((event) => event.type === "bot_protection_block"),
      Stream.runHead,
      Effect.flatMap((result) =>
        result._tag === "Some"
          ? Effect.succeed(result.value)
          : Effect.die("The stream ended before reporting the block.")
      ),
      Effect.timeout("10 seconds")
    );
    expect(block).toMatchObject({
      provider: "cloudflare",
      status: 403,
      url: `${fixtures.origin}${CLOUDFLARE_BLOCK}`,
    });
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

    const reloaded = yield* awaitTabs(browser, sessionId, (tabs) =>
      activeTitle(tabs).includes("iPhone")
    );
    expect(activeTitle(reloaded)).toContain("iPhone");
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

      const waitForReport = (label: string) =>
        awaitReport(browser, sessionId, label);

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
 * A live session reproduces a decision the same way a headless Run does. A denial keeps the
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
      awaitReport(browser, sessionId, label);

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
const environmentReport = (request: string) =>
  Object.fromEntries(new URLSearchParams(request.split("?")[1] ?? ""));

/** Whether a request is the fixture's report carrying any of `fields`. */
const reportsField =
  (...fields: readonly string[]) =>
  (request: string) =>
    request.startsWith(`${ENVIRONMENT_BEACON}?`) &&
    fields.some((field) => field in environmentReport(request));

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
      const environmentBeacon = yield* fixtures.awaitRequest(
        reportsField("timezone")
      );
      const locationBeacon = yield* fixtures.awaitRequest(
        reportsField("latitude", "locationError")
      );
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

      const [environment, location] = yield* Effect.all([
        Deferred.await(environmentBeacon),
        Deferred.await(locationBeacon),
      ]).pipe(
        Effect.map((reports) => reports.map(environmentReport)),
        Effect.timeout("10 seconds")
      );
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

it.live(
  "keeps the screencast status for a late viewer however often the agent points",
  () =>
    Effect.gen(function* lateViewerStatus() {
      const browser = yield* CreateBrowser;
      const sessionId = yield* browser.create(
        "create-pointer-replay",
        viewport
      );
      yield* browser.open(
        sessionId,
        "data:text/html,<title>Pointer</title><main>ready</main>",
        draftEmulation("chrome-windows", viewport)
      );
      // A recording holds the screencast, so a later viewer does not start it
      // and sees the status only through the replay. This holder stops pulling
      // after its first event, as a subscriber that falls behind would.
      const framed = yield* Deferred.make<true>();
      const holder = yield* Effect.forkChild(
        browser
          .stream(sessionId)
          .pipe(
            Stream.runForEach(() =>
              Deferred.succeed(framed, true).pipe(Effect.andThen(Effect.never))
            )
          )
      );
      yield* Deferred.await(framed).pipe(Effect.timeout("10 seconds"));
      // More than both the control events' replay window and the pointer
      // ring, at one point so no stroke has a duration to wait out; then one
      // last point the late viewer must replay.
      for (let index = 0; index < 40; index += 1) {
        yield* browser.pointAgent(sessionId, { action: "move", x: 5, y: 5 });
      }
      yield* browser.pointAgent(sessionId, { action: "click", x: 6, y: 5 });

      const seen = new Set<string>();
      let latest: number | undefined;
      yield* browser.stream(sessionId).pipe(
        Stream.takeUntil((event) => {
          seen.add(event.type);
          if (event.type === "agent_pointer") {
            latest = event.x;
          }
          return seen.has("status") && seen.has("agent_pointer");
        }),
        Stream.runDrain,
        Effect.timeout("10 seconds")
      );
      expect(seen).toContain("status");
      expect(latest).toBe(6);

      yield* Fiber.interrupt(holder);
      yield* browser.close(sessionId);
    }).pipe(Effect.provide(CreateBrowserIntegrationLive)),
  30_000
);

it.live(
  "isolates Teaching from scan-capable Run debugging and keeps webdriver hidden",
  () =>
    Effect.gen(function* isolateScanBrowser() {
      const browser = yield* CreateBrowser;
      const teachingId = yield* browser.create(
        "create-scan-teaching",
        viewport
      );
      const runId = yield* browser.create(
        "create-scan-run",
        viewport,
        false,
        true
      );
      const teachingPage = yield* browser.activePage(teachingId);
      const runPage = yield* browser.activePage(runId);
      const fixtures = yield* fixtureServer;
      yield* browser.open(
        runId,
        `${fixtures.origin}/stateful.html`,
        draftEmulation("default", viewport)
      );
      expect(teachingPage.context().browser()).not.toBe(
        runPage.context().browser()
      );
      const markers = yield* Effect.promise(() =>
        Promise.all([
          teachingPage.evaluate(readWebdriver),
          runPage.evaluate(readWebdriver),
        ])
      );
      expect(markers).toEqual([false, false]);
      const owner = runPage.context().browser();
      if (owner === null) {
        throw new Error("Run browser missing");
      }
      const session = yield* Effect.promise(() => owner.newBrowserCDPSession());
      const commandFailure = yield* Effect.flip(
        Effect.tryPromise({
          catch: (cause) => new Error(String(cause)),
          try: () => session.send("Browser.getBrowserCommandLine"),
        })
      );
      expect(commandFailure.message).toContain("--enable-automation not set");
      const target = yield* browser.activeTarget(runId);
      expect(target.performanceEndpoint).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u
      );
      expect(
        (yield* browser.activeTarget(teachingId)).performanceEndpoint
      ).toBeUndefined();
      yield* Effect.promise(() => session.detach());
      const measured = yield* Effect.acquireUseRelease(
        Effect.promise(() =>
          beginScanCollection(
            runPage,
            "timespan",
            new AbortController().signal,
            target.performanceEndpoint
          )
        ),
        (collection) => Effect.promise(collection.finish),
        (collection) => Effect.promise(collection.cancel)
      );
      expect(measured.report).toHaveProperty("steps.0.lhr.lighthouseVersion");
    }).pipe(Effect.scoped, Effect.provide(CreateBrowserIntegrationLive))
);
