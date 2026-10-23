import { randomUUID } from "node:crypto";
import path from "node:path";

import { Clock, Effect, FileSystem, Schema } from "effect";
import { constUndefined } from "effect/Function";

import { LOCAL_SYSTEM_ONE_RELEASE } from "./local-system-one-release.ts";
import {
  localSystemOneError,
  LocalSystemOneError,
} from "./local-system-one.ts";
import type { LocalSystemOneState } from "./local-system-one.ts";

const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const GithubCommits = Schema.Array(Schema.Struct({ sha: Commit }));
const NevCommits = Schema.Array(Schema.Struct({ id: Commit }));
const Cache = Schema.Struct({
  checkedAt: Schema.Number,
  kev: Schema.Array(Commit),
  kevCurrent: Commit,
  nev: Schema.Array(Commit),
  nevCurrent: Commit,
});
export type LocalSystemOneUpdates = typeof Cache.Type;
export const LOCAL_SYSTEM_ONE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const json = (url: string) =>
  Effect.tryPromise({
    catch: localSystemOneError,
    try: async (signal) => {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "contingency" },
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Update check returned HTTP ${response.status} for ${url}.`
        );
      }
      const body: unknown = await response.json();
      return body;
    },
  });

/** Walk newest-first history only as far as the installed revision. */
const newer = <A>(
  current: string,
  page: (page: number) => Effect.Effect<readonly A[], LocalSystemOneError>,
  id: (entry: A) => string
) =>
  Effect.gen(function* newerRevisions() {
    const revisions: string[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const entries = yield* page(index);
      for (const entry of entries) {
        const revision = id(entry);
        if (revision === current) {
          return revisions;
        }
        revisions.push(revision);
      }
      if (entries.length < 100) {
        break;
      }
    }
    return yield* new LocalSystemOneError({
      message: `Installed revision ${current} was not found in upstream history; no update choices were inferred.`,
    });
  });

export const checkLocalSystemOneUpdates = (
  state: LocalSystemOneState,
  request: typeof json = json
) =>
  Effect.gen(function* checkUpdates() {
    const kev = yield* newer(
      state.current.kevCommit,
      (page) =>
        request(
          `https://api.github.com/repos/jaredpalmer/kev/commits?sha=main&per_page=100&page=${page}`
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GithubCommits)),
          Effect.mapError(localSystemOneError)
        ),
      (entry) => entry.sha
    );
    // The HF commits API returns the complete history, newest first.
    const history = yield* request(
      `https://huggingface.co/api/models/${LOCAL_SYSTEM_ONE_RELEASE.models.nev.id}/commits/main`
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(NevCommits)),
      Effect.mapError(localSystemOneError)
    );
    const position = history.findIndex(
      (entry) => entry.id === state.current.nevRevision
    );
    if (position === -1) {
      return yield* new LocalSystemOneError({
        message: "Installed Nev revision was not found in upstream history.",
      });
    }
    return {
      checkedAt: yield* Clock.currentTimeMillis,
      kev,
      kevCurrent: state.current.kevCommit,
      nev: history.slice(0, position).map((entry) => entry.id),
      nevCurrent: state.current.nevRevision,
    } satisfies LocalSystemOneUpdates;
  }).pipe(Effect.timeout("30 seconds"), Effect.mapError(localSystemOneError));

export const readLocalSystemOneUpdateCache = (
  root: string,
  state: LocalSystemOneState
) =>
  Effect.gen(function* readCache() {
    const fs = yield* FileSystem.FileSystem;
    const cached = yield* fs
      .readFileString(path.join(root, "updates.json"))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cache)))
      );
    return cached.kevCurrent === state.current.kevCommit &&
      cached.nevCurrent === state.current.nevRevision
      ? cached
      : undefined;
  }).pipe(Effect.orElseSucceed(constUndefined));

export const writeLocalSystemOneUpdateCache = (
  root: string,
  cache: LocalSystemOneUpdates
) =>
  Effect.gen(function* writeCache() {
    const fs = yield* FileSystem.FileSystem;
    // Never recreate the directory if remove raced a background check.
    if (!(yield* fs.exists(root))) {
      return;
    }
    const temporary = path.join(root, `updates-${randomUUID()}.tmp`);
    yield* Effect.acquireRelease(Effect.succeed(temporary), (file) =>
      fs.remove(file, { force: true }).pipe(Effect.ignore)
    );
    yield* fs.writeFileString(temporary, JSON.stringify(cache), {
      flag: "wx",
      mode: 0o600,
    });
    yield* fs.rename(temporary, path.join(root, "updates.json"));
  }).pipe(Effect.scoped, Effect.mapError(localSystemOneError));

/** No network on the startup path; call this in a background fiber. */
export const refreshLocalSystemOneUpdateCache = (
  root: string,
  state: LocalSystemOneState
) =>
  Effect.gen(function* refreshCache() {
    const cached = yield* readLocalSystemOneUpdateCache(root, state);
    if (
      cached !== undefined &&
      (yield* Clock.currentTimeMillis) - cached.checkedAt <
        LOCAL_SYSTEM_ONE_CHECK_INTERVAL_MS
    ) {
      return;
    }
    yield* writeLocalSystemOneUpdateCache(
      root,
      yield* checkLocalSystemOneUpdates(state)
    );
  });

export const localSystemOneUpdateNotice = (
  cache: LocalSystemOneUpdates | undefined
) =>
  cache !== undefined && (cache.kev.length > 0 || cache.nev.length > 0)
    ? "Local System One update available. Run contingency system-one update to review Kev and Nev versions."
    : undefined;
