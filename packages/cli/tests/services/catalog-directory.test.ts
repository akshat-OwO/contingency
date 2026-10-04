import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";

import { resolveCatalogDirectory } from "../../src/services/catalog-directory.ts";

const withDirectories = <A, E>(
  body: (input: {
    readonly fallback: string;
    readonly home: string;
    readonly project: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* prepareDirectories() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-directory-",
    });
    const project = path.join(root, "project");
    const fallback = path.join(root, "onboarding");
    const home = path.join(root, "home");
    for (const directory of [project, fallback, home]) {
      yield* fileSystem.makeDirectory(directory);
    }
    return yield* body({ fallback, home, project });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "reports permission errors without selecting the fallback catalog",
  () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      method: "stat",
      module: "FileSystem",
      pathOrDescriptor: "/work/project",
    });
    return resolveCatalogDirectory({
      agent: "codex",
      cwd: "/work/project",
      env: {},
      fallbackDirectory: "/work/onboarding",
      home: "/home/user",
    }).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toBe(denied)),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ stat: () => Effect.fail(denied) })
      )
    );
  }
);

it.effect("uses Claude's reported project directory", () =>
  withDirectories(({ fallback, home, project }) =>
    Effect.gen(function* claudeProject() {
      const choice = yield* resolveCatalogDirectory({
        agent: "claude",
        cwd: "/",
        env: { CLAUDE_PROJECT_DIR: project },
        fallbackDirectory: fallback,
        home,
      });
      expect(choice).toEqual({
        fallback: undefined,
        root: path.join(project, ".contingency"),
      });
    })
  )
);

it.effect("never lets an inherited Claude variable redirect Codex", () =>
  withDirectories(({ fallback, home, project }) =>
    Effect.gen(function* codexProject() {
      const choice = yield* resolveCatalogDirectory({
        agent: "codex",
        cwd: project,
        env: { CLAUDE_PROJECT_DIR: fallback },
        fallbackDirectory: fallback,
        home,
      });
      expect(choice.root).toBe(path.join(project, ".contingency"));
      expect(choice.fallback).toBeUndefined();
    })
  )
);

it.effect("creates nothing to choose a fresh project's catalog", () =>
  withDirectories(({ fallback, home, project }) =>
    Effect.gen(function* freshProject() {
      const fileSystem = yield* FileSystem.FileSystem;
      const choice = yield* resolveCatalogDirectory({
        agent: "codex",
        cwd: project,
        env: {},
        fallbackDirectory: fallback,
        home,
      });
      expect(choice.root).toBe(path.join(project, ".contingency"));
      // Discovery is separate from catalog access: the catalog appears when
      // work is first saved there.
      expect(yield* fileSystem.exists(choice.root)).toBe(false);
    })
  )
);

it.effect(
  "falls back, and says why, only without a usable project directory",
  () =>
    withDirectories(({ fallback, home, project }) =>
      Effect.gen(function* fallbackOnly() {
        for (const cwd of ["/", home, path.join(project, "missing")]) {
          const choice = yield* resolveCatalogDirectory({
            agent: "codex",
            cwd,
            env: {},
            fallbackDirectory: fallback,
            home,
          });
          expect(choice.root).toBe(path.join(fallback, ".contingency"));
          expect(choice.fallback?.directory).toBe(fallback);
          expect(choice.fallback?.reason).toContain(
            "No usable current project directory"
          );
        }
      })
    )
);

it.effect("keeps direct use and explicit roots unchanged", () =>
  withDirectories(({ fallback, home, project }) =>
    Effect.gen(function* explicitRoots() {
      const direct = yield* resolveCatalogDirectory({
        agent: undefined,
        cwd: project,
        env: {},
        fallbackDirectory: undefined,
        home,
      });
      expect(direct.root).toBe(path.join(project, ".contingency"));
      const configured = yield* resolveCatalogDirectory({
        agent: "claude",
        cwd: "/",
        env: { CONTINGENCY_CATALOG_ROOT: path.join(project, "catalog") },
        fallbackDirectory: fallback,
        home,
      });
      expect(configured).toEqual({
        fallback: undefined,
        root: path.join(project, "catalog"),
      });
    })
  )
);
