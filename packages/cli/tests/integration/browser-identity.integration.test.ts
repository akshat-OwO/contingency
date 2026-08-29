import { resolveIdentity } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { chromium } from "playwright-core";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness.ts";

/** Poll until a page has reported, rather than guessing at a delay. */
const waitFor = (ready: () => boolean) =>
  Effect.gen(function* pollUntilReady() {
    while (!ready()) {
      yield* Effect.sleep("20 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));

const IDENTITY_BEACON = "/identity-beacon";
const FRAME_IDENTITY_BEACON = "/frame-identity-beacon";

/** What a fixture reported about the browser it ran in. */
const reportsOn = (beacon: string, requests: readonly string[]) =>
  requests
    .filter((request) => request.startsWith(`${beacon}?`))
    .map(
      (request) =>
        Object.fromEntries(
          new URLSearchParams(request.split("?")[1] ?? "")
        ) as Record<string, string>
    );

const identityReports = (requests: readonly string[]) =>
  reportsOn(IDENTITY_BEACON, requests);

/**
 * The identity Chrome Android Mobile resolves to against the Chromium that
 * will actually run it — the same normalization Create View stores in a Flow,
 * so this suite asserts what an authored Flow really carries rather than a
 * hand-written approximation of one.
 */
const chromeAndroidMobile = Effect.gen(function* resolveAndroidIdentity() {
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch()),
    (launched) => Effect.promise(() => launched.close())
  );
  const identity = resolveIdentity("chrome-android-mobile", browser.version());
  if (identity === undefined) {
    return yield* Effect.die("Chrome Android Mobile resolved to no identity.");
  }
  return identity;
});

const ANDROID_VIEWPORT = { deviceScaleFactor: 3, height: 892, width: 412 };

/**
 * A mobile choice is a coherent browser, not a string. Every claim here is
 * read off what the site actually received — the first document request's own
 * headers, then the page's own APIs — because a context option is not evidence
 * a site saw anything ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
it.live("runs Chrome Android Mobile as one coherent identity", () =>
  Effect.gen(function* replayMobileIdentity() {
    const fixtures = yield* fixtureServer;
    const identity = yield* chromeAndroidMobile;

    const { run } = yield* runFlow({
      ...flow([
        { type: "navigate", url: fixtures.url("browser-identity.html") },
      ]),
      emulation: { browser: identity, viewport: ANDROID_VIEWPORT },
    });

    expect(run.outcome).toBe("completed");

    // The document's own request, before any script could have patched
    // anything: the complete identity was installed before it was made.
    const document = fixtures.requestHeaders.find(({ url }) =>
      url.endsWith("browser-identity.html")
    );
    expect(document?.headers["user-agent"]).toBe(identity.userAgent);
    expect(document?.headers["user-agent"]).toContain("Android");
    expect(document?.headers["sec-ch-ua-mobile"]).toBe("?1");
    expect(document?.headers["sec-ch-ua-platform"]).toBe('"Android"');
    expect(document?.headers["sec-ch-ua"]).toContain("Google Chrome");

    const [report] = identityReports(fixtures.requests);
    expect(report).toBeDefined();
    expect(report?.["userAgent"]).toBe(identity.userAgent);
    // The client hints agree with the string rather than reporting the
    // desktop Chromium underneath.
    expect(report?.["hintMobile"]).toBe("1");
    expect(report?.["platform"]).toBe("Android");
    expect(report?.["model"]).toBe("Pixel 10");
    expect(report?.["brands"]).toContain("Google Chrome");
    // Touch capability and mobile pointer behaviour, not only a name.
    expect(report?.["touchEvents"]).toBe("1");
    expect(report?.["coarse"]).toBe("1");
    expect(Number(report?.["maxTouchPoints"])).toBeGreaterThan(0);
    // The viewport and scale factor the identity was applied with.
    expect(report?.["width"]).toBe(String(ANDROID_VIEWPORT.width));
    expect(report?.["devicePixelRatio"]).toBe(
      String(ANDROID_VIEWPORT.deviceScaleFactor)
    );
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * Desktop identities are untouched by the mobile work: a Flow declaring one
 * still reaches a site as a desktop Chromium with no touch and no mobile
 * client hint.
 */
it.live("leaves an existing desktop identity desktop", () =>
  Effect.gen(function* replayDesktopIdentity() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([
        { type: "navigate", url: fixtures.url("browser-identity.html") },
      ]),
      emulation: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
      },
    });

    expect(run.outcome).toBe("completed");
    const document = fixtures.requestHeaders.find(({ url }) =>
      url.endsWith("browser-identity.html")
    );
    expect(document?.headers["user-agent"]).toContain("Windows NT 10.0");
    expect(document?.headers["sec-ch-ua-mobile"]).toBe("?0");

    const [report] = identityReports(fixtures.requests);
    expect(report?.["touchEvents"]).toBe("0");
    expect(report?.["hintMobile"]).toBe("0");
    expect(report?.["width"]).toBe("1280");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * The authoring session is the same browser identity as the Run. Create View
 * applies it through a live session and CDP rather than context options, so
 * the two paths could drift; this reads the same evidence off both and is the
 * only thing that catches it (ADR 0013).
 */
it.live("shows an author the identity a Run will reproduce", () =>
  Effect.gen(function* authorMobileIdentity() {
    const fixtures = yield* fixtureServer;
    const browser = yield* CreateBrowser;
    const sessionId = yield* browser.create(
      "create-identity",
      ANDROID_VIEWPORT
    );
    yield* Effect.addFinalizer(() =>
      browser.close(sessionId).pipe(Effect.ignore)
    );

    yield* browser.open(
      sessionId,
      fixtures.url("browser-identity.html"),
      ANDROID_VIEWPORT,
      "chrome-android-mobile"
    );
    yield* waitFor(() => identityReports(fixtures.requests).length > 0);

    const emulation = yield* browser.getEmulation(sessionId);
    // The session declares the concrete identity, which is what a Recording
    // writes into the Flow — not the profile id that produced it.
    expect(emulation.browser?.mobile).toBe(true);
    expect(emulation.browser?.hasTouch).toBe(true);
    expect(emulation.browser?.userAgentMetadata?.platform).toBe("Android");

    const document = fixtures.requestHeaders.find(({ url }) =>
      url.endsWith("browser-identity.html")
    );
    expect(document?.headers["user-agent"]).toBe(emulation.browser?.userAgent);
    expect(document?.headers["sec-ch-ua-mobile"]).toBe("?1");
    expect(document?.headers["sec-ch-ua-platform"]).toBe('"Android"');
    expect(document?.headers["sec-ch-ua"]).toContain("Google Chrome");

    const [report] = identityReports(fixtures.requests);
    expect(report?.["userAgent"]).toBe(emulation.browser?.userAgent);
    expect(report?.["hintMobile"]).toBe("1");
    expect(report?.["model"]).toBe("Pixel 10");
    expect(report?.["touchEvents"]).toBe("1");
    expect(report?.["coarse"]).toBe("1");
    expect(report?.["width"]).toBe(String(ANDROID_VIEWPORT.width));
    expect(report?.["devicePixelRatio"]).toBe(
      String(ANDROID_VIEWPORT.deviceScaleFactor)
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(CreateBrowserLive, NodeServices.layer))
  )
);

/**
 * A cross-origin iframe — an ad, an embed, a payment frame — is where a string
 * and its client hints could drift apart unnoticed, because Chromium
 * substitutes the running binary's brand list wherever an override omits
 * `brands`. The Page's override does reach those frames; this pins that, so a
 * Chromium or Playwright change that stopped it would fail here rather than
 * reach a site.
 */
it.live("carries the identity into a cross-origin subframe", () =>
  Effect.gen(function* replayFramedIdentity() {
    const fixtures = yield* fixtureServer;
    const identity = yield* chromeAndroidMobile;

    const { run } = yield* runFlow({
      ...flow([
        {
          type: "navigate",
          url: fixtures.url("browser-identity-frames.html"),
        },
      ]),
      emulation: { browser: identity, viewport: ANDROID_VIEWPORT },
    });

    expect(run.outcome).toBe("completed");
    // The frame's own document request, which is genuinely cross-site.
    const frameDocument = fixtures.requestHeaders.find(({ url }) =>
      url.endsWith("identity-frame.html")
    );
    expect(frameDocument?.headers["sec-fetch-dest"]).toBe("iframe");
    expect(frameDocument?.headers["sec-fetch-site"]).toBe("cross-site");
    expect(frameDocument?.headers["user-agent"]).toBe(identity.userAgent);
    expect(frameDocument?.headers["sec-ch-ua-mobile"]).toBe("?1");
    expect(frameDocument?.headers["sec-ch-ua"]).toContain("Google Chrome");
    expect(frameDocument?.headers["sec-ch-ua"]).not.toContain("Headless");

    const [framed] = reportsOn(FRAME_IDENTITY_BEACON, fixtures.requests);
    expect(framed).toBeDefined();
    expect(framed?.["userAgent"]).toBe(identity.userAgent);
    expect(framed?.["hintMobile"]).toBe("1");
    // The authored brands, not the brands of the Chromium actually running.
    expect(framed?.["brands"]).toContain("Google Chrome");
    expect(framed?.["brands"]).not.toContain("HeadlessChrome");
    expect(framed?.["model"]).toBe("Pixel 10");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
