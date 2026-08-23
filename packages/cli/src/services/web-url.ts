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
