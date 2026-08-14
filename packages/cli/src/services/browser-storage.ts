import type { BrowserCookie, BrowserCookieWrite } from "@contingency/protocol";
import { isCookieSameSite } from "@contingency/protocol";

export const normalizeAgentBrowserCookie = (cookie: {
  readonly domain: string;
  readonly expires?: number | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly name: string;
  readonly path: string;
  readonly sameSite?: string | undefined;
  readonly secure?: boolean | undefined;
  readonly session?: boolean | undefined;
  readonly size?: number | undefined;
  readonly value: string;
}): BrowserCookie => {
  const expires = cookie.expires ?? -1;
  const { sameSite } = cookie;
  const normalizedSameSite =
    sameSite !== undefined && isCookieSameSite(sameSite) ? sameSite : undefined;
  return {
    domain: cookie.domain,
    expires,
    httpOnly: cookie.httpOnly ?? false,
    name: cookie.name,
    path: cookie.path,
    ...(normalizedSameSite === undefined
      ? {}
      : { sameSite: normalizedSameSite }),
    secure: cookie.secure ?? false,
    session: cookie.session ?? expires < 0,
    size:
      cookie.size === undefined
        ? cookie.name.length + cookie.value.length
        : Math.trunc(cookie.size),
    value: cookie.value,
  };
};

export const cookieSetArgs = (
  cookie: BrowserCookieWrite
): readonly string[] => {
  const args = [
    "cookies",
    "set",
    cookie.name,
    cookie.value,
    "--domain",
    cookie.domain,
    "--path",
    cookie.path,
  ];
  if (cookie.httpOnly) {
    args.push("--httpOnly");
  }
  if (cookie.secure) {
    args.push("--secure");
  }
  if (cookie.sameSite !== undefined) {
    args.push("--sameSite", cookie.sameSite);
  }
  if (cookie.expires !== undefined && cookie.expires >= 0) {
    args.push("--expires", String(Math.trunc(cookie.expires)));
  }
  return args;
};

export const cookieDeleteArgs = (
  name: string,
  domain: string,
  path: string
): readonly string[] => [
  "cookies",
  "set",
  name,
  "",
  "--domain",
  domain,
  "--path",
  path,
  "--expires",
  "0",
];

export const webStorageGetArgs = (
  kind: "local" | "session"
): readonly string[] => ["storage", kind];

export const webStorageSetArgs = (
  kind: "local" | "session",
  key: string,
  value: string
): readonly string[] => ["storage", kind, "set", key, value];

export const webStorageClearArgs = (
  kind: "local" | "session"
): readonly string[] => ["storage", kind, "clear"];

export const webStorageDeleteScript = (
  kind: "local" | "session",
  key: string
): string =>
  `void ${kind === "local" ? "localStorage" : "sessionStorage"}.removeItem(${JSON.stringify(key)}); ""`;

export const commandIncludesCookiesClear = (
  args: readonly string[]
): boolean => {
  const cookiesIndex = args.indexOf("cookies");
  return cookiesIndex !== -1 && args.includes("clear", cookiesIndex);
};
