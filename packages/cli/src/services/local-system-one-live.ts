import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  prepareLocalSystemOneLock,
  withLocalSystemOneLock,
} from "./local-system-one-lock.ts";
import {
  stopLocalSystemOneProcesses,
  unusedLocalPort,
} from "./local-system-one-process.ts";
import {
  makeLocalSystemOneProgress,
  modelDownloadScript,
} from "./local-system-one-progress.ts";
import { LOCAL_SYSTEM_ONE_RELEASE } from "./local-system-one-release.ts";
import {
  LocalSystemOne,
  localSystemOneDirectory,
  localSystemOneError,
  LocalSystemOneError,
  makeLocalSystemOne,
} from "./local-system-one.ts";
import { SystemOneResponseSchema } from "./system-one-request.ts";
import type { SystemOneRequest } from "./system-one-request.ts";

/**
 * Kev's server arguments. An explicit accelerator fails closed, where Kev's
 * default `auto` falls back to CPU, which ADR 0064 rules out.
 */
export const kevServeArguments = (
  platform: NodeJS.Platform,
  run: string,
  port: number
) => [
  "-m",
  "kev.serve",
  "--run",
  run,
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--device",
  platform === "darwin" ? "mps" : "cuda",
];

/** Kept inside each installation so remove reclaims all fetched artifacts. */
export const localSystemOneEnvironment = (
  directory: string,
  python?: string
) => ({
  HF_HOME: path.join(directory, "cache", "huggingface"),
  HOME: process.env.HOME,
  KEV_API_KEY: "",
  LANG: process.env.LANG,
  PATH: process.env.PATH,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONUNBUFFERED: "1",
  TMPDIR: path.join(directory, "tmp"),
  TORCH_HOME: path.join(directory, "cache", "torch"),
  UV_CACHE_DIR: path.join(directory, "cache", "uv"),
  UV_PROJECT_ENVIRONMENT: path.join(directory, "kev", ".venv"),
  UV_PYTHON: python,
  UV_PYTHON_DOWNLOADS: "never",
  UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
  UV_PYTHON_PREFERENCE: "system",
  XDG_CACHE_HOME: path.join(directory, "cache"),
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
});

const smokeRequest: SystemOneRequest = {
  model: "kev-latest",
  questions: {
    done: {
      criteria: { false: "No", true: "Yes" },
      instructions: {
        condition: "The page says Ready.",
        question: "Does the page satisfy the condition?",
      },
      type: "noul",
    },
  },
  state: {
    elements: [],
    page: { content: ["Ready"], title: "Smoke", url: "http://localhost/" },
    recent_actions: [],
  },
};

const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ catch: localSystemOneError, try: run });

