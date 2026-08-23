import { BrowserStreamId, BrowserTabId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

it.live(
  "opens, streams, stores state, changes emulation, and closes a Create View session",
  () =>
    Effect.gen(function* browserSessionLifecycle() {
      const browser = yield* CreateBrowser;
      const sessionId = yield* browser.create("create-live", viewport);
      const opened = yield* browser.open(
        sessionId,
        "data:text/html,<title>Live</title><main>ready</main>",
        viewport,
        "chrome-windows"
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
        viewport,
        "chrome-windows"
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
        viewport,
        "safari-iphone"
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
