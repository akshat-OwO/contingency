import type { BrowserCookie } from "@contingency/protocol";
import {
  BrowserTabId,
  cookieIdentitiesEqual,
  cookieIdentityOf,
  filterCookiesForOriginHost,
  httpOriginFromUrl,
  recordingLocksStorageMutations,
} from "@contingency/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  applyFetchedStorageSnapshot,
  applyStorageOriginChange,
  cookieIdentityChanged,
  cookieDraftFromCookie,
  cookieWriteFromDraft,
  defaultCookieDraft,
  defaultWebStorageDraft,
  emptyStorageSnapshots,
  initialStoragePanelUiState,
  isStorageDraftDirty,
  retainStorageSelection,
  saveCookieMutation,
  selectedStorageRowExists,
  storageSearchMatchesCookie,
  storageSearchMatchesEntry,
  validateCookieName,
  validateStorageKey,
  visibleCookies,
  visibleWebStorageEntries,
} from "../../../src/components/create/browser-storage-state";

const cookie = (
  overrides: Partial<BrowserCookie> & Pick<BrowserCookie, "name" | "domain">
): BrowserCookie => ({
  expires: -1,
  httpOnly: false,
  path: "/",
  secure: false,
  session: true,
  size: 8,
  value: "token",
  ...overrides,
});

describe("httpOriginFromUrl", () => {
  it("returns the host and origin for http(s) pages", () => {
    expect(httpOriginFromUrl("https://app.example.com/home")).toEqual({
      host: "app.example.com",
      origin: "https://app.example.com",
    });
  });

  it("returns undefined for about:blank and other non-http pages", () => {
    expect(httpOriginFromUrl("about:blank")).toBeUndefined();
    expect(httpOriginFromUrl("chrome://newtab")).toBeUndefined();
  });
});

describe("filterCookiesForOriginHost", () => {
  const cookies = [
    cookie({ domain: ".example.com", name: "session" }),
    cookie({ domain: "app.example.com", name: "host" }),
    cookie({ domain: "stripe.com", name: "third" }),
    cookie({ domain: ".other.com", name: "parent-other" }),
  ];

  it("keeps host and parent-domain cookies for the current origin", () => {
    const visible = filterCookiesForOriginHost(cookies, "app.example.com");
    expect(visible.map((entry) => entry.name)).toEqual(["session", "host"]);
  });

  it("omits other-site cookies including subframe third parties", () => {
    const visible = filterCookiesForOriginHost(cookies, "app.example.com");
    expect(visible.some((entry) => entry.domain === "stripe.com")).toBe(false);
  });

  it("matches cookie domains using ASCII case folding", () => {
    const visible = filterCookiesForOriginHost(
      [cookie({ domain: ".EXAMPLE.COM", name: "parent" })],
      "App.Example.Com"
    );
    expect(visible.map((entry) => entry.name)).toEqual(["parent"]);
  });

  it("does not treat a host-only parent cookie as a domain cookie", () => {
    const visible = filterCookiesForOriginHost(
      [cookie({ domain: "example.com", name: "host-only" })],
      "app.example.com"
    );
    expect(visible).toEqual([]);
  });
});

describe("storage search", () => {
  it("matches cookie name, domain, path, and value", () => {
    const session = cookie({
      domain: ".example.com",
      name: "sid",
      path: "/app",
      value: "jwt-fragment-xyz",
    });
    expect(storageSearchMatchesCookie(session, "sid")).toBe(true);
    expect(storageSearchMatchesCookie(session, "example")).toBe(true);
    expect(storageSearchMatchesCookie(session, "/app")).toBe(true);
    expect(storageSearchMatchesCookie(session, "jwt-fragment")).toBe(true);
    expect(storageSearchMatchesCookie(session, "missing")).toBe(false);
  });

  it("matches Web Storage key and value for the visible store", () => {
    expect(
      storageSearchMatchesEntry("featureFlag", '{"on":true}', "flag")
    ).toBe(true);
    expect(
      storageSearchMatchesEntry("featureFlag", '{"on":true}', "true")
    ).toBe(true);
    expect(
      storageSearchMatchesEntry("featureFlag", '{"on":true}', "cookie")
    ).toBe(false);
  });

  it("filters only the supplied cookies or entries", () => {
    expect(
      visibleCookies(
        [
          cookie({ domain: "app.example.com", name: "a", value: "one" }),
          cookie({ domain: "app.example.com", name: "b", value: "two" }),
        ],
        "two"
      )
    ).toHaveLength(1);
    expect(visibleWebStorageEntries({ alpha: "1", beta: "2" }, "beta")).toEqual(
      [["beta", "2"]]
    );
  });

  it("sorts cookies by name, then domain, then path regardless of fetch order", () => {
    expect(
      visibleCookies(
        [
          cookie({ domain: "z.example.com", name: "theme", value: "dark" }),
          cookie({ domain: "a.example.com", name: "sid", path: "/app" }),
          cookie({ domain: "a.example.com", name: "sid", path: "/" }),
          cookie({ domain: "example.com", name: "locale", value: "en" }),
        ],
        ""
      ).map((entry) => `${entry.name}|${entry.domain}|${entry.path}`)
    ).toEqual([
      "locale|example.com|/",
      "sid|a.example.com|/",
      "sid|a.example.com|/app",
      "theme|z.example.com|/",
    ]);
  });
});

