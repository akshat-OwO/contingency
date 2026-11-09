/**
 * Site corpus proxy: records real sites once, then replays them offline.
 *
 * Chromium reaches every site through this proxy (`--proxy-server`). For
 * HTTPS it answers CONNECT and terminates TLS itself with a throwaway
 * self-signed certificate, which the browser accepts only because the replay
 * launch also passes `--ignore-certificate-errors`. Record mode forwards each
 * request upstream and keeps the response; replay mode answers from the
 * recording alone and never opens a network connection, so a replayed site is
 * deterministic across machines and over time.
 */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, FileSystem } from "effect";

const executeFile = promisify(execFile);
const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

export interface RecordedExchange {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Base64, already decoded from any content-encoding. */
  readonly body: string;
}

/** Headers that describe one hop or one encoding, never the resource. */
const HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "alt-svc",
  "strict-transport-security",
]);

/** Exact URL first; then the same path, since sites add cache-busting queries. */
const exactKey = (method: string, url: string) => `${method} ${url}`;
const pathKey = (method: string, url: string) => {
  const parsed = new URL(url);
  return `${method} ${parsed.origin}${parsed.pathname}`;
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/** Replay sends each recorded cookie as its own header line. */
const replayHeaders = (
  recorded: Readonly<Record<string, string>>
): OutgoingHttpHeaders => {
  const cookies = recorded["set-cookie"];
  return cookies === undefined
    ? recorded
    : { ...recorded, "set-cookie": cookies.split("\n") };
};

export interface SiteCorpusProxy {
  /** Chromium switches that route a launch through this proxy. */
  readonly launchArgs: readonly string[];
  /** Every exchange recorded so far (record mode). */
  readonly recorded: () => readonly RecordedExchange[];
  /** Requests replay could not answer, in order (replay mode). */
  readonly misses: () => readonly string[];
}

export const siteCorpusProxy = (
  input:
    | { readonly mode: "record" }
    | {
        readonly mode: "replay";
        readonly exchanges: readonly RecordedExchange[];
      }
) =>
  Effect.gen(function* startProxy() {
    const fileSystem = yield* FileSystem.FileSystem;
    const keys = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-site-corpus-tls-",
    });
    yield* Effect.tryPromise(() =>
      executeFile("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=contingency-site-corpus",
        "-keyout",
        path.join(keys, "key.pem"),
        "-out",
        path.join(keys, "cert.pem"),
      ])
    );
    const tls = {
      cert: yield* fileSystem.readFileString(path.join(keys, "cert.pem")),
      key: yield* fileSystem.readFileString(path.join(keys, "key.pem")),
    };

    const recorded: RecordedExchange[] = [];
    const misses: string[] = [];
    const index = new Map<string, RecordedExchange>();
    if (input.mode === "replay") {
      for (const exchange of input.exchanges) {
        index.set(exactKey(exchange.method, exchange.url), exchange);
        const loose = pathKey(exchange.method, exchange.url);
        if (!index.has(loose)) {
          index.set(loose, exchange);
        }
      }
    }

    const answer = async (
      request: IncomingMessage,
      response: ServerResponse,
      url: string
    ) => {
      const method = request.method ?? "GET";
      if (input.mode === "replay") {
        const exchange =
          index.get(exactKey(method, url)) ?? index.get(pathKey(method, url));
        if (exchange === undefined) {
          misses.push(exactKey(method, url));
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(exchange.status, replayHeaders(exchange.headers))
          .end(Buffer.from(exchange.body, "base64"));
        return;
      }
      const body = await readBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          !HOP_HEADERS.has(name) &&
          name !== "host" &&
          !name.startsWith("proxy-")
        ) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const init: RequestInit = { headers, method, redirect: "manual" };
      if (method !== "GET" && method !== "HEAD") {
        init.body = body;
      }
      const upstream = await fetch(url, init);
      const payload = Buffer.from(await upstream.arrayBuffer());
      const kept: Record<string, string> = {};
      for (const [name, value] of upstream.headers) {
        if (!HOP_HEADERS.has(name) && name !== "set-cookie") {
          kept[name] = value;
        }
      }
      // Cookies join on newlines, which no header value contains, so replay
      // can split them back into one line each.
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) {
        kept["set-cookie"] = cookies.join("\n");
      }
      recorded.push({
        body: payload.toString("base64"),
        headers: kept,
        method,
        status: upstream.status,
        url,
      });
      response.writeHead(upstream.status, replayHeaders(kept)).end(payload);
    };
    const respond = async (
      scheme: "http" | "https",
      request: IncomingMessage,
      response: ServerResponse
    ) => {
      const url =
        scheme === "http"
          ? (request.url ?? "/")
          : `https://${request.headers.host ?? ""}${request.url ?? "/"}`;
      try {
        await answer(request, response, url);
      } catch {
        // An upstream that fails while recording is a gap in the recording,
        // and replay reports it as a miss.
        if (!response.headersSent) {
          response.writeHead(502);
        }
        response.end();
      }
    };
    const handle =
      (scheme: "http" | "https") =>
      (request: IncomingMessage, response: ServerResponse) => {
        void respond(scheme, request, response);
      };

    const secure = createHttpsServer(tls, handle("https"));
    const server = createHttpServer(handle("http"));
    server.on("connect", (_request, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      secure.emit("connection", socket);
    });
    const port = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        return isTcpAddress(address) ? address.port : 0;
      }),
      () =>
        Effect.promise(async () => {
          server.closeAllConnections();
          secure.closeAllConnections();
          server.close();
          await once(server, "close");
        })
    );

    const proxy: SiteCorpusProxy = {
      launchArgs: [
        `--proxy-server=http://127.0.0.1:${String(port)}`,
        "--ignore-certificate-errors",
        // A replayed site must not reach the network around the proxy.
        "--disable-quic",
      ],
      misses: () => [...misses],
      recorded: () => [...recorded],
    };
    return proxy;
  });
