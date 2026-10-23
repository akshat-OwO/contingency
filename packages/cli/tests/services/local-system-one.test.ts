import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Result } from "effect";

import { localSystemOneEnvironment } from "../../src/services/local-system-one-live.ts";
import { LOCAL_SYSTEM_ONE_RELEASE } from "../../src/services/local-system-one-release.ts";
import {
  LocalSystemOneError,
  localSystemOneDirectory,
  makeLocalSystemOne,
} from "../../src/services/local-system-one.ts";
import type {
  LocalSystemOneIO,
  LocalSystemOneState,
} from "../../src/services/local-system-one.ts";

const fail = (message: string) =>
  Effect.fail(new LocalSystemOneError({ message }));
const root = "/data/contingency/system-one";
const statePath = path.join(root, "state.json");
const prior: LocalSystemOneState = {
  current: {
    directory: "install-old",
    kevCommit: "a".repeat(40),
    model: "nev",
    modelId: "akshat-OwO/nev-0.8b",
    nevRevision: "b".repeat(40),
  },
  previous: null,
  server: null,
  version: 1,
};

const fixture = (overrides: Partial<LocalSystemOneIO> = {}) => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const events: string[] = [];
  let counter = 0;
  const io: LocalSystemOneIO = {
    arch: "arm64",
    download: (_url, file) =>
      Effect.sync(() => {
        events.push("download");
        files.set(file, "tarball");
      }),
    id: () => {
      counter += 1;
      return String(counter);
    },
    install: () =>
      Effect.sync(() => {
        events.push("install");
      }),
    mkdir: (directory, exclusive) =>
      Effect.suspend(() => {
        if (exclusive && directories.has(directory)) {
          return fail("Installation is locked.");
        }
        directories.add(directory);
        return Effect.void;
      }),
    output: (command, args) =>
      Effect.sync(() => {
        events.push(`${command} ${args.join(" ")}`);
        return command === "uv" && args[0] === "python"
          ? "/usr/bin/python3.13\n"
          : "available";
      }),
    platform: "darwin",
    read: (file) => Effect.sync(() => Option.fromUndefinedOr(files.get(file))),
    remove: (directory) =>
      Effect.sync(() => {
        events.push(`remove ${directory}`);
        for (const key of files.keys()) {
          if (key === directory || key.startsWith(`${directory}/`)) {
            files.delete(key);
          }
        }
        for (const key of directories) {
          if (key === directory || key.startsWith(`${directory}/`)) {
            directories.delete(key);
          }
        }
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        events.push("rename state");
        const content = files.get(from);
        expect(content).toBeDefined();
        if (content !== undefined) {
          files.set(to, content);
        }
        files.delete(from);
      }),
    root,
    sha256: () => Effect.succeed(LOCAL_SYSTEM_ONE_RELEASE.kevSha256),
    smoke: () =>
      Effect.sync(() => {
        events.push("smoke");
      }),
    stop: () =>
      Effect.sync(() => {
        events.push("stop");
      }),
    write: (file, content) =>
      Effect.sync(() => {
        events.push(`write ${file}`);
        files.set(file, content);
      }),
    ...overrides,
  };
  return { directories, events, files, io, service: makeLocalSystemOne(io) };
};

