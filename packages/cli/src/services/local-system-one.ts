import path from "node:path";

import { Context, Data, Effect, Option, Schema } from "effect";

import { LOCAL_SYSTEM_ONE_RELEASE } from "./local-system-one-release.ts";

export class LocalSystemOneError extends Data.TaggedError(
  "LocalSystemOneError"
)<{
  readonly message: string;
}> {}

export const localSystemOneError = (cause: unknown): LocalSystemOneError =>
  new LocalSystemOneError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

const Installation = Schema.Struct({
  directory: Schema.String.check(Schema.isPattern(/^install-[a-zA-Z0-9-]+$/u)),
  kevCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  kevSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
  ),
  model: Schema.Literal("nev"),
  modelId: Schema.String,
  nevRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
});

/** Server identity is reserved for the detached supervisor, never just a PID. */
export const LocalSystemOneStateSchema = Schema.Struct({
  crashes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  current: Installation,
  previous: Schema.NullOr(Installation),
  server: Schema.NullOr(
    Schema.Struct({
      kevPid: Schema.Int.check(Schema.isGreaterThan(1)),
      kevPort: Schema.Int.check(
        Schema.isBetween({ maximum: 65_535, minimum: 1 })
      ),
      kevStartIdentity: Schema.NonEmptyString,
      phase: Schema.Literals(["starting", "ready", "crashed"]),
      pid: Schema.Int.check(Schema.isGreaterThan(1)),
      port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
      startIdentity: Schema.NonEmptyString,
      startedAt: Schema.NonEmptyString,
    })
  ),
  skipReason: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
});
export type LocalSystemOneState = typeof LocalSystemOneStateSchema.Type;
export interface LocalSystemOneVersion {
  readonly kevCommit: string;
  readonly kevSha256?: string | undefined;
  readonly nevRevision: string;
}
export const testedLocalSystemOneVersion: LocalSystemOneVersion = {
  kevCommit: LOCAL_SYSTEM_ONE_RELEASE.kevCommit,
  kevSha256: LOCAL_SYSTEM_ONE_RELEASE.kevSha256,
  nevRevision: LOCAL_SYSTEM_ONE_RELEASE.models.nev.revision,
};
export type LocalSystemOnePlatform = "darwin" | "linux";
type Task<A> = Effect.Effect<A, LocalSystemOneError>;

export const localSystemOneDirectory = (
  platform: string,
  home: string,
  xdg?: string
): string =>
  platform === "darwin"
    ? path.join(
        home,
        "Library",
        "Application Support",
        "contingency",
        "system-one"
      )
    : path.join(
        xdg !== undefined && path.isAbsolute(xdg)
          ? xdg
          : path.join(home, ".local", "share"),
        "contingency",
        "system-one"
      );

/** All machine effects are injectable. No setup operation belongs to an MCP toolkit. */
export interface LocalSystemOneIO {
  readonly lock?: (<A>(body: Task<A>) => Task<A>) | undefined;
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly id: () => string;
  readonly read: (file: string) => Task<Option.Option<string>>;
  readonly write: (file: string, content: string) => Task<void>;
  readonly rename: (from: string, to: string) => Task<void>;
  readonly mkdir: (directory: string, exclusive?: boolean) => Task<void>;
  readonly remove: (directory: string) => Task<void>;
  readonly output: (command: string, args: readonly string[]) => Task<string>;
  readonly download: (url: string, file: string) => Task<void>;
  readonly sha256: (file: string) => Task<string>;
  readonly install: (
    directory: string,
    python: string,
    model: "nev",
    version: LocalSystemOneVersion
  ) => Task<void>;
  /** Starts, probes and stops Kev, including on failure or interruption. */
  readonly smoke: (
    directory: string,
    model: "nev",
    version: LocalSystemOneVersion
  ) => Task<void>;
  readonly stop: (
    server: NonNullable<LocalSystemOneState["server"]>,
    directory: string
  ) => Task<void>;
}

