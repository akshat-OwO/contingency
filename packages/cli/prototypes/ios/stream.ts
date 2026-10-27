import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

const [helper, developer, simulator, display] = process.argv.slice(2);
const credential = process.env.IOS_STREAM_TOKEN;
if (!(helper && developer && simulator && display && credential)) {
  throw new Error(
    "Supply helper, developer directory, simulator, display, and IOS_STREAM_TOKEN"
  );
}
const viewerPage = readFileSync(new URL("viewer.html", import.meta.url));
const expected = Buffer.from(credential);
const authorized = (header: string | undefined) => {
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const program = Effect.scoped(
  Effect.gen(function* streamPrototype() {
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (value) => Effect.sync(() => value.dispose())
    );
    const active = Atom.make(false);
    const viewers = Atom.make<readonly ServerResponse[]>([]);
    registry.mount(active);
    registry.mount(viewers);
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(helper, [developer, simulator, display], { stdio: "pipe" })
      ),
      (value) =>
        Effect.promise(async () => {
          registry.set(active, false);
          if (value.exitCode !== null || value.signalCode !== null) {
            return;
          }
          const closed = once(value, "close");
          const guard = setTimeout(() => {
            value.kill("SIGKILL");
          }, 10_000);
          value.stdin.end("stop\n");
          value.kill("SIGTERM");
          try {
            await closed;
          } finally {
            clearTimeout(guard);
          }
        })
    );
    // Never forward helper diagnostics or credentials into the stream.
    child.stderr.resume();
    child.stdin.on("error", () => {
      /* Child exit is observed below. */
    });
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const address = Schema.decodeUnknownSync(
            Schema.Struct({ port: Schema.Number })
          )(server.address());
          if (
            request.method !== "GET" ||
            request.headers.origin ||
            request.headers.upgrade ||
            request.headers.host !== `127.0.0.1:${address.port}`
          ) {
            response.writeHead(404).end();
            return;
          }
          if (request.url === "/") {
            response
              .writeHead(200, {
                "Cache-Control": "no-store",
                "Content-Type": "text/html; charset=utf-8",
              })
              .end(viewerPage);
            return;
          }
          if (request.url !== "/frames") {
            response.writeHead(404).end();
            return;
          }
          if (!authorized(request.headers.authorization)) {
            response.writeHead(401).end();
            return;
          }
          response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": "application/x-ndjson",
          });
          response.flushHeaders();
          registry.update(viewers, (current) => [...current, response]);
          response.once("close", () =>
            registry.update(viewers, (current) =>
              current.filter((item) => item !== response)
            )
          );
        })
      ),
      (value) =>
        Effect.promise(async () => {
          for (const viewer of registry.get(viewers)) {
            viewer.destroy();
          }
          value.closeAllConnections();
          await promisify(value.close.bind(value))();
        })
    );
    yield* Effect.callback<null, Error>((resume) => {
      const frames = createInterface({ input: child.stdout });
      const commands = createInterface({ input: process.stdin });
      const detach = new Set<() => void>();
      const cleanup = () => {
        commands.removeAllListeners();
        commands.close();
        process.stdin.destroy();
        frames.close();
        for (const remove of detach) {
          remove();
        }
        detach.clear();
      };
      const stop = () => {
        // Close the gate before asking the backend to drain its in-flight frame.
        registry.set(active, false);
        for (const viewer of registry.get(viewers)) {
          viewer.end();
        }
        cleanup();
        resume(Effect.succeed(null));
      };
      const failed = () => {
        cleanup();
        resume(Effect.fail(new Error("Prototype capture exited")));
      };
      frames.on("line", (line) => {
        if (!registry.get(active)) {
          return;
        }
        for (const viewer of registry.get(viewers)) {
          if (viewer.writableLength > 1024 * 1024) {
            viewer.destroy();
          } else {
            viewer.write(`${line}\n`);
          }
        }
      });
      commands.on("line", (line) => {
        if (line === "start" && !registry.get(active)) {
          registry.set(active, true);
          child.stdin.write("start\n");
        } else if (line === "stop") {
          stop();
        }
      });
      commands.once("close", stop);
      child.once("error", failed);
      child.once("exit", failed);
      server.once("error", failed);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      detach.add(() => process.removeListener("SIGINT", stop));
      detach.add(() => process.removeListener("SIGTERM", stop));
      detach.add(() => child.removeListener("exit", failed));
      detach.add(() => child.removeListener("error", failed));
      detach.add(() => server.removeListener("error", failed));
      server.listen(0, "127.0.0.1", () => {
        const address = Schema.decodeUnknownSync(
          Schema.Struct({ port: Schema.Number })
        )(server.address());
        {
          process.stdout.write(
            `${JSON.stringify({ helperPid: child.pid, pid: process.pid, port: address.port })}\n`
          );
        }
      });
      return Effect.sync(cleanup);
    });
  })
);

await Effect.runPromise(program);