describe("origin change", () => {
  it("keeps the snapshot when the origin is unchanged", () => {
    const snapshots = emptyStorageSnapshots("https://app.example.com");
    const next = applyStorageOriginChange(
      snapshots,
      "https://app.example.com/account"
    );
    expect(next.clearSearchAndSelection).toBe(false);
    expect(next.snapshots).toBe(snapshots);
  });

  it("clears search and selection when the origin changes", () => {
    const snapshots = {
      ...emptyStorageSnapshots("https://app.example.com"),
      cookies: [cookie({ domain: "app.example.com", name: "sid" })],
    };
    const next = applyStorageOriginChange(
      snapshots,
      "https://other.example.net/"
    );
    expect(next.clearSearchAndSelection).toBe(true);
    expect(next.snapshots.cookies).toEqual([]);
    expect(next.snapshots.origin).toBe("https://other.example.net");
  });

  it("clears search and selection when the page has no http(s) origin", () => {
    const snapshots = emptyStorageSnapshots("https://app.example.com");
    const next = applyStorageOriginChange(snapshots, "about:blank");
    expect(next.clearSearchAndSelection).toBe(true);
    expect(next.snapshots.origin).toBeUndefined();
  });
});

describe("cookie identity", () => {
  it("identifies a cookie by name, domain, and path", () => {
    const left = cookie({
      domain: "app.example.com",
      name: "sid",
      path: "/",
    });
    const right = cookie({
      domain: "app.example.com",
      name: "sid",
      path: "/app",
      value: "other",
    });
    expect(cookieIdentitiesEqual(left, cookieIdentityOf(left))).toBe(true);
    expect(cookieIdentitiesEqual(left, right)).toBe(false);
  });

  it("treats domain or path edits as a new identity", () => {
    const draft = {
      ...defaultCookieDraft("app.example.com"),
      identity: { domain: "app.example.com", name: "sid", path: "/" },
      name: "sid",
      path: "/app",
    };
    expect(cookieIdentityChanged(draft)).toBe(true);
  });
});

describe("commit validation", () => {
  it("refuses an empty cookie name or Web Storage key", () => {
    expect(validateCookieName("")).toBe("Enter a cookie name.");
    expect(validateCookieName("  ")).toBe("Enter a cookie name.");
    expect(validateStorageKey("")).toBe("Enter a key.");
    expect(
      cookieWriteFromDraft(defaultCookieDraft("app.example.com"))
    ).toBeUndefined();
  });

  it("allows an empty value and overwrites an existing identity", () => {
    const draft = {
      ...defaultCookieDraft("app.example.com"),
      name: "sid",
      value: "",
    };
    expect(cookieWriteFromDraft(draft)).toMatchObject({
      name: "sid",
      value: "",
    });
    expect(
      selectedStorageRowExists(
        {
          identity: { domain: "app.example.com", name: "sid", path: "/" },
          kind: "cookies",
        },
        {
          ...emptyStorageSnapshots("https://app.example.com"),
          cookies: [
            cookie({ domain: "app.example.com", name: "sid", value: "old" }),
          ],
        }
      )
    ).toBe(true);
  });

  it("keeps an existing cookie expiry in the write payload", () => {
    const dated = cookie({
      domain: "app.example.com",
      expires: 1_700_000_000,
      name: "sid",
      session: false,
    });
    const draft = cookieDraftFromCookie(dated);

    expect(cookieWriteFromDraft(draft)).toMatchObject({
      expires: 1_700_000_000,
      name: "sid",
    });
  });

  it("writes a replacement before deleting the original identity", async () => {
    const operations: string[] = [];

    await Effect.runPromise(
      saveCookieMutation(
        Effect.sync(() => {
          operations.push("write");
        }),
        Effect.sync(() => {
          operations.push("delete");
        })
      )
    );

    expect(operations).toEqual(["write", "delete"]);
  });

  it("does not delete the original when replacement writing fails", async () => {
    let deleted = false;

    await expect(
      Effect.runPromise(
        saveCookieMutation(
          Effect.fail(new Error("replacement failed")),
          Effect.sync(() => {
            deleted = true;
          })
        )
      )
    ).rejects.toThrow("replacement failed");
    expect(deleted).toBe(false);
  });

  it("keeps a same-origin selection after the next snapshot when the row still exists", () => {
    const snapshots = {
      ...emptyStorageSnapshots("https://app.example.com"),
      cookies: [cookie({ domain: "app.example.com", name: "sid" })],
    };
    expect(
      retainStorageSelection(
        {
          identity: { domain: "app.example.com", name: "sid", path: "/" },
          kind: "cookies",
        },
        snapshots
      )
    ).toEqual({
      identity: { domain: "app.example.com", name: "sid", path: "/" },
      kind: "cookies",
    });
    expect(
      retainStorageSelection(
        {
          identity: { domain: "app.example.com", name: "gone", path: "/" },
          kind: "cookies",
        },
        snapshots
      )
    ).toBeUndefined();
  });
});

