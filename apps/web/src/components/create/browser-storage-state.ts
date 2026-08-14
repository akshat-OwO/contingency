import type {
  BrowserCookie,
  BrowserCookieIdentity,
  BrowserCookieWrite,
  BrowserStorageSnapshot,
  BrowserWebStorageEntries,
  CookieSameSite,
  StorageKind,
} from "@contingency/protocol";
import {
  compareCookieIdentities,
  cookieIdentitiesEqual,
  cookieIdentityOf,
  cookiesEquivalent,
  httpOriginFromUrl,
  sortCookiesByIdentity,
} from "@contingency/protocol";

export type StorageSelection =
  | { readonly identity: BrowserCookieIdentity; readonly kind: "cookies" }
  | { readonly key: string; readonly kind: "local" | "session" };

export interface CookieDraft {
  readonly domain: string;
  readonly expires: number;
  readonly fieldError: string | undefined;
  readonly httpOnly: boolean;
  readonly identity: BrowserCookieIdentity | undefined;
  readonly kind: "cookies";
  readonly name: string;
  readonly path: string;
  readonly sameSite: CookieSameSite | undefined;
  readonly secure: boolean;
  readonly value: string;
}

export interface WebStorageDraft {
  readonly fieldError: string | undefined;
  readonly key: string;
  readonly kind: "local" | "session";
  readonly lockedKey: boolean;
  readonly value: string;
}

export type StorageDraft = CookieDraft | WebStorageDraft;

export interface StorageSnapshots {
  readonly cookies: readonly BrowserCookie[];
  readonly local: BrowserWebStorageEntries;
  readonly origin: string | undefined;
  readonly session: BrowserWebStorageEntries;
}

export const emptyStorageSnapshots = (
  origin: string | undefined = undefined
): StorageSnapshots => ({
  cookies: [],
  local: {},
  origin,
  session: {},
});

export const defaultCookieDraft = (host: string): CookieDraft => ({
  domain: host,
  expires: -1,
  fieldError: undefined,
  httpOnly: false,
  identity: undefined,
  kind: "cookies",
  name: "",
  path: "/",
  sameSite: undefined,
  secure: false,
  value: "",
});

export const cookieDraftFromCookie = (cookie: BrowserCookie): CookieDraft => ({
  domain: cookie.domain,
  expires: cookie.expires,
  fieldError: undefined,
  httpOnly: cookie.httpOnly,
  identity: cookieIdentityOf(cookie),
  kind: "cookies",
  name: cookie.name,
  path: cookie.path,
  sameSite: cookie.sameSite,
  secure: cookie.secure,
  value: cookie.value,
});

export const defaultWebStorageDraft = (
  kind: "local" | "session"
): WebStorageDraft => ({
  fieldError: undefined,
  key: "",
  kind,
  lockedKey: false,
  value: "",
});

export const webStorageDraftFromEntry = (
  kind: "local" | "session",
  key: string,
  value: string
): WebStorageDraft => ({
  fieldError: undefined,
  key,
  kind,
  lockedKey: true,
  value,
});

export const validateCookieName = (name: string): string | undefined =>
  name.trim().length === 0 ? "Enter a cookie name." : undefined;

export const validateStorageKey = (key: string): string | undefined =>
  key.trim().length === 0 ? "Enter a key." : undefined;

export const cookieWriteFromDraft = (
  draft: CookieDraft
): BrowserCookieWrite | undefined => {
  const fieldError = validateCookieName(draft.name);
  if (fieldError !== undefined) {
    return undefined;
  }
  return {
    domain: draft.domain.trim() || draft.domain,
    ...(draft.expires < 0 ? {} : { expires: draft.expires }),
    httpOnly: draft.httpOnly,
    name: draft.name.trim(),
    path: draft.path.trim() || "/",
    ...(draft.sameSite === undefined ? {} : { sameSite: draft.sameSite }),
    secure: draft.secure,
    value: draft.value,
  };
};

export const storageSearchMatchesCookie = (
  cookie: BrowserCookie,
  query: string
): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    cookie.name.toLocaleLowerCase().includes(needle) ||
    cookie.domain.toLocaleLowerCase().includes(needle) ||
    cookie.path.toLocaleLowerCase().includes(needle) ||
    cookie.value.toLocaleLowerCase().includes(needle)
  );
};

export const storageSearchMatchesEntry = (
  key: string,
  value: string,
  query: string
): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    key.toLocaleLowerCase().includes(needle) ||
    value.toLocaleLowerCase().includes(needle)
  );
};

