import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

it.live.each([
  { command: "web", signal: "SIGINT" },
  { command: "web", signal: "SIGTERM" },
  { command: "mcp", signal: "SIGINT" },
  { command: "mcp", signal: "SIGTERM" },
] as const)(
  "$command announces $signal on stderr",
  ({ command, signal }) =>
    Effect.gen(function* shutdownCli() {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), "contingency-shutdown-"))
        ),
        (temporary) =>
          Effect.promise(() => rm(temporary, { force: true, recursive: true }))
      );
      let stderr = "";
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(
            process.execPath,
            [
              path.resolve(import.meta.dirname, "../../src/index.ts"),
              command,
              ...(command === "web" ? ["--no-browser"] : []),
            ],
            {
              cwd: directory,
              env: {
                ...process.env,
                CONTINGENCY_CATALOG_ROOT: path.join(directory, "catalog"),
                CONTINGENCY_GLOBAL_CATALOG_ROOT: path.join(
                  directory,
                  "global-catalog"
                ),
                CONTINGENCY_MCP_PORT: "0",
                CONTINGENCY_WEB_PORT: "0",
                NODE_ENV: "production",
              },
              stdio: "pipe",
            }
          )
        ),
        (process) =>
          Effect.callback<boolean>((resume) => {
            if (process.exitCode !== null || process.signalCode !== null) {
              return resume(Effect.succeed(true));
            }
            process.once("close", () => resume(Effect.succeed(true)));
            process.kill("SIGKILL");
          })
      );
      yield* Effect.callback<boolean>((resume) => {
        let signalled = false;
        let output = "";
        const signalWhenReady = (data: Buffer) => {
          output += data.toString();
          if (
            !signalled &&
            output.includes(
              command === "web"
                ? "Contingency UI available"
                : "Contingency MCP Workspace available"
            )
          ) {
            signalled = true;
            child.kill(signal);
          }
        };
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          signalWhenReady(data);
        });
        child.stdout.on("data", signalWhenReady);
        child.once("error", (error) => resume(Effect.die(error)));
        child.once("close", () =>
          resume(signalled ? Effect.succeed(true) : Effect.die(stderr))
        );
      }).pipe(Effect.timeout("30 seconds"));
      expect(stderr).toContain(
        "Closing Contingency… press Ctrl+C again to force stop."
      );
      expect(stderr).not.toContain("InterruptError");
    }),
  35_000
);
