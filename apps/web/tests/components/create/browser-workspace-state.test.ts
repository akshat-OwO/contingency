import type { BrowserTabId, SessionId } from "@contingency/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  browserAddressFromUrlEvent,
  browserNetworkRefreshEffect,
  browserStreamIdentity,
  browserTabSynchronizationEffect,
  preserveBrowserTabMetadata,
  reconcileActiveTab,
} from "../../../src/components/create/browser-workspace-state";

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
    const previousTabId = "tab-1" as BrowserTabId;
    const popupTabId = "tab-2" as BrowserTabId;
    const sessionId = "create-popup" as SessionId;

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
    const tabId = "tab-1" as BrowserTabId;

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
