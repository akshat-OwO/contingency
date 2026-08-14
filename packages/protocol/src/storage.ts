import { Schema } from "effect";

import { BrowserTabId, SessionId } from "./browser-identifiers.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const StorageKind = Schema.Literals(["cookies", "local", "session"]);
export type StorageKind = typeof StorageKind.Type;

export const CookieSameSite = Schema.Literals(["Strict", "Lax", "None"]);
export type CookieSameSite = typeof CookieSameSite.Type;
export const isCookieSameSite = Schema.is(CookieSameSite);

export const BrowserCookie = Schema.Struct({
  domain: nonEmptyString,
  expires: Schema.Finite,
  httpOnly: Schema.Boolean,
  name: Schema.String,
  path: nonEmptyString,
  sameSite: Schema.optional(CookieSameSite),
  secure: Schema.Boolean,
  session: Schema.Boolean,
  size: Schema.Int,
  value: Schema.String,
});
export type BrowserCookie = typeof BrowserCookie.Type;

export const BrowserCookieWrite = Schema.Struct({
  domain: nonEmptyString,
  expires: Schema.optional(Schema.Finite),
  httpOnly: Schema.Boolean,
  name: nonEmptyString,
  path: nonEmptyString,
  sameSite: Schema.optional(CookieSameSite),
  secure: Schema.Boolean,
  value: Schema.String,
});
export type BrowserCookieWrite = typeof BrowserCookieWrite.Type;

export const BrowserCookieIdentity = Schema.Struct({
  domain: nonEmptyString,
  name: Schema.String,
  path: nonEmptyString,
});
export type BrowserCookieIdentity = typeof BrowserCookieIdentity.Type;

export const BrowserWebStorageEntries = Schema.Record(
  Schema.String,
  Schema.String
);
export type BrowserWebStorageEntries = typeof BrowserWebStorageEntries.Type;

export const BrowserStorageCookiesSnapshot = Schema.Struct({
  cookies: Schema.Array(BrowserCookie),
  kind: Schema.Literal("cookies"),
  tabId: BrowserTabId,
});
export type BrowserStorageCookiesSnapshot =
  typeof BrowserStorageCookiesSnapshot.Type;

export const BrowserStorageWebSnapshot = Schema.Struct({
  entries: BrowserWebStorageEntries,
  kind: Schema.Literals(["local", "session"]),
  tabId: BrowserTabId,
});
export type BrowserStorageWebSnapshot = typeof BrowserStorageWebSnapshot.Type;

export const BrowserStorageSnapshot = Schema.Union([
  BrowserStorageCookiesSnapshot,
  BrowserStorageWebSnapshot,
]);
export type BrowserStorageSnapshot = typeof BrowserStorageSnapshot.Type;

export const BrowserStorageSetPayload = Schema.Union([
  Schema.Struct({
    cookie: BrowserCookieWrite,
    kind: Schema.Literal("cookies"),
    sessionId: SessionId,
    tabId: BrowserTabId,
  }),
  Schema.Struct({
    key: nonEmptyString,
    kind: Schema.Literals(["local", "session"]),
    sessionId: SessionId,
    tabId: BrowserTabId,
    value: Schema.String,
  }),
]);
export type BrowserStorageSetPayload = typeof BrowserStorageSetPayload.Type;

export const BrowserStorageDeletePayload = Schema.Union([
  Schema.Struct({
    domain: nonEmptyString,
    kind: Schema.Literal("cookies"),
    name: Schema.String,
    path: nonEmptyString,
    sessionId: SessionId,
    tabId: BrowserTabId,
  }),
  Schema.Struct({
    key: nonEmptyString,
    kind: Schema.Literals(["local", "session"]),
    sessionId: SessionId,
    tabId: BrowserTabId,
  }),
]);
export type BrowserStorageDeletePayload =
  typeof BrowserStorageDeletePayload.Type;

const HTTP_ORIGIN_PATTERN =
  /^(?<scheme>https?):\/\/(?<host>\[[^\]]+\]|[^/?#:]+)(?::(?<port>\d+))?/u;

const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

const asciiLowerCase = (value: string): string =>
  value.replaceAll(/[A-Z]/gu, (letter) => {
    const index = ASCII_UPPERCASE.indexOf(letter);
    return index === -1 ? letter : (ASCII_LOWERCASE[index] ?? letter);
  });

export const httpOriginFromUrl = (
  url: string
): { readonly host: string; readonly origin: string } | undefined => {
  const groups = HTTP_ORIGIN_PATTERN.exec(url)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const { host, port, scheme } = groups;
  if (scheme === undefined || host === undefined) {
    return undefined;
  }
  const hostname = host.startsWith("[") ? host.slice(1, -1) : host;
  const origin =
    port === undefined ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
  return { host: hostname, origin };
};

export const cookieDomainMatchesHost = (
  cookieDomain: string,
  host: string
): boolean => {
  const domain = asciiLowerCase(cookieDomain);
  const domainName = domain.replace(/^\./u, "");
  const hostname = asciiLowerCase(host);
  if (hostname === domainName) {
    return true;
  }
  if (!domain.startsWith(".") || domainName.split(".").length < 2) {
    return false;
  }
  return hostname.endsWith(`.${domainName}`);
};

export const filterCookiesForOriginHost = (
  cookies: readonly BrowserCookie[],
  host: string
): readonly BrowserCookie[] =>
  cookies.filter((cookie) => cookieDomainMatchesHost(cookie.domain, host));

export const compareCookieIdentities = (
  left: BrowserCookieIdentity,
  right: BrowserCookieIdentity
): number => {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  const byDomain = left.domain.localeCompare(right.domain);
  if (byDomain !== 0) {
    return byDomain;
  }
  return left.path.localeCompare(right.path);
};

export const sortCookiesByIdentity = (
  cookies: readonly BrowserCookie[]
): readonly BrowserCookie[] => cookies.toSorted(compareCookieIdentities);

const cookieRecordsEqual = (
  left: BrowserCookie,
  right: BrowserCookie
): boolean =>
  left.name === right.name &&
  left.domain === right.domain &&
  left.path === right.path &&
  left.value === right.value &&
  left.httpOnly === right.httpOnly &&
  left.secure === right.secure &&
  left.sameSite === right.sameSite &&
  left.expires === right.expires &&
  left.session === right.session &&
  left.size === right.size;

export const cookiesEquivalent = (
  left: readonly BrowserCookie[],
  right: readonly BrowserCookie[]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (const [index, cookie] of left.entries()) {
    const other = right[index];
    if (other === undefined || !cookieRecordsEqual(cookie, other)) {
      return false;
    }
  }
  return true;
};

export const cookieIdentitiesEqual = (
  left: BrowserCookieIdentity,
  right: BrowserCookieIdentity
): boolean =>
  left.name === right.name &&
  left.domain === right.domain &&
  left.path === right.path;

export const cookieIdentityOf = (
  cookie: BrowserCookieIdentity
): BrowserCookieIdentity => ({
  domain: cookie.domain,
  name: cookie.name,
  path: cookie.path,
});

export const STORAGE_LOCKED_MESSAGE =
  "Storage is locked while the Recording is in progress.";