describe("Local System One preflight", () => {
  for (const platform of ["win32", "freebsd", "darwin"]) {
    it.effect(
      `refuses unsupported ${platform}/x64 before confirmation or download`,
      () =>
        Effect.gen(function* unsupported() {
          const test = fixture({ arch: "x64", platform });
          const outcome = yield* Effect.result(
            test.service.setup(() => fail("must not confirm"))
          );
          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure.message).toContain(
              "CONTINGENCY_SYSTEM_ONE_URL"
            );
          }
          expect(test.events).toEqual([]);
          expect(test.directories.size).toBe(0);
        })
    );
  }
  it.effect("requires a working NVIDIA GPU on Linux", () =>
    Effect.gen(function* noGpu() {
      const test = fixture({
        output: () => fail("missing command"),
        platform: "linux",
      });
      const outcome = yield* Effect.result(test.service.preflight);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.message).toContain("nvidia-smi");
      }
      expect(test.events).toEqual([]);
    })
  );
  it.effect("names missing uv", () =>
    Effect.gen(function* noUv() {
      const test = fixture({ output: () => fail("ENOENT") });
      const outcome = yield* Effect.result(
        test.service.setup(() => Effect.succeed(true))
      );
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.message).toContain("Missing requirement: uv");
      } else {
        expect.unreachable("setup must fail");
      }
      expect(test.directories.size).toBe(0);
    })
  );
  it.effect("never fetches an interpreter when system Python is absent", () =>
    Effect.gen(function* noPython() {
      const test = fixture({
        output: (_command, args) =>
          args[0] === "python" ? fail("not found") : Effect.succeed("uv 0.9"),
      });
      const outcome = yield* Effect.result(
        test.service.setup(() => Effect.succeed(true))
      );
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.message).toContain("system Python 3.12 or 3.13");
      } else {
        expect.unreachable("setup must fail");
      }
      expect(test.files.size).toBe(0);
      expect(test.directories.size).toBe(0);
    })
  );
  it.effect("accepts a working CUDA preflight without downloads", () =>
    Effect.gen(function* cuda() {
      const test = fixture({ platform: "linux" });
      expect((yield* test.service.preflight).platform).toBe("linux");
      expect(test.events[0]).toContain("nvidia-smi");
      expect(test.events).not.toContain("download");
      expect(test.events).toContain(
        "uv python find --python-preference system --no-python-downloads >=3.12,<3.14"
      );
    })
  );
});

