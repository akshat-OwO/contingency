import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
  Sink,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

/** Kept inside each installation so remove reclaims all fetched artifacts. */
export const localSystemOneEnvironment = (
  directory: string,
  python?: string
) => ({
  HF_HOME: path.join(directory, "cache", "huggingface"),
  HOME: directory,
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
  UV_PYTHON_PREFERENCE: "only-system",
  XDG_CACHE_HOME: path.join(directory, "cache"),
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

const freePort = promise(async (signal) => {
  const server = net.createServer();
  try {
    const listening = once(server, "listening", { signal });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    // This server binds only an IP address. Parse Node's union at its boundary.
    return Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      address
    ).port;
  } finally {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
});

export const LocalSystemOneLive = Layer.effect(
  LocalSystemOne,
  Effect.gen(function* localSystemOneLive() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = (command: string, args: readonly string[]) =>
      spawner
        .string(
          ChildProcess.make(command, [...args], {
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
    return makeLocalSystemOne({
      arch: process.arch,
      download: (url, file) =>
        promise(async (signal) => {
          const response = await fetch(url, { signal });
          if (!response.ok || response.body === null) {
            throw new Error(`Kev download failed: HTTP ${response.status}`);
          }
          await pipeline(
            Readable.from(response.body),
            createWriteStream(file, { flags: "wx", mode: 0o600 }),
            { signal }
          );
        }),
      id: randomUUID,
      install: (directory, python) =>
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
          const model = LOCAL_SYSTEM_ONE_RELEASE.models.nev;
          yield* run(
            path.join(directory, "kev", ".venv", "bin", "python"),
            [
              "-c",
              "from kev.checkpoint import resolve_run; import sys; resolve_run(sys.argv[1])",
              `${model.id}@${model.revision}`,
            ],
            directory,
            python
          );
        }).pipe(Effect.mapError(localSystemOneError)),
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
      root: localSystemOneDirectory(
        process.platform,
        os.homedir(),
        process.env.XDG_DATA_HOME
      ),
      sha256: (file) =>
        promise(async (signal) => {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file, { signal })) {
            hash.update(chunk);
          }
          return hash.digest("hex");
        }),
      smoke: (directory) =>
        Effect.gen(function* smokeKev() {
          const port = yield* freePort;
          const model = LOCAL_SYSTEM_ONE_RELEASE.models.nev;
          const log = path.join(directory, "server.log");
          const child = yield* spawner.spawn(
            ChildProcess.make(
              path.join(directory, "kev", ".venv", "bin", "python"),
              [
                "-m",
                "kev.serve",
                "--run",
                `${model.id}@${model.revision}`,
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
              ],
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
          const origin = `http://127.0.0.1:${port}`;
          const ready = promise(async (signal) => {
            const response = await fetch(`${origin}/v1/models`, { signal });
            if (!response.ok) {
              throw new Error(`Kev readiness: HTTP ${response.status}`);
            }
            await response.arrayBuffer();
          }).pipe(
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 180 })
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
      stop: (server, directory) =>
        Effect.gen(function* stopRecordedServer() {
          const identity = yield* output("ps", [
            "-p",
            String(server.pid),
            "-o",
            "lstart=",
          ]);
          if (identity.trim() === "") {
            return;
          }
          const args = yield* output("ps", [
            "-p",
            String(server.pid),
            "-o",
            "args=",
          ]);
          if (
            identity.trim() !== server.startIdentity ||
            !args.includes(
              path.join(directory, "kev", ".venv", "bin", "python")
            ) ||
            !args.includes("-m kev.serve")
          ) {
            return yield* new LocalSystemOneError({
              message: `Refusing to stop PID ${server.pid}: process identity does not match the recorded Kev server.`,
            });
          }
          yield* Effect.try({
            catch: localSystemOneError,
            try: () => process.kill(server.pid, "SIGKILL"),
          });
          yield* output("ps", ["-p", String(server.pid), "-o", "stat="]).pipe(
            Effect.filterOrFail(
              (value) => value.trim() === "" || value.trim().startsWith("Z"),
              () =>
                new LocalSystemOneError({
                  message: `PID ${server.pid} has not stopped.`,
                })
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 })
          );
        }),
      write: (file, content) =>
        fs
          .writeFileString(file, content, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(localSystemOneError)),
    });
  })
);