export const visibleCookies = (
  cookies: readonly BrowserCookie[],
  query: string
): readonly BrowserCookie[] =>
  cookies
    .filter((cookie) => storageSearchMatchesCookie(cookie, query))
    .toSorted(compareCookieIdentities);

export const visibleWebStorageEntries = (
  entries: BrowserWebStorageEntries,
  query: string
): readonly (readonly [string, string])[] =>
  Object.entries(entries)
    .filter(([key, value]) => storageSearchMatchesEntry(key, value, query))
    .toSorted(([left], [right]) => left.localeCompare(right));

export const storageEntryCount = (
  snapshots: StorageSnapshots,
  kind: StorageKind
): number => {
  if (kind === "cookies") {
    return snapshots.cookies.length;
  }
  return Object.keys(kind === "local" ? snapshots.local : snapshots.session)
    .length;
};

export const selectedStorageRowExists = (
  selection: StorageSelection | undefined,
  snapshots: StorageSnapshots
): boolean => {
  if (selection === undefined) {
    return false;
  }
  if (selection.kind === "cookies") {
    return snapshots.cookies.some((cookie) =>
      cookieIdentitiesEqual(cookie, selection.identity)
    );
  }
  const entries =
    selection.kind === "local" ? snapshots.local : snapshots.session;
  return Object.hasOwn(entries, selection.key);
};

export const applyStorageOriginChange = (
  snapshots: StorageSnapshots,
  nextUrl: string
): {
  readonly clearSearchAndSelection: boolean;
  readonly snapshots: StorageSnapshots;
} => {
  const nextOrigin = httpOriginFromUrl(nextUrl)?.origin;
  if (nextOrigin === snapshots.origin) {
    return { clearSearchAndSelection: false, snapshots };
  }
  return {
    clearSearchAndSelection: true,
    snapshots: emptyStorageSnapshots(nextOrigin),
  };
};

const webStorageEntriesEqual = (
  left: BrowserWebStorageEntries,
  right: BrowserWebStorageEntries
): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && left[key] === right[key]
  );
};

export const replaceStorageKindSnapshot = (
  snapshots: StorageSnapshots,
  origin: string | undefined,
  kind: StorageKind,
  cookies: readonly BrowserCookie[],
  entries: BrowserWebStorageEntries
): StorageSnapshots => {
  const sortedCookies = sortCookiesByIdentity(cookies);
  if (origin !== snapshots.origin) {
    return {
      cookies: kind === "cookies" ? sortedCookies : [],
      local: kind === "local" ? entries : {},
      origin,
      session: kind === "session" ? entries : {},
    };
  }
  if (kind === "cookies") {
    if (cookiesEquivalent(sortedCookies, snapshots.cookies)) {
      return snapshots;
    }
    return { ...snapshots, cookies: sortedCookies, origin };
  }
  if (kind === "local") {
    if (webStorageEntriesEqual(entries, snapshots.local)) {
      return snapshots;
    }
    return { ...snapshots, local: entries, origin };
  }
  if (webStorageEntriesEqual(entries, snapshots.session)) {
    return snapshots;
  }
  return { ...snapshots, origin, session: entries };
};

export const retainStorageSelection = (
  selection: StorageSelection | undefined,
  snapshots: StorageSnapshots
): StorageSelection | undefined =>
  selectedStorageRowExists(selection, snapshots) ? selection : undefined;

export const cookieIdentityChanged = (draft: CookieDraft): boolean =>
  draft.identity !== undefined &&
  !cookieIdentitiesEqual(draft.identity, {
    domain: draft.domain,
    name: draft.name.trim(),
    path: draft.path.trim() || "/",
  });

export const isStorageDraftDirty = (
  draft: StorageDraft | undefined,
  snapshots: StorageSnapshots = emptyStorageSnapshots()
): boolean => {
  if (draft === undefined) {
    return false;
  }
  if (draft.kind === "cookies") {
    return true;
  }
  if (!draft.lockedKey) {
    return draft.key.length > 0 || draft.value.length > 0;
  }
  const entries = draft.kind === "local" ? snapshots.local : snapshots.session;
  return entries[draft.key] !== draft.value;
};

export const initialStoragePanelUiState = {
  storageDraft: undefined,
  storageFocused: false,
  storageKind: "cookies",
  storageMutateError: undefined,
  storageSearch: "",
  storageSelection: undefined,
  storageSnapshots: emptyStorageSnapshots(),
} as const satisfies {
  readonly storageDraft: StorageDraft | undefined;
  readonly storageFocused: boolean;
  readonly storageKind: StorageKind;
  readonly storageMutateError: string | undefined;
  readonly storageSearch: string;
  readonly storageSelection: StorageSelection | undefined;
  readonly storageSnapshots: StorageSnapshots;
};

