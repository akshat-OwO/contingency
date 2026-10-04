import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { DEMO_HOST, DemoSite } from "./demo-site.ts";
import type { DemoSiteService } from "./demo-site.ts";
import { createTrackedServer } from "./http-server.ts";

/** Built output keeps the store under `dist/demo`; a source checkout reads the package. */
export const resolveDemoRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "demo", "ridgeline")
    : path.resolve(moduleDirectory, "../../demo/ridgeline");

/**
 * Every served file, named explicitly. Nothing outside this list is reachable,
 * so the demo server can never become a general file server.
 */
const DEMO_FILES = {
  "app.js": "text/javascript; charset=utf-8",
  "cart.html": "text/html; charset=utf-8",
  "index.html": "text/html; charset=utf-8",
  "orders.html": "text/html; charset=utf-8",
  "return.html": "text/html; charset=utf-8",
  "signin.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
} as const satisfies Readonly<Record<string, string>>;

type DemoFile = keyof typeof DEMO_FILES;

const isDemoFile = (name: string): name is DemoFile =>
  Object.hasOwn(DEMO_FILES, name);

const fileForPath = (pathname: string): DemoFile | undefined => {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  return isDemoFile(name) ? name : undefined;
};

/**
 * A request is served only under the demo hostname and this server's port.
 * A loopback literal or any other name is refused, so a rebinding page cannot
 * read the store under a name it controls.
 */
const servesHost = (hostHeader: string | undefined, port: number): boolean =>
  hostHeader?.toLowerCase() === `${DEMO_HOST}:${port}`;

const readDemoFiles = Effect.fnUntraced(function* readFiles(root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = new Map<string, string>();
  for (const name of Object.keys(DEMO_FILES).filter(isDemoFile)) {
    files.set(
      name,
      yield* fileSystem.readFileString(path.join(root, name)).pipe(Effect.orDie)
    );
  }
  return files;
});

const demoApp = (files: ReadonlyMap<string, string>, port: number) =>
  Effect.gen(function* serveDemoFile() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!servesHost(request.headers.host, port)) {
      return HttpServerResponse.text("Unknown host.", { status: 421 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return HttpServerResponse.text("Method not allowed.", { status: 405 });
    }
    const { pathname } = new URL(request.url, `http://${DEMO_HOST}`);
    const name = fileForPath(pathname);
    const body = name === undefined ? undefined : files.get(name);
    if (name === undefined || body === undefined) {
      return HttpServerResponse.text("Not found.", { status: 404 });
    }
    return HttpServerResponse.text(body, {
      contentType: DEMO_FILES[name],
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

/**
 * Bind the demo store on an available loopback port and provide its origin.
 * The port is chosen by the bind itself, never probed and released first.
 */
export const makeDemoSiteLayer = (
  options: { readonly root?: string } = {}
): Layer.Layer<DemoSiteService, never, FileSystem.FileSystem> =>
  Layer.effect(
    DemoSite,
    Effect.gen(function* startDemoSite() {
      const files = yield* readDemoFiles(
        options.root ?? resolveDemoRoot(import.meta.dirname)
      );
      const server = yield* Layer.build(
        NodeHttpServer.layerServer(createTrackedServer, {
          host: "127.0.0.1",
          port: 0,
        })
      ).pipe(Effect.orDie);
      const { address } = Context.get(server, HttpServer.HttpServer);
      if (address._tag === "UnixPathAddress") {
        return yield* Effect.die(
          new Error("The demo store must listen on a TCP port.")
        );
      }
      yield* Layer.build(
        HttpServer.serve()(demoApp(files, address.port)).pipe(
          Layer.provide(Layer.succeedContext(server))
        )
      );
      return { origin: `http://${DEMO_HOST}:${address.port}` };
    })
  );
