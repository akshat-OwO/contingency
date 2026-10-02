import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";

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

const awaitRenderAttempt = (directory: string) =>
  Effect.gen(function* waitForAttempt() {
    const fileSystem = yield* FileSystem.FileSystem;
    const lock = path.join(directory, LOCK_FILE);
    // Give the forked render a moment to take the lock so a fast finish is
    // not mistaken for a render that never started.
    yield* Effect.sleep("50 millis");
    for (const _attempt of Array.from({ length: 80 })) {
      if (!(yield* fileSystem.exists(lock))) {
        return;
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.fail(
      new Error("The Run video lock was never released.")
    );
  });

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
    yield* awaitRenderAttempt(directory);
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
    yield* awaitRenderAttempt(directory);
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