describe("installation transaction", () => {
  it.effect("does nothing when confirmation is declined", () =>
    Effect.gen(function* decline() {
      const test = fixture();
      expect(
        yield* test.service.setup(() => Effect.succeed(false))
      ).toBeUndefined();
      expect(test.events).not.toContain("download");
      expect(test.directories.size).toBe(0);
    })
  );
  it.effect("rejects a SHA mismatch before executing downloaded code", () =>
    Effect.gen(function* badHash() {
      const test = fixture({ sha256: () => Effect.succeed("wrong") });
      test.files.set(statePath, JSON.stringify(prior));
      const outcome = yield* Effect.result(
        test.service.setup(() => Effect.succeed(true))
      );
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.message).toContain("SHA-256 mismatch");
      } else {
        expect.unreachable("setup must fail");
      }
      expect(test.events).not.toContain("install");
      expect(yield* test.service.status).toEqual(prior);
      expect([...test.files.keys()]).toEqual([statePath]);
    })
  );
  it.effect("keeps the current installation when smoke fails", () =>
    Effect.gen(function* badSmoke() {
      const test = fixture({ smoke: () => fail("smoke POST failed") });
      test.files.set(statePath, JSON.stringify(prior));
      test.directories.add(path.join(root, prior.current.directory));
      const outcome = yield* Effect.result(
        test.service.setup(() => Effect.succeed(true))
      );
      expect(Result.isFailure(outcome)).toBe(true);
      expect(yield* test.service.status).toEqual(prior);
      expect([...test.files.keys()]).toEqual([statePath]);
      expect([...test.directories]).not.toContain(path.join(root, "install-1"));
      expect(test.directories.has(`${root}.lock`)).toBe(false);
      expect(test.events).not.toContain("rename state");
    })
  );
  it.effect(
    "promotes only after smoke and retains exactly one previous version",
    () =>
      Effect.gen(function* promote() {
        const test = fixture();
        test.files.set(
          statePath,
          JSON.stringify({
            ...prior,
            previous: { ...prior.current, directory: "install-older" },
          })
        );
        test.directories.add(path.join(root, "install-older"));
        const state = yield* test.service.setup(() => Effect.succeed(true));
        expect(state?.current.kevCommit).toBe(
          LOCAL_SYSTEM_ONE_RELEASE.kevCommit
        );
        expect(state?.previous).toEqual(prior.current);
        expect(yield* test.service.status).toEqual(state);
        expect(test.events.indexOf("smoke")).toBeLessThan(
          test.events.indexOf("rename state")
        );
        expect(test.directories.has(path.join(root, "install-older"))).toBe(
          false
        );
        expect(
          [...test.files.keys()].some((file) => file.endsWith(".tmp"))
        ).toBe(false);
      })
  );
  it.effect("preserves state when its atomic replacement fails", () =>
    Effect.gen(function* failedRename() {
      const test = fixture({ rename: () => fail("rename denied") });
      test.files.set(statePath, JSON.stringify(prior));
      const outcome = yield* Effect.result(
        test.service.writeState({
          ...prior,
          current: { ...prior.current, directory: "install-new" },
        })
      );
      expect(Result.isFailure(outcome)).toBe(true);
      expect(yield* test.service.status).toEqual(prior);
      expect([...test.files.keys()]).toEqual([statePath]);
      expect(test.events.filter((event) => event.startsWith("write "))).toEqual(
        [`write ${statePath}.1.tmp`]
      );
    })
  );
  it.effect("refuses paths outside the owned installation directory", () =>
    Effect.gen(function* invalidState() {
      const test = fixture();
      test.files.set(
        statePath,
        JSON.stringify({
          ...prior,
          current: { ...prior.current, directory: "../../outside" },
        })
      );
      expect(Result.isFailure(yield* Effect.result(test.service.remove))).toBe(
        true
      );
      expect(test.files.has(statePath)).toBe(true);
    })
  );
  it.effect("serializes mutation and cleans interrupted staging", () =>
    Effect.gen(function* interruption() {
      const entered = yield* Deferred.make<string>();
      const test = fixture({
        smoke: () =>
          Deferred.succeed(entered, "ready").pipe(Effect.andThen(Effect.never)),
      });
      test.files.set(statePath, JSON.stringify(prior));
      const running = yield* test.service
        .setup(() => Effect.succeed(true))
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(Result.isFailure(yield* Effect.result(test.service.remove))).toBe(
        true
      );
      yield* Fiber.interrupt(running);
      expect(yield* test.service.status).toEqual(prior);
      expect(test.directories.has(`${root}.lock`)).toBe(false);
      expect([...test.files.keys()]).toEqual([statePath]);
    })
  );
  it.effect("stops the recorded server before deleting its installation", () =>
    Effect.gen(function* remove() {
      const test = fixture();
      test.files.set(
        statePath,
        JSON.stringify({
          ...prior,
          server: {
            pid: 123,
            port: 1234,
            startIdentity: "identity",
            startedAt: "timestamp",
          },
        })
      );
      yield* test.service.remove;
      expect(test.events.indexOf("stop")).toBeLessThan(
        test.events.indexOf(`remove ${root}`)
      );
      expect(test.files.size).toBe(0);
      expect(yield* test.service.status).toBeUndefined();
    })
  );
});

it("keeps data and all caches inside the platform directory", () => {
  expect(localSystemOneDirectory("darwin", "/home/me")).toBe(
    "/home/me/Library/Application Support/contingency/system-one"
  );
  expect(localSystemOneDirectory("linux", "/home/me")).toBe(
    "/home/me/.local/share/contingency/system-one"
  );
  expect(localSystemOneDirectory("linux", "/home/me", "/data")).toBe(root);
  expect(localSystemOneDirectory("linux", "/home/me", "relative")).toContain(
    "/home/me/.local/share/"
  );
  const env = localSystemOneEnvironment(root);
  expect(env.UV_PYTHON_DOWNLOADS).toBe("never");
  expect(env.UV_PYTHON_PREFERENCE).toBe("system");
  expect(env.HOME).toBe(process.env.HOME);
  expect(env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME);
  for (const key of [
    env.HF_HOME,
    env.UV_CACHE_DIR,
    env.TORCH_HOME,
    env.TMPDIR,
    env.XDG_CACHE_HOME,
  ]) {
    expect(key.startsWith(`${root}/`)).toBe(true);
  }
});
