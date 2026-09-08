import { Effect } from "effect";
import { describe, expect, it, test } from "vitest";

import {
  browserAddressFromUrlEvent,
  browserAddressEditingAfter,
  browserNetworkRefreshEffect,
  browserStreamIdentity,
  browserTabSynchronizationEffect,
  browserViewportEmptyState,
  canvasHoldAfterFirstFrame,
  canvasHoldAfterNavigationCommand,
  preserveBrowserTabMetadata,
  reconcileActiveTab,
  replacePendingBrowserFrame,
  shouldDropStaleCanvasFrame,
  shouldRevealCanvasAfterPaint,
  viewportForIdentity,
} from "../../../src/components/create/browser-workspace-state";

describe("browserAddressEditingAfter", () => {
  it("ends the edit on submit so navigation can replace the typed URL", () => {
    const focused = browserAddressEditingAfter("focus");

    expect(focused).toBe(true);
    expect(browserAddressEditingAfter("submit")).toBe(false);
    expect(browserAddressEditingAfter("change")).toBe(true);
  });
});

describe("browserAddressFromUrlEvent", () => {
  it("preserves an in-progress address edit when a late URL event arrives", () => {
    expect(
      browserAddressFromUrlEvent("https://example.com/new", true, "about:blank")
    ).toBe("https://example.com/new");
  });

  it("synchronizes the address when the field is not being edited", () => {
    expect(
      browserAddressFromUrlEvent(
        "https://example.com",
        false,
        "https://example.com/next"
      )
    ).toBe("https://example.com/next");
  });
});

describe("reconcileActiveTab", () => {
  it("requests a stream restart when a popup becomes the active tab", () => {
    const previousTabId = "tab-1";
    const popupTabId = "tab-2";
    const sessionId = "create-popup";

    expect(
      reconcileActiveTab(
        [
          {
            active: false,
            tabId: previousTabId,
            title: "Previous page",
            url: "https://example.com",
          },
          {
            active: true,
            tabId: popupTabId,
            title: "Popup",
            url: "https://example.com/popup",
          },
        ],
        previousTabId,
        "https://example.com",
        false
      )
    ).toMatchObject({
      activeTabChanged: true,
      activeTabId: popupTabId,
      address: "https://example.com/popup",
    });
    expect(browserStreamIdentity(sessionId, popupTabId)).not.toBe(
      browserStreamIdentity(sessionId, previousTabId)
    );
  });
});

describe("browserTabSynchronizationEffect", () => {
  it("defers recurring tab refreshes until after the initial refresh completes", () => {
    const calls: boolean[] = [];
    let refreshing = false;
    const synchronizeTabs = (switchNewTab: boolean) => {
      if (refreshing) {
        return Effect.void;
      }
      refreshing = true;
      return Effect.sync(() => {
        calls.push(switchNewTab);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            refreshing = false;
          })
        )
      );
    };

    Effect.runSync(
      browserTabSynchronizationEffect(
        () => synchronizeTabs(false),
        () => synchronizeTabs(true)
      )
    );

    expect(calls).toEqual([false, true]);
  });
});

describe("browserNetworkRefreshEffect", () => {
  it("resolves the active tab again for every refresh", () => {
    const refreshedTabs: string[] = [];
    let activeTab = "tab-1";

    const refresh = () =>
      Effect.sync(() => {
        refreshedTabs.push(activeTab);
        activeTab = "tab-2";
      });

    Effect.runSync(
      browserNetworkRefreshEffect(refresh).pipe(Effect.repeat({ times: 1 }))
    );

    expect(refreshedTabs).toEqual(["tab-1", "tab-2"]);
  });
});

describe("preserveBrowserTabMetadata", () => {
  it("does not let a raw stream event replace an enriched background title", () => {
    const tabId = "tab-1";

    expect(
      preserveBrowserTabMetadata(
        [
          {
            active: false,
            tabId,
            title: "1mg.com",
            url: "https://www.1mg.com/",
          },
        ],
        [
          {
            active: true,
            tabId,
            title: "Online Pharmacy India",
            url: "https://www.1mg.com/",
          },
        ]
      )
    ).toEqual([
      {
        active: false,
        tabId,
        title: "Online Pharmacy India",
        url: "https://www.1mg.com/",
      },
    ]);
  });
});

describe("replacePendingBrowserFrame", () => {
  it("releases a coalesced frame before replacing it", () => {
    const released: number[] = [];

    expect(
      replacePendingBrowserFrame({ seq: 1 }, { seq: 2 }, ({ seq }) => {
        released.push(seq);
      })
    ).toEqual({ seq: 2 });
    expect(released).toEqual([1]);
  });
});

describe("canvas frame hold", () => {
  it("drops only while the navigation command is in flight", () => {
    expect(shouldDropStaleCanvasFrame("idle")).toBe(false);
    expect(shouldDropStaleCanvasFrame("dropping")).toBe(true);
    expect(shouldDropStaleCanvasFrame("awaiting-first-frame")).toBe(false);
  });

  it("waits for the first paint after the command settles", () => {
    expect(canvasHoldAfterNavigationCommand("dropping")).toBe(
      "awaiting-first-frame"
    );
    expect(canvasHoldAfterFirstFrame("awaiting-first-frame")).toBe("idle");
    expect(canvasHoldAfterFirstFrame("idle")).toBe("idle");
  });

  it("does not reveal the canvas while a hold is still dropping", () => {
    expect(shouldRevealCanvasAfterPaint("dropping")).toBe(false);
    expect(shouldRevealCanvasAfterPaint("awaiting-first-frame")).toBe(true);
    expect(shouldRevealCanvasAfterPaint("idle")).toBe(true);
  });
});

describe("browserViewportEmptyState", () => {
  it("keeps the Loading copy while a navigation hold is active", () => {
    expect(
      browserViewportEmptyState({
        error: undefined,
        opening: true,
        selectedSessionId: "create-1",
      })
    ).toMatchObject({
      icon: "loading",
      title: "Loading…",
    });
  });
});

/**
 * Choosing a mobile identity moves the device metrics with it, so an author
 * never sees a phone user agent laid out at a desktop size ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
test("a mobile identity brings its own viewport and scale factor", () => {
  const desktop = { deviceScaleFactor: 1, height: 720, width: 1280 };

  expect(viewportForIdentity("chrome-android-mobile", desktop)).toEqual({
    deviceScaleFactor: 3,
    height: 892,
    width: 412,
  });
  // A desktop identity declares no metrics, so the author's size stands.
  expect(viewportForIdentity("chrome-windows", desktop)).toEqual(desktop);
  expect(viewportForIdentity("default", desktop)).toEqual(desktop);
  // Switching back off a mobile identity takes its pixel ratio with it,
  // rather than leaving a desktop browser rendering at 3x.
  const phone = { deviceScaleFactor: 3, height: 892, width: 412 };
  expect(viewportForIdentity("chrome-windows", phone)).toEqual({
    deviceScaleFactor: 1,
    height: 892,
    width: 412,
  });
});
