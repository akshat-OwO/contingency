import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
} from "effect";

import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  FOOTAGE_MANIFEST_FILE,
  FOOTAGE_VIDEO_FILE,
} from "../../src/services/run-footage.ts";
import {
  RUN_VIDEO_FILE,
  RunVideoRenderer,
  RunVideoRendererLive,
} from "../../src/services/run-video-renderer.ts";

const FALLBACK_FILE = "run-video-fallback.json";
const LOCK_FILE = "run-video.lock";

/** Condensing never starts in these tests: the footage cannot be promoted. */
const UnusedBrowser = Layer.mock(CreateBrowser, {});

const refuseFootagePromote = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* wrapRename() {
    const inner = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...inner,
      rename: (oldPath, newPath) =>
        path.basename(oldPath) === FOOTAGE_VIDEO_FILE &&
        path.basename(newPath) === RUN_VIDEO_FILE
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                description: "could not promote the footage",
                method: "rename",
                module: "FileSystem",
                pathOrDescriptor: oldPath,
              })
            )
          : inner.rename(oldPath, newPath),
    });
  })
).pipe(Layer.provide(NodeServices.layer));

const seedUnreadableFootage = (directory: string) =>
  Effect.gen(function* writeBrokenFootage() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      path.join(directory, FOOTAGE_VIDEO_FILE),
      "real-time footage"
    );
    yield* fileSystem.writeFileString(
      path.join(directory, FOOTAGE_MANIFEST_FILE),
      "not json"
    );
  });

it.live("promotes footage to the Run video when condensing cannot start", () =>
  Effect.gen(function* promoteFootage() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-video-fallback-",
    });
    yield* seedUnreadableFootage(directory);
    const renderer = yield* RunVideoRenderer;
    expect(yield* renderer.status(directory)).toEqual({
      state: "preparing",
    });
    yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
    expect(yield* renderer.status(directory)).toEqual({
      condensed: false,
      reason:
        "The footage manifest could not be read: The footage manifest is not valid JSON.",
      state: "ready",
    });
    expect(
      yield* fileSystem.readFileString(path.join(directory, RUN_VIDEO_FILE))
    ).toBe("real-time footage");
    expect(
      yield* fileSystem.exists(path.join(directory, FOOTAGE_VIDEO_FILE))
    ).toBe(false);
    expect(
      yield* fileSystem.exists(path.join(directory, FOOTAGE_MANIFEST_FILE))
    ).toBe(false);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RunVideoRendererLive.pipe(
        Layer.provide(UnusedBrowser),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  )
);

it.live("keeps footage when promoting it to the Run video fails", () =>
  Effect.gen(function* keepFootageAfterFailedPromote() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-video-rename-",
    });
    yield* seedUnreadableFootage(directory);
    const renderer = yield* RunVideoRenderer;
    expect(yield* renderer.status(directory)).toEqual({
      state: "preparing",
    });
    yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
    expect(
      yield* fileSystem.readFileString(path.join(directory, FOOTAGE_VIDEO_FILE))
    ).toBe("real-time footage");
    expect(
      yield* fileSystem.exists(path.join(directory, FOOTAGE_MANIFEST_FILE))
    ).toBe(true);
    expect(yield* fileSystem.exists(path.join(directory, RUN_VIDEO_FILE))).toBe(
      false
    );
    expect(yield* fileSystem.exists(path.join(directory, FALLBACK_FILE))).toBe(
      false
    );
    expect(yield* renderer.status(directory)).toEqual({
      state: "preparing",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RunVideoRendererLive.pipe(
        Layer.provide(UnusedBrowser),
        Layer.provide(refuseFootagePromote)
      ).pipe(Layer.provideMerge(refuseFootagePromote))
    )
  )
);

/** Holds the manifest's removal until `gate` opens. */
const holdManifestRemoval = (
  gate: Deferred.Deferred<true>,
  entered: Deferred.Deferred<true>
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* wrapRemove() {
      const inner = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...inner,
        remove: (file, options) =>
          path.basename(file) === FOOTAGE_MANIFEST_FILE
            ? Deferred.succeed(entered, true).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(inner.remove(file, options))
              )
            : inner.remove(file, options),
      });
    })
  ).pipe(Layer.provide(NodeServices.layer));