export const truncateStorageValue = (value: string, maxLength = 48): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;

export const formatCookieExpires = (cookie: BrowserCookie): string => {
  if (cookie.session || cookie.expires < 0) {
    return "Session";
  }
  return new Date(cookie.expires * 1000).toISOString();
};

export interface StoragePanelUiState {
  readonly storageDraft: StorageDraft | undefined;
  readonly storageFocused: boolean;
  readonly storageKind: StorageKind;
  readonly storageMutateError: string | undefined;
  readonly storageSearch: string;
  readonly storageSelection: StorageSelection | undefined;
  readonly storageSnapshots: StorageSnapshots;
}

const entriesFromSnapshot = (
  snapshot: BrowserStorageSnapshot
): {
  readonly cookies: readonly BrowserCookie[];
  readonly entries: BrowserWebStorageEntries;
} =>
  snapshot.kind === "cookies"
    ? { cookies: snapshot.cookies, entries: {} }
    : { cookies: [], entries: { ...snapshot.entries } };

export const applyFetchedStorageSnapshot = (
  current: StoragePanelUiState,
  tabUrl: string,
  snapshot: BrowserStorageSnapshot
): StoragePanelUiState => {
  const origin = httpOriginFromUrl(tabUrl)?.origin;
  const { cookies, entries } = entriesFromSnapshot(snapshot);
  const originChange = applyStorageOriginChange(
    current.storageSnapshots,
    tabUrl
  );
  const nextSnapshots = replaceStorageKindSnapshot(
    originChange.snapshots,
    origin,
    snapshot.kind,
    cookies,
    entries
  );
  const nextSelection = originChange.clearSearchAndSelection
    ? undefined
    : retainStorageSelection(current.storageSelection, nextSnapshots);
  const cookieDraftGone =
    current.storageDraft?.kind === "cookies" &&
    current.storageDraft.identity !== undefined &&
    !selectedStorageRowExists(
      { identity: current.storageDraft.identity, kind: "cookies" },
      nextSnapshots
    );
  const webDraftGone =
    current.storageDraft !== undefined &&
    current.storageDraft.kind !== "cookies" &&
    current.storageDraft.lockedKey &&
    !selectedStorageRowExists(
      { key: current.storageDraft.key, kind: current.storageDraft.kind },
      nextSnapshots
    );
  const dropDraft =
    originChange.clearSearchAndSelection || cookieDraftGone || webDraftGone;
  const nextDraft = dropDraft ? undefined : current.storageDraft;
  const nextError = originChange.clearSearchAndSelection
    ? undefined
    : current.storageMutateError;
  const nextSearch = originChange.clearSearchAndSelection
    ? ""
    : current.storageSearch;
  if (
    nextDraft === current.storageDraft &&
    nextError === current.storageMutateError &&
    nextSearch === current.storageSearch &&
    nextSelection === current.storageSelection &&
    nextSnapshots === current.storageSnapshots
  ) {
    return current;
  }
  return {
    ...current,
    storageDraft: nextDraft,
    storageMutateError: nextError,
    storageSearch: nextSearch,
    storageSelection: nextSelection,
    storageSnapshots: nextSnapshots,
  };
};

export const applyTabUrlOriginChange = (
  current: StoragePanelUiState,
  tabUrl: string
): StoragePanelUiState => {
  const originChange = applyStorageOriginChange(
    current.storageSnapshots,
    tabUrl
  );
  if (!originChange.clearSearchAndSelection) {
    return current;
  }
  return {
    ...current,
    storageDraft: undefined,
    storageFocused: false,
    storageMutateError: undefined,
    storageSearch: "",
    storageSelection: undefined,
    storageSnapshots: originChange.snapshots,
  };
};

export const selectedWebStorageValue = (
  selection: StorageSelection | undefined,
  snapshots: StorageSnapshots,
  kind: StorageKind
): string | undefined => {
  if (selection === undefined || selection.kind === "cookies") {
    return undefined;
  }
  const entries = kind === "local" ? snapshots.local : snapshots.session;
  return entries[selection.key];
};

export const cookieDetailDraft = (
  draft: StorageDraft | undefined,
  selectedCookie: BrowserCookie | undefined
) => {
  if (draft?.kind === "cookies") {
    return draft;
  }
  if (selectedCookie === undefined) {
    return;
  }
  return cookieDraftFromCookie(selectedCookie);
};