export const makeLocalSystemOneLive = (
  options: {
    readonly root?: string;
    readonly archiveUrl?: string;
    readonly progress?: ReturnType<
      typeof makeLocalSystemOneProgress<LocalSystemOneError>
    >;
  } = {}
) => {
  const service = Effect.gen(function* localSystemOneLive() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const writeProgress = promisify(process.stderr.write.bind(process.stderr));
    const progress =
      options.progress ??
      makeLocalSystemOneProgress(Boolean(process.stderr.isTTY), (text) =>
        promise(() => writeProgress(text)).pipe(Effect.asVoid)
      );
    const output = (command: string, args: readonly string[]) =>
      spawner
        .string(
          ChildProcess.make(command, [...args], {
            env: {
              UV_PYTHON_DOWNLOADS: "never",
              UV_PYTHON_PREFERENCE: "system",
            },
            extendEnv: true,
            stderr: "ignore",
            stdin: "ignore",
          })
        )
        .pipe(Effect.mapError(localSystemOneError));
    const run = (
      command: string,
      args: readonly string[],
      directory: string,
      python?: string
    ) =>
      Effect.gen(function* runInstallCommand() {
        const code = yield* spawner.exitCode(
          ChildProcess.make(command, [...args], {
            cwd: path.join(directory, "kev"),
            env: localSystemOneEnvironment(directory, python),
            extendEnv: false,
            stderr: "inherit",
            stdin: "ignore",
            stdout: "inherit",
          })
        );
        if (code !== 0) {
          return yield* new LocalSystemOneError({
            message: `${command} exited with ${code}.`,
          });
        }
      }).pipe(Effect.mapError(localSystemOneError));
    const root =
      options.root ??
      localSystemOneDirectory(
        process.platform,
        os.homedir(),
        process.env.XDG_DATA_HOME
      );
    const local: ReturnType<typeof makeLocalSystemOne> = makeLocalSystemOne({
      arch: process.arch,
      download: (url, file) =>
        Effect.gen(function* downloadArchive() {
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (value) => Effect.sync(() => value.abort())
          );
          const response = yield* promise(() =>
            fetch(options.archiveUrl ?? url, { signal: controller.signal })
          );
          if (!response.ok || response.body === null) {
            return yield* new LocalSystemOneError({
              message: `Kev download failed: HTTP ${response.status}`,
            });
          }
          const { body } = response;
          const total =
            Number(response.headers.get("content-length")) || undefined;
          const bar = yield* progress.download("Kev archive", total);
          yield* Effect.addFinalizer(() => bar.finish.pipe(Effect.orDie));
          let received = 0;
          yield* Stream.fromReadableStream({
            evaluate: () => body,
            onError: localSystemOneError,
          }).pipe(
            Stream.tap((chunk) => {
              received += chunk.byteLength;
              return bar.update(received);
            }),
            Stream.run(fs.sink(file, { flag: "wx", mode: 0o600 }))
          );
          yield* bar.update(received, total, true);
        }).pipe(Effect.scoped, Effect.mapError(localSystemOneError)),
      id: randomUUID,
      install: (directory, python, selectedModel, version) =>
        Effect.gen(function* installKev() {
          yield* fs.makeDirectory(path.join(directory, "kev"));
          yield* fs.makeDirectory(path.join(directory, "tmp"));
          yield* run(
            "tar",
            [
              "-xzf",
              path.join(directory, "kev.tar.gz"),
              "--strip-components=1",
              "-C",
              path.join(directory, "kev"),
            ],
            directory,
            python
          );
          yield* progress.stage("Packages");
          yield* run(
            "uv",
            [
              "sync",
              "--locked",
              "--extra",
              "serve",
              "--no-dev",
              "--python",
              python,
            ],
            directory,
            python
          );
          const model = LOCAL_SYSTEM_ONE_RELEASE.models[selectedModel];
          yield* progress.stage("Model weights");
          const bar = yield* progress.download("Model weights");
          yield* Effect.addFinalizer(() => bar.finish.pipe(Effect.orDie));
          let received = 0;
          let total: number | undefined;
          const child = yield* spawner.spawn(
            ChildProcess.make(
              path.join(directory, "kev", ".venv", "bin", "python"),
              ["-c", modelDownloadScript, `${model.id}@${version.nevRevision}`],
              {
                cwd: path.join(directory, "kev"),
                env: localSystemOneEnvironment(directory, python),
                extendEnv: false,
                stderr: "inherit",
                stdin: "ignore",
                stdout: "pipe",
              }
            )
          );
          const Progress = Schema.Struct({
            received: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
            total: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
          });
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              const prefix = "CONTINGENCY_PROGRESS ";
              if (!line.startsWith(prefix)) {
                return Effect.void;
              }
              return Schema.decodeUnknownEffect(
                Schema.fromJsonString(Progress)
              )(line.slice(prefix.length)).pipe(
                Effect.flatMap((value) => {
                  ({ received } = value);
                  total = value.total || undefined;
                  return bar.update(received, total);
                })
              );
            })
          );
          const code = yield* child.exitCode;
          if (code !== 0) {
            return yield* new LocalSystemOneError({
              message: `Model download exited with ${code}.`,
            });
          }
          yield* bar.update(received, total, true);
        }).pipe(Effect.scoped, Effect.mapError(localSystemOneError)),
      lock: (body) =>
        Effect.gen(function* mutationLock() {
          yield* prepareLocalSystemOneLock(root);
          const installed = yield* local.status;
          const python =
            installed === undefined
              ? (yield* output("uv", [
                  "python",
                  "find",
                  "--python-preference",
                  "system",
                  "--no-python-downloads",
                  ">=3.12,<3.14",
                ])).trim()
              : path.join(
                  root,
                  installed.current.directory,
                  "kev",
                  ".venv",
                  "bin",
                  "python"
                );
          return yield* withLocalSystemOneLock(
            python,
            `${root}.mutation-lock`,
            body
          );
        }),
      mkdir: (directory, exclusive = false) =>
        fs
          .makeDirectory(directory, { mode: 0o700, recursive: !exclusive })
          .pipe(Effect.mapError(localSystemOneError)),
      output,
      platform: process.platform,
      read: (file) =>
        fs.readFileString(file).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(Option.none())
          ),
          Effect.mapError(localSystemOneError)
        ),
      remove: (directory) =>
        fs
          .remove(directory, { force: true, recursive: true })
          .pipe(Effect.mapError(localSystemOneError)),
      rename: (from, to) =>
        fs.rename(from, to).pipe(Effect.mapError(localSystemOneError)),
      root,
      sha256: (file) =>
        promise(async (signal) => {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file, { signal })) {
            hash.update(chunk);
          }
          return hash.digest("hex");
        }),
      smoke: (directory, selectedModel, version) =>
        Effect.gen(function* smokeKev() {
          const port = yield* unusedLocalPort;
          const model = LOCAL_SYSTEM_ONE_RELEASE.models[selectedModel];
          const log = path.join(directory, "server.log");
          const child = yield* spawner.spawn(
            ChildProcess.make(
              path.join(directory, "kev", ".venv", "bin", "python"),
              kevServeArguments(
                process.platform,
                `${model.id}@${version.nevRevision}`,
                port
              ),
              {
                cwd: path.join(directory, "kev"),
                env: localSystemOneEnvironment(directory),
                extendEnv: false,
                killSignal: "SIGKILL",
                stderr: fs
                  .sink(path.join(directory, "server.stderr.log"))
                  .pipe(Sink.as(new Uint8Array())),
                stdin: "ignore",
                stdout: fs.sink(log).pipe(Sink.as(new Uint8Array())),
              }
            )
          );
          yield* Stream.runDrain(child.stdout).pipe(Effect.forkChild);
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkChild);
          const origin = `http://127.0.0.1:${port}`;
          const ready = promise(async (signal) => {
            const response = await fetch(`${origin}/v1/models`, { signal });
            if (!response.ok) {
              throw new Error(`Kev readiness: HTTP ${response.status}`);
            }
            await response.arrayBuffer();
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              times: 180,
            })
          );
          yield* Effect.raceFirst(
            ready,
            child.exitCode.pipe(
              Effect.andThen((code) =>
                Effect.fail(
                  new LocalSystemOneError({
                    message: `Kev exited with ${code}; see ${log}.`,
                  })
                )
              )
            )
          );
          const answer = yield* promise(async (signal) => {
            const response = await fetch(`${origin}/v1/systemone`, {
              body: JSON.stringify(smokeRequest),
              headers: { "Content-Type": "application/json" },
              method: "POST",
              signal,
            });
            if (!response.ok) {
              throw new Error(`Kev smoke: HTTP ${response.status}`);
            }
            const body: unknown = await response.json();
            return body;
          });
          const decoded = yield* Schema.decodeUnknownEffect(
            SystemOneResponseSchema
          )(answer);
          if (decoded.answers["done"]?.type !== "noul") {
            return yield* new LocalSystemOneError({
              message: "Kev smoke response is missing the requested answer.",
            });
          }
        }).pipe(
          Effect.timeout("4 minutes"),
          Effect.scoped,
          Effect.mapError(localSystemOneError)
        ),
      stage: progress.stage,
      stop: (server) => stopLocalSystemOneProcesses(server),
      write: (file, content) =>
        fs
          .writeFileString(file, content, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(localSystemOneError)),
    });
    return local;
  });
  return Layer.effect(LocalSystemOne, service);
};

export const LocalSystemOneLive = makeLocalSystemOneLive();
