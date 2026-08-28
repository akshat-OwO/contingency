import { Data, Effect, Option } from "effect";

export class WebUrlError extends Data.TaggedError("WebUrlError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface WebUrlOptions {
  readonly devUrl: string;
  readonly host: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly publicUrl: Option.Option<string>;
}

/**
 * A hostname that *is* a loopback address, rather than one that merely looks
 * like one. `isLoopbackHost` is deliberately loose because it classifies a
 * bind address an operator configured; this is load-bearing for an allowlist,
 * where a prefix match would admit `127.0.0.1.evil.com` — a name an attacker
 * can register and rebind, which is exactly what the allowlist exists to
 * refuse. IPv4 shorthand is not a loophole: WHATWG URL normalises
 * `http://127.1` to `127.0.0.1` before this sees it.
 */
const isLoopbackLiteral = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/u.test(hostname);

export const isLoopbackHost = (host: string): boolean =>
  host === "localhost" ||
  host === "::1" ||
  host === "[::1]" ||
  host.startsWith("127.");

const hostForUrl = (host: string): string =>
  host.includes(":") ? `[${host}]` : host;

const originWithHost = (url: URL, host: string): string => {
  const nextUrl = new URL(url.origin);
  nextUrl.hostname = host;
  return nextUrl.origin;
};

const loopbackBrowserHosts = ["127.0.0.1", "localhost", "[::1]"] as const;

export const isAllowedWebSocketOrigin = (
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
): boolean => origin !== undefined && allowedOrigins.has(origin);

/**
 * Whether a request's `Host` may be served.
 *
 * A loopback bind is not on its own a guard: a remote page can point a name it
 * controls at 127.0.0.1 and have the browser send that name as `Host` — DNS
 * rebinding — reaching a server bound to loopback only. What the attacker
 * cannot forge is the name: a rebinding request carries their domain, never a
 * loopback literal and never a configured origin. Requests carrying no `Host`
 * at all are refused, since HTTP/1.1 requires one.
 */
export const isAllowedHost = (
  host: string | undefined,
  allowedOrigins: ReadonlySet<string>
): boolean => {
  if (host === undefined || host.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (isLoopbackLiteral(parsed.hostname)) {
    return true;
  }
  for (const origin of allowedOrigins) {
    if (new URL(origin).host === parsed.host) {
      return true;
    }
  }
  return false;
};

export const resolveAllowedOrigins = (browserUrl: URL): ReadonlySet<string> => {
  const origins = new Set<string>([browserUrl.origin]);
  if (!isLoopbackHost(browserUrl.hostname)) {
    return origins;
  }
  for (const host of loopbackBrowserHosts) {
    origins.add(originWithHost(browserUrl, host));
  }
  return origins;
};

export const resolveBrowserUrl = Effect.fn("resolveBrowserUrl")(
  function* resolveBrowserUrlEffect({
    devUrl,
    host,
    isProduction,
    port,
    publicUrl,
  }: WebUrlOptions) {
    const configuredPublicUrl = Option.getOrUndefined(publicUrl);
    const browserHost = isLoopbackHost(host) ? "127.0.0.1" : host;
    const input =
      configuredPublicUrl ??
      (isProduction ? `http://${hostForUrl(browserHost)}:${port}` : devUrl);
    return yield* Effect.try({
      catch: (cause) =>
        new WebUrlError({
          cause,
          message: `Invalid Contingency web URL: ${input}`,
        }),
      try: () => new URL(input),
    });
  }
);