it.live(
  "reports preparing until the footage behind the Run video is removed",
  () =>
    Effect.gen(function* holdCleanup() {
      const gate = yield* Deferred.make<true>();
      const entered = yield* Deferred.make<true>();
      const fileSystemLive = holdManifestRemoval(gate, entered);
      yield* Effect.gen(function* awaitCleanup() {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "contingency-run-video-cleanup-",
        });
        yield* seedUnreadableFootage(directory);
        const renderer = yield* RunVideoRenderer;
        expect(yield* renderer.status(directory)).toEqual({
          state: "preparing",
        });
        yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
        expect(
          yield* fileSystem.exists(path.join(directory, RUN_VIDEO_FILE))
        ).toBe(true);
        // The video is in place, but its footage is not yet removed.
        expect(yield* renderer.status(directory)).toEqual({
          state: "preparing",
        });
        yield* Deferred.succeed(gate, true);
        yield* renderer.settled(directory).pipe(Effect.timeout("10 seconds"));
        expect(yield* renderer.status(directory)).toEqual({
          condensed: false,
          reason:
            "The footage manifest could not be read: The footage manifest is not valid JSON.",
          state: "ready",
        });
        expect(
          yield* fileSystem.exists(path.join(directory, FOOTAGE_MANIFEST_FILE))
        ).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          RunVideoRendererLive.pipe(
            Layer.provide(UnusedBrowser),
            Layer.provideMerge(fileSystemLive)
          )
        )
      );
    })
);

it.live("settles an in-flight render only after footage cleanup", () =>
  Effect.gen(function* awaitInFlightCleanup() {
    const gate = yield* Deferred.make<true>();
    const entered = yield* Deferred.make<true>();
    yield* Effect.gen(function* settleHeldRender() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-video-settled-",
      });
      yield* seedUnreadableFootage(directory);
      const renderer = yield* RunVideoRenderer;
      yield* renderer.render(directory);
      yield* Deferred.await(entered).pipe(Effect.timeout("30 seconds"));
      expect(
        yield* fileSystem.exists(path.join(directory, RUN_VIDEO_FILE))
      ).toBe(true);
      const waiting = yield* renderer
        .settled(directory)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const alsoWaiting = yield* renderer
        .settled(path.join(directory, "."))
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(waiting.pollUnsafe()).toBeUndefined();
      expect(alsoWaiting.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, true);
      yield* Effect.all([Fiber.join(waiting), Fiber.join(alsoWaiting)]).pipe(
        Effect.timeout("30 seconds")
      );
      expect(yield* renderer.status(directory)).toMatchObject({
        state: "ready",
      });
      for (const file of [
        FOOTAGE_MANIFEST_FILE,
        FOOTAGE_VIDEO_FILE,
        LOCK_FILE,
      ]) {
        expect(yield* fileSystem.exists(path.join(directory, file))).toBe(
          false
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RunVideoRendererLive.pipe(
          Layer.provide(UnusedBrowser),
          Layer.provideMerge(holdManifestRemoval(gate, entered))
        )
      )
    );
  })
);

it.live("settles an already available video without starting a render", () =>
  Effect.gen(function* settleAvailableVideo() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-video-ready-",
    });
    yield* fileSystem.writeFileString(
      path.join(directory, RUN_VIDEO_FILE),
      "video"
    );
    const renderer = yield* RunVideoRenderer;
    yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
    yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
    expect(yield* renderer.status(directory)).toEqual({
      condensed: true,
      state: "ready",
    });
    expect(yield* fileSystem.exists(path.join(directory, LOCK_FILE))).toBe(
      false
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RunVideoRendererLive.pipe(
        Layer.provide(UnusedBrowser),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  )
);

it.live("settles a directory whose Run has not finished capture", () =>
  Effect.gen(function* settleUnstartedVideo() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-video-unstarted-",
    });
    yield* fileSystem.writeFileString(
      path.join(directory, FOOTAGE_VIDEO_FILE),
      "capturing"
    );
    const renderer = yield* RunVideoRenderer;
    yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
    expect(yield* renderer.status(directory)).toEqual({ state: "unavailable" });
    expect(
      yield* fileSystem.readFileString(path.join(directory, FOOTAGE_VIDEO_FILE))
    ).toBe("capturing");
    expect(yield* fileSystem.exists(path.join(directory, LOCK_FILE))).toBe(
      false
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RunVideoRendererLive.pipe(
        Layer.provide(UnusedBrowser),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  )
);

it.live.each([false, true])(
  "settles dead-process footage with an existing video: %s",
  (videoExists) =>
    Effect.gen(function* settleRecoveredVideo() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-video-recovered-",
      });
      yield* seedUnreadableFootage(directory);
      if (videoExists) {
        yield* fileSystem.writeFileString(
          path.join(directory, RUN_VIDEO_FILE),
          "video"
        );
      }
      yield* fileSystem.writeFileString(
        path.join(directory, LOCK_FILE),
        "2147483647"
      );
      const renderer = yield* RunVideoRenderer;
      yield* renderer.settled(directory).pipe(Effect.timeout("30 seconds"));
      expect(yield* renderer.status(directory)).toMatchObject({
        condensed: videoExists,
        state: "ready",
      });
      for (const file of [
        FOOTAGE_MANIFEST_FILE,
        FOOTAGE_VIDEO_FILE,
        LOCK_FILE,
      ]) {
        expect(yield* fileSystem.exists(path.join(directory, file))).toBe(
          false
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        RunVideoRendererLive.pipe(
          Layer.provide(UnusedBrowser),
          Layer.provideMerge(NodeServices.layer)
        )
      )
    )
);
