/**
 * Records the site corpus: every site in `sites.json`, or those named with
 * `--only a,b`, into `SITE_CORPUS_ROOT`. Recording reaches the live
 * network; replay (site-corpus.integration.test.ts) never does.
 *
 *   SITE_CORPUS_ROOT=~/contingency-site-corpus \
 *     vpx packages/cli/tests/integration/site-corpus/record.ts [--only wikipedia]
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Result } from "effect";
import { chromium } from "playwright-core";

import { readSiteList, saveSite, siteCorpusRoot } from "./corpus.ts";
import { siteCorpusProxy } from "./proxy.ts";

const only = (() => {
  const index = process.argv.indexOf("--only");
  return index === -1
    ? undefined
    : new Set(process.argv[index + 1]?.split(","));
})();

Effect.gen(function* recordCorpus() {
  const root = siteCorpusRoot();
  if (root === undefined) {
    return yield* Effect.die("Set SITE_CORPUS_ROOT to the corpus directory.");
  }
  const sites = (yield* readSiteList).filter(
    (site) => only === undefined || only.has(site.id)
  );
  for (const site of sites) {
    const outcome = yield* Effect.gen(function* recordSite() {
      const proxy = yield* siteCorpusProxy({ mode: "record" });
      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          chromium.launch({ args: [...proxy.launchArgs], headless: true })
        ),
        (opened) => Effect.promise(() => opened.close())
      );
      yield* Effect.tryPromise(async () => {
        const page = await browser.newPage({
          viewport: { height: 800, width: 1280 },
        });
        await page.goto(site.url, { timeout: 45_000, waitUntil: "load" });
        // Lazy content loads as a reader scrolls; idle is the page's own
        // signal that it has fetched what it will fetch.
        // A page that never goes idle (analytics beacons) is recorded as far
        // as it got; replay reports what is missing.
        await page
          .waitForLoadState("networkidle", { timeout: 15_000 })
          .catch(() => null);
        await page.mouse.wheel(0, 2400);
        await page
          .waitForLoadState("networkidle", { timeout: 15_000 })
          .catch(() => null);
      });
      const exchanges = proxy.recorded();
      yield* saveSite(root, site, exchanges);
      return exchanges.length;
    }).pipe(Effect.scoped, Effect.result);
    yield* Effect.log(
      Result.isSuccess(outcome)
        ? `${site.id}: ${String(outcome.success)} exchanges`
        : `${site.id}: failed (${String(outcome.failure)})`
    );
  }
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