describe("fetched cookie snapshots", () => {
  const tabId = BrowserTabId.make("tab-1");
  const sid = cookie({ domain: "example.com", name: "sid", value: "a" });
  const theme = cookie({ domain: "example.com", name: "theme", value: "dark" });
  const locale = cookie({ domain: "example.com", name: "locale", value: "en" });

  it("sorts polled cookies and reuses the panel state when only order changed", () => {
    const first = applyFetchedStorageSnapshot(
      {
        ...initialStoragePanelUiState,
        storageSnapshots: emptyStorageSnapshots("https://example.com"),
      },
      "https://example.com/",
      {
        cookies: [theme, sid, locale],
        kind: "cookies",
        tabId,
      }
    );
    expect(first.storageSnapshots.cookies.map((entry) => entry.name)).toEqual([
      "locale",
      "sid",
      "theme",
    ]);
    const second = applyFetchedStorageSnapshot(first, "https://example.com/", {
      cookies: [sid, locale, theme],
      kind: "cookies",
      tabId,
    });
    expect(second).toBe(first);
    expect(second.storageSnapshots.cookies).toBe(
      first.storageSnapshots.cookies
    );
  });

  it("replaces the snapshot when a cookie value changes", () => {
    const first = applyFetchedStorageSnapshot(
      {
        ...initialStoragePanelUiState,
        storageSnapshots: emptyStorageSnapshots("https://example.com"),
      },
      "https://example.com/",
      {
        cookies: [sid, theme],
        kind: "cookies",
        tabId,
      }
    );
    const next = applyFetchedStorageSnapshot(first, "https://example.com/", {
      cookies: [sid, { ...theme, value: "light" }],
      kind: "cookies",
      tabId,
    });
    expect(next).not.toBe(first);
    expect(next.storageSnapshots.cookies.map((entry) => entry.value)).toEqual([
      "a",
      "light",
    ]);
  });
});

describe("mutation lock", () => {
  it("locks mutations for an in-progress Recording on that session", () => {
    expect(
      recordingLocksStorageMutations(
        { phase: "active", sessionId: "create-a" },
        "create-a"
      )
    ).toBe(true);
    expect(
      recordingLocksStorageMutations(
        { phase: "paused", sessionId: "create-a" },
        "create-a"
      )
    ).toBe(true);
    expect(
      recordingLocksStorageMutations(
        { phase: "incomplete", sessionId: "create-a" },
        "create-a"
      )
    ).toBe(true);
  });

  it("allows mutations when there is no Recording or it is finished", () => {
    expect(recordingLocksStorageMutations(null, "create-a")).toBe(false);
    expect(
      recordingLocksStorageMutations(
        { phase: "finished", sessionId: "create-a" },
        "create-a"
      )
    ).toBe(false);
  });

  it("does not lock a different browser session", () => {
    expect(
      recordingLocksStorageMutations(
        { phase: "active", sessionId: "create-a" },
        "create-b"
      )
    ).toBe(false);
  });
});

describe("dirty drafts", () => {
  it("treats cookie drafts as dirty and Web Storage edits as dirty only when the value changed", () => {
    const snapshots = {
      ...emptyStorageSnapshots("https://app.example.com"),
      local: { flag: "off" },
    };
    expect(
      isStorageDraftDirty(defaultCookieDraft("app.example.com"), snapshots)
    ).toBe(true);
    expect(
      isStorageDraftDirty(
        {
          ...defaultWebStorageDraft("local"),
          key: "flag",
          lockedKey: true,
          value: "off",
        },
        snapshots
      )
    ).toBe(false);
    expect(
      isStorageDraftDirty(
        {
          ...defaultWebStorageDraft("local"),
          key: "flag",
          lockedKey: true,
          value: "on",
        },
        snapshots
      )
    ).toBe(true);
  });
});
