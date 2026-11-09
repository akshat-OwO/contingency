/**
 * The site corpus on disk: one directory per site under
 * `SITE_CORPUS_ROOT` (not `CONTINGENCY_*`: the integration setup clears
 * those so product settings cannot leak in), holding `site.json` and the gzipped exchanges
 * `exchanges.jsonl.gz`. The corpus is recorded once with `record.ts` and is
 * not committed; CI restores it from cache, and a run without it skips.
 */
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { Effect, FileSystem, Schema } from "effect";

import type { RecordedExchange } from "./proxy.ts";

export const SiteEntry = Schema.Struct({
  category: Schema.String,
  /**
   * A known limitation this site exposes. Replay expects the limitation, so
   * fixing it fails the suite until the entry drops its `gap`.
   */
  gap: Schema.optional(Schema.String),
  id: Schema.String,
  url: Schema.String,
});

const SiteRecord = Schema.Struct({
  ...SiteEntry.fields,
  exchanges: Schema.Int,
  recordedAt: Schema.String,
});

const Exchange = Schema.Struct({
  body: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  method: Schema.String,
  status: Schema.Int,
  url: Schema.String,
});

/** The corpus root, or undefined when this machine has none. */
export const siteCorpusRoot = (): string | undefined => {
  const root = process.env["SITE_CORPUS_ROOT"];
  return root === undefined || root === "" ? undefined : root;
};

export const readSiteList = Effect.gen(function* readSites() {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(
    path.join(import.meta.dirname, "sites.json")
  );
  return yield* Schema.decodeUnknownEffect(Schema.Array(SiteEntry))(
    JSON.parse(text)
  );
});

export const saveSite = (
  root: string,
  site: typeof SiteEntry.Type,
  exchanges: readonly RecordedExchange[]
) =>
  Effect.gen(function* writeSite() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.join(root, site.id);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFile(
      path.join(directory, "exchanges.jsonl.gz"),
      gzipSync(
        exchanges.map((exchange) => `${JSON.stringify(exchange)}\n`).join("")
      )
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "site.json"),
      `${JSON.stringify(
        {
          ...site,
          exchanges: exchanges.length,
          recordedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
  });

/** Every recorded site, in id order, with its exchanges. */
export const loadCorpus = (root: string) =>
  Effect.gen(function* readCorpus() {
    const fileSystem = yield* FileSystem.FileSystem;
    const ids = (yield* fileSystem.readDirectory(root)).toSorted();
    const sites = [];
    for (const id of ids) {
      const directory = path.join(root, id);
      const manifest = path.join(directory, "site.json");
      if (!(yield* fileSystem.exists(manifest))) {
        continue;
      }
      const site = yield* Schema.decodeUnknownEffect(SiteRecord)(
        JSON.parse(yield* fileSystem.readFileString(manifest))
      );
      const lines = gunzipSync(
        yield* fileSystem.readFile(path.join(directory, "exchanges.jsonl.gz"))
      )
        .toString("utf-8")
        .split("\n")
        .filter((line) => line !== "");
      const exchanges = yield* Effect.all(
        lines.map((line) =>
          Schema.decodeUnknownEffect(Exchange)(JSON.parse(line))
        )
      );
      sites.push({ exchanges, site });
    }
    return sites;
  });
