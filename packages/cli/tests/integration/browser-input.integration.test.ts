import { SessionId, UserAgentProfileId } from "@contingency/protocol";
import { expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 } as const;

it.live("reuses one ordered input channel for a click and typing", () =>
  Effect.gen(function* orderedWorkspaceInput() {
    const browser = yield* CreateBrowser;
    const sessionId = SessionId.make("create-input-order");
    yield* browser.create(sessionId, viewport);
    const { context, page } = yield* browser.activeTarget(sessionId);
    yield* Effect.promise(() =>
      page.setContent(
        '<button id="target">Click</button><input id="entry"><script>document.querySelector("#target").addEventListener("click", (event) => event.currentTarget.dataset.clicks = String(Number(event.currentTarget.dataset.clicks || 0) + 1));</script>'
      )
    );
    const attach = vi.spyOn(context, "newCDPSession");
    const mouse = (eventType: "mousePressed" | "mouseReleased") =>
      browser.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        x: 40,
        y: 18,
      });
    yield* Effect.all([mouse("mousePressed"), mouse("mouseReleased")], {
      concurrency: "unbounded",
    });
    expect(
      yield* Effect.promise(() =>
        page.locator("#target").evaluate((element) => element.dataset.clicks)
      )
    ).toBe("1");
    expect(attach).toHaveBeenCalledTimes(1);
    yield* Effect.promise(() => page.locator("#entry").focus());
    for (const character of "abc") {
      yield* browser.sendInput(sessionId, {
        eventType: "keyDown",
        key: character,
        text: character,
        type: "input_keyboard",
      });
      yield* browser.sendInput(sessionId, {
        eventType: "keyUp",
        key: character,
        type: "input_keyboard",
      });
    }
    expect(
      yield* Effect.promise(() => page.locator("#entry").inputValue())
    ).toBe("abc");
    expect(attach).toHaveBeenCalledTimes(1);
    yield* browser.newTab(sessionId);
    const second = yield* browser.activeTarget(sessionId);
    yield* Effect.promise(() =>
      second.page.setContent(
        '<button id="target" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Second tab</button>'
      )
    );
    const attachmentsBeforeSecondClick = attach.mock.calls.length;
    yield* mouse("mousePressed");
    yield* mouse("mouseReleased");
    expect(
      yield* Effect.promise(() =>
        second.page
          .locator("#target")
          .evaluate((element) => element.dataset.clicks)
      )
    ).toBe("1");
    expect(attach).toHaveBeenCalledTimes(attachmentsBeforeSecondClick + 1);
    const originalTabId = (yield* browser.getTabs(sessionId)).find(
      (tab) => tab.url === page.url() && tab.active === false
    )?.tabId;
    if (originalTabId === undefined) {
      return yield* Effect.die("The original tab was lost.");
    }
    yield* browser.switchTab(sessionId, originalTabId);
    const attachmentsBeforeReturnClick = attach.mock.calls.length;
    yield* mouse("mousePressed");
    yield* mouse("mouseReleased");
    expect(
      yield* Effect.promise(() =>
        page.locator("#target").evaluate((element) => element.dataset.clicks)
      )
    ).toBe("2");
    expect(attach).toHaveBeenCalledTimes(attachmentsBeforeReturnClick + 1);
    yield* browser.close(sessionId);
  }).pipe(Effect.provide(CreateBrowserLive))
);

it.live("delivers touch events for a touch emulation profile", () =>
  Effect.gen(function* touchWorkspaceInput() {
    const browser = yield* CreateBrowser;
    const sessionId = SessionId.make("create-touch-input");
    yield* browser.create(sessionId, viewport);
    yield* browser.setUserAgent(
      sessionId,
      "about:blank",
      viewport,
      UserAgentProfileId.make("chrome-android-mobile")
    );
    const page = yield* browser.activePage(sessionId);
    yield* Effect.promise(() =>
      page.setContent(
        '<button id="target">Tap</button><script>for (const type of ["touchstart", "touchmove", "touchend", "click"]) document.querySelector("#target").addEventListener(type, () => document.documentElement.dataset.events = [document.documentElement.dataset.events, type].filter(Boolean).join(","));</script>'
      )
    );
    const send = (
      eventType: "mousePressed" | "mouseMoved" | "mouseReleased",
      x: number
    ) =>
      browser.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        x,
        y: 18,
      });
    yield* send("mousePressed", 40);
    yield* send("mouseReleased", 40);
    expect(
      yield* Effect.promise(() =>
        page.locator("html").evaluate((element) => element.dataset.events)
      )
    ).toBe("touchstart,touchend,click");
    yield* Effect.promise(() =>
      page.locator("html").evaluate((element) => {
        delete element.dataset.events;
      })
    );
    yield* send("mousePressed", 40);
    yield* send("mouseMoved", 80);
    yield* send("mouseReleased", 80);
    expect(
      yield* Effect.promise(() =>
        page.locator("html").evaluate((element) => element.dataset.events)
      )
    ).toContain("touchstart,touchmove,touchend");
    yield* browser.close(sessionId);
  }).pipe(Effect.provide(CreateBrowserLive))
);