export const makeLocalSystemOne = (io: LocalSystemOneIO) => {
  const statePath = path.join(io.root, "state.json");
  const status = Effect.gen(function* readState() {
    const content = yield* io.read(statePath);
    if (Option.isNone(content)) {
      return;
    }
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(LocalSystemOneStateSchema),
      { onExcessProperty: "error" }
    )(content.value).pipe(Effect.mapError(localSystemOneError));
  });
  const writeState = (state: LocalSystemOneState) =>
    Effect.gen(function* atomicWrite() {
      const validated = yield* Schema.decodeUnknownEffect(
        LocalSystemOneStateSchema,
        { onExcessProperty: "error" }
      )(state).pipe(Effect.mapError(localSystemOneError));
      const temporary = `${statePath}.${io.id()}.tmp`;
      yield* Effect.acquireRelease(Effect.succeed(temporary), (file) =>
        io.remove(file).pipe(Effect.orDie)
      );
      yield* io.write(temporary, JSON.stringify(validated, null, 2));
      yield* io.rename(temporary, statePath);
    }).pipe(Effect.scoped);
  const preflight = Effect.gen(function* checkRequirements() {
    if (
      !(io.platform === "darwin" && io.arch === "arm64") &&
      io.platform !== "linux"
    ) {
      return yield* new LocalSystemOneError({
        message:
          "Local System One requires Apple Silicon macOS or Linux with an NVIDIA GPU. Use a hosted System One via CONTINGENCY_SYSTEM_ONE_URL.",
      });
    }
    if (io.platform === "linux") {
      yield* io
        .output("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"])
        .pipe(
          Effect.filterOrFail(
            (value) => value.trim() !== "",
            () => new LocalSystemOneError({ message: "No NVIDIA GPU found." })
          ),
          Effect.mapError(
            () =>
              new LocalSystemOneError({
                message:
                  "Local System One requires nvidia-smi and an NVIDIA GPU. Use a hosted System One via CONTINGENCY_SYSTEM_ONE_URL.",
              })
          )
        );
    }
    yield* io.output("uv", ["--version"]).pipe(
      Effect.mapError(
        () =>
          new LocalSystemOneError({
            message:
              "Missing requirement: uv. Install uv yourself, then run setup again.",
          })
      )
    );
    const python = yield* io
      .output("uv", [
        "python",
        "find",
        "--python-preference",
        "system",
        "--no-python-downloads",
        ">=3.12,<3.14",
      ])
      .pipe(
        Effect.map((value) => value.trim()),
        Effect.filterOrFail(
          (value) => path.isAbsolute(value),
          () =>
            new LocalSystemOneError({
              message: "Python lookup returned no interpreter.",
            })
        ),
        Effect.mapError(
          () =>
            new LocalSystemOneError({
              message:
                "Missing requirement: system Python 3.12 or 3.13. Install it yourself; Contingency never downloads Python.",
            })
        )
      );
    const platform: LocalSystemOnePlatform =
      io.platform === "darwin" ? "darwin" : "linux";
    return { platform, python };
  });
  // Serializes terminal mutations. Slice 2's server lock has a separate lifetime.
  const locked = <A>(body: Task<A>): Task<A> =>
    io.lock
      ? io.lock(body)
      : Effect.gen(function* exclusiveMutation() {
          yield* io.mkdir(path.dirname(io.root));
          yield* Effect.acquireRelease(io.mkdir(`${io.root}.lock`, true), () =>
            io.remove(`${io.root}.lock`).pipe(Effect.orDie)
          );
          return yield* body;
        }).pipe(Effect.scoped);

  const setup = <R>(
    confirm: (
      platform: LocalSystemOnePlatform
    ) => Effect.Effect<boolean, LocalSystemOneError, R>,
    model = "nev" as const,
    version: LocalSystemOneVersion = testedLocalSystemOneVersion
  ) =>
    Effect.gen(function* setupLocalSystemOne() {
      const { platform, python } = yield* preflight;
      if (!(yield* confirm(platform))) {
        return;
      }
      return yield* locked(
        Effect.gen(function* installAndPromote() {
          const prior = yield* status;
          const directory = `install-${io.id()}`;
          const owned = path.join(io.root, directory);
          let promoted = false;
          yield* Effect.acquireRelease(io.mkdir(owned), () =>
            promoted ? Effect.void : io.remove(owned).pipe(Effect.orDie)
          );
          const archive = path.join(owned, "kev.tar.gz");
          const release = LOCAL_SYSTEM_ONE_RELEASE;
          yield* io.download(
            `https://codeload.github.com/jaredpalmer/kev/tar.gz/${version.kevCommit}`,
            archive
          );
          const kevSha256 = yield* io.sha256(archive);
          if (
            version.kevSha256 !== undefined &&
            kevSha256 !== version.kevSha256
          ) {
            return yield* new LocalSystemOneError({
              message: "Kev tarball SHA-256 mismatch; installation discarded.",
            });
          }
          yield* io.install(owned, python, model, version);
          yield* io.smoke(owned, model, version);
          if (prior?.server !== undefined && prior.server !== null) {
            yield* io.stop(
              prior.server,
              path.join(io.root, prior.current.directory)
            );
          }
          const next: LocalSystemOneState = {
            current: {
              directory,
              kevCommit: version.kevCommit,
              kevSha256,
              model,
              modelId: release.models[model].id,
              nevRevision: version.nevRevision,
            },
            previous: prior?.current ?? null,
            server: null,
            version: 1,
          };
          yield* Effect.uninterruptible(
            writeState(next).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  promoted = true;
                })
              )
            )
          );
          if (prior?.previous !== undefined && prior.previous !== null) {
            yield* io.remove(path.join(io.root, prior.previous.directory));
          }
          return next;
        }).pipe(Effect.scoped)
      );
    });
  const rollback = locked(
    Effect.gen(function* rollbackInstallation() {
      const state = yield* status;
      if (state?.previous === undefined || state.previous === null) {
        return yield* new LocalSystemOneError({
          message: "No previous Local System One installation is available.",
        });
      }
      if (state.server !== null) {
        yield* io.stop(
          state.server,
          path.join(io.root, state.current.directory)
        );
      }
      const { previous } = state;
      yield* io.smoke(
        path.join(io.root, previous.directory),
        previous.model,
        previous
      );
      const next: LocalSystemOneState = {
        crashes: 0,
        current: previous,
        previous: state.current,
        server: null,
        version: 1,
      };
      yield* writeState(next);
      return next;
    })
  );
  const remove = locked(
    Effect.gen(function* removeInstallation() {
      const state = yield* status;
      if (state?.server !== undefined && state.server !== null) {
        yield* io.stop(
          state.server,
          path.join(io.root, state.current.directory)
        );
      }
      yield* io.remove(io.root);
    })
  );
  return {
    dataDirectory: io.root,
    preflight,
    remove,
    rollback,
    setup,
    status,
    withLock: locked,
    writeState,
  };
};

export const LocalSystemOne = Context.Service<
  ReturnType<typeof makeLocalSystemOne>
>("@contingency/LocalSystemOne");
