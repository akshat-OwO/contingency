import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";

import {
  makeDocsSiteRoutes,
  resolveDocsSiteRoot,
} from "../../src/routes/docs-site.ts";

const origin = "http://127.0.0.1:7777";

const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), prefix))),
    (owned) => Effect.promise(() => rm(owned, { force: true, recursive: true }))
  );

/** The docs routes beside the Workspace's SPA catch-all, as the server mounts them. */
const serving = (docsRoot: string, webRoot: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        Layer.mergeAll(
          makeDocsSiteRoutes(docsRoot),
          HttpStaticServer.layer({ root: webRoot, spa: true })
        ).pipe(
          Layer.provide(NodeHttpPlatform.layer),
          Layer.provideMerge(NodeServices.layer)
        ),
        { disableLogger: true }
      )
    ),
    (owned) => Effect.promise(() => owned.dispose())
  ).pipe(
    Effect.map(
      (web) => (target: string) =>
        Effect.promise(() =>
          web.handler(
            new Request(`${origin}${target}`, {
              headers: { accept: "text/html" },
              redirect: "manual",
            })
          )
        )
    )
  );

it("finds the site beside the bundle and in a source checkout", () => {
  expect(resolveDocsSiteRoot("/repo/packages/cli/dist")).toBe(
    "/repo/packages/cli/dist/docs-site"
  );
  expect(resolveDocsSiteRoot("/repo/packages/cli/src/routes")).toBe(
    "/repo/apps/docs/dist"
  );
});

it.effect("serves the docs site under /docs ahead of the Workspace's SPA", () =>
  Effect.gen(function* docsSite() {
    const docsRoot = yield* temporaryDirectory("docs-site-");
    const webRoot = yield* temporaryDirectory("web-");
    yield* Effect.promise(async () => {
      await mkdir(path.join(docsRoot, "teach"));
      await writeFile(
        path.join(docsRoot, "teach", "index.html"),
        "<h1>Teach a journey</h1>"
      );
      await writeFile(path.join(docsRoot, "teach.md"), "# Teach a journey");
      await writeFile(path.join(docsRoot, "404.html"), "<h1>Not found</h1>");
      await writeFile(path.join(webRoot, "index.html"), "<h1>Workspace</h1>");
    });
    const request = yield* serving(docsRoot, webRoot);

    for (const home of ["/docs", "/docs/"]) {
      const redirect = yield* request(home);
      expect(redirect.status, home).toBe(302);
      expect(redirect.headers.get("location"), home).toBe(
        "/docs/getting-started"
      );
    }

    const page = yield* request("/docs/teach");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(yield* Effect.promise(() => page.text())).toBe(
      "<h1>Teach a journey</h1>"
    );

    const markdown = yield* request("/docs/teach.md");
    expect(markdown.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );

    // An unknown page gets the site's own 404, never the Workspace SPA.
    const missing = yield* request("/docs/no-such-topic");
    expect(missing.status).toBe(404);
    expect(yield* Effect.promise(() => missing.text())).toBe(
      "<h1>Not found</h1>"
    );

    const workspace = yield* request("/flows");
    expect(yield* Effect.promise(() => workspace.text())).toBe(
      "<h1>Workspace</h1>"
    );
  }).pipe(Effect.scoped)
);

it.effect("explains an unbuilt docs site instead of serving nothing", () =>
  Effect.gen(function* unbuilt() {
    const webRoot = yield* temporaryDirectory("web-");
    const request = yield* serving(path.join(webRoot, "missing"), webRoot);
    const missing = yield* request("/docs/getting-started");
    expect(missing.status).toBe(404);
    expect(yield* Effect.promise(() => missing.text())).toContain(
      "vp run --filter @contingency/docs build"
    );
  }).pipe(Effect.scoped)
);
