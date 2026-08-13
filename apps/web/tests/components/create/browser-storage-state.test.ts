import type { BrowserCookie } from "@contingency/protocol";
import {
  cookieIdentitiesEqual,
  cookieIdentityOf,
  filterCookiesForOriginHost,
  httpOriginFromUrl,
  recordingLocksStorageMutations,
} from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  applyStorageOriginChange,
  cookieIdentityChanged,
  cookieWriteFromDraft,
  defaultCookieDraft,
  defaultWebStorageDraft,
  emptyStorageSnapshots,
  isStorageDraftDirty,
  retainStorageSelection,
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
