import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";

import { makeLocalSystemOneLive } from "../../src/services/local-system-one-live.ts";
import {
  makeLocalSystemOneProgress,
  modelDownloadScript,
} from "../../src/services/local-system-one-progress.ts";
import { LocalSystemOne } from "../../src/services/local-system-one.ts";

it.live(
  "sets up and updates through fake uv, streamed downloads and a smoke server",
  () =>
    Effect.gen(function* liveInstallation() {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: "system-one-progress-",
      });
      const root = path.join(temporary, "data");
      const bin = path.join(temporary, "bin");
      yield* fs.makeDirectory(bin);
      const serverScript = path.join(temporary, "smoke.cjs");
      yield* fs.writeFileString(
        serverScript,
        `
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({answers: {done: {type: "noul", noul: 1}}, model: "fixture", usage: {input_tokens: 1, output_tokens: 1}}));
}).listen(port, "127.0.0.1");
`
      );
      const python = path.join(temporary, "python");
      yield* fs.writeFileString(
        python,
        `#!/bin/sh
if [ "$1" = "-I" ]; then exec /usr/bin/python3 "$@"; fi
if [ "$1" = "-c" ]; then
  echo 'CONTINGENCY_PROGRESS {"received":100,"total":1000}'
  echo 'CONTINGENCY_PROGRESS {"received":1000,"total":1000}'
  exit 0
fi
exec '${process.execPath}' '${serverScript}' "$@"
`,
        { mode: 0o700 }
      );
      yield* fs.writeFileString(
        path.join(bin, "uv"),
        `#!/bin/sh
case "$1" in
  --version) echo 'uv fixture' ;;
  python) echo /usr/bin/python3 ;;
  sync) mkdir -p .venv/bin; cp '${python}' .venv/bin/python ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 }
      );
      const previousPath = process.env.PATH;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          vi.stubEnv("PATH", `${bin}:${previousPath}`);
          vi.stubEnv("HOME", temporary);
        }),
        () => Effect.sync(() => vi.unstubAllEnvs())
      );
      const payload = gzipSync(new Uint8Array(1024));
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const fixture = createServer((_request, response) => {
            response.writeHead(200, { "Content-Length": payload.byteLength });
            response.write(payload.subarray(0, 10));
            response.end(payload.subarray(10));
          });
          const listening = once(fixture, "listening");
          fixture.listen(0, "127.0.0.1");
          await listening;
          return fixture;
        }),
        (fixture) =>
          Effect.promise(async () => {
            const closed = once(fixture, "close");
            fixture.closeAllConnections();
            fixture.close();
            await closed;
          })
      );
      const address = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ port: Schema.Int })
      )(server.address());
      const output: string[] = [];
      const layer = makeLocalSystemOneLive({
        archiveUrl: `http://127.0.0.1:${address.port}/kev.tar.gz`,
        progress: makeLocalSystemOneProgress(false, (text) =>
          Effect.sync(() => {
            output.push(text);
          })
        ),
        root,
      });
      yield* Effect.gen(function* setupAndUpdate() {
        const local = yield* LocalSystemOne;
        const version = {
          kevCommit: "a".repeat(40),
          nevRevision: "b".repeat(40),
        };
        const installed = yield* local.setup(
          () => Effect.succeed(true),
          "nev",
          version
        );
        expect(installed?.previous).toBeNull();
        const updated = yield* local.setup(() => Effect.succeed(true), "nev", {
          ...version,
          nevRevision: "c".repeat(40),
        });
        expect(updated?.previous).toEqual(installed?.current);
        expect(yield* local.status).toEqual(updated);
        expect(output.filter((line) => line.endsWith("...\n"))).toEqual([
          "Environment...\n",
          "Packages...\n",
          "Model weights...\n",
          "Smoke test...\n",
          "Environment...\n",
          "Packages...\n",
          "Model weights...\n",
          "Smoke test...\n",
        ]);
        expect(output.join("")).toContain("1000 B / 1000 B 100%");
        expect(output.join("")).not.toContain("\r");
        expect(
          (yield* fs.readDirectory(root)).filter((name) =>
            name.startsWith("install-")
          )
        ).toHaveLength(2);
        yield* local.remove;
        expect(yield* fs.exists(root)).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30_000 }
);

it.live("bridges pinned HF byte snapshots without terminal output", () =>
  Effect.gen(function* pythonProgressBridge() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const temporary = yield* fs.makeTempDirectoryScoped({
      prefix: "system-one-hf-",
    });
    yield* fs.makeDirectory(path.join(temporary, "tqdm"));
    yield* fs.writeFileString(path.join(temporary, "tqdm", "__init__.py"), "");
    yield* fs.writeFileString(
      path.join(temporary, "tqdm", "auto.py"),
      `
class tqdm:
    def __init__(self, **kwargs):
        assert kwargs["disable"] is False
        self.file = kwargs["file"]
        self.unit = kwargs["unit"]
        self.n = 0
        self.total = 1000
        self.display()
`
    );
    yield* fs.writeFileString(
      path.join(temporary, "huggingface_hub.py"),
      `
def snapshot_download(repo, revision, allow_patterns, tqdm_class):
    assert repo == "test/model"
    assert revision == "abc"
    assert allow_patterns == ["*.json", "*.safetensors", "*.pt", "*.txt", "*.jinja"]
    for desc in ["Downloading bytes", "Reconstructing (incomplete total...)", "Fetching files"]:
        bar = tqdm_class(desc=desc, unit="B" if desc != "Fetching files" else "it")
        bar.n = 1000
        bar.display()
        bar.file.write("\\rshould stay private")
`
    );
    const output = yield* spawner.string(
      ChildProcess.make(
        "/usr/bin/python3",
        ["-c", modelDownloadScript, "test/model@abc"],
        {
          env: { PYTHONPATH: temporary },
          extendEnv: true,
          stderr: "inherit",
        }
      )
    );
    expect(output).toBe(
      'CONTINGENCY_PROGRESS {"received": 0, "total": 1000}\nCONTINGENCY_PROGRESS {"received": 1000, "total": 1000}\n'
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
