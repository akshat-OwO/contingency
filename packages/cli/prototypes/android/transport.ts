import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

import { Effect } from "effect";

import { ProbeError } from "./driver.ts";
import type { Transport } from "./driver.ts";

export interface CommandEntry {
  readonly command: readonly string[];
  readonly outcome: "success" | "failed";
}
export type Journal = (entry: CommandEntry) => void;
const execute = promisify(execFile);
const serialPattern = /^[A-Za-z0-9._:-]+$/u;

/** Every device command has -s, including probes and cleanup. No implicit selection. */
export const adb = (
  serial: string,
  args: readonly string[],
  journal?: Journal
) =>
  Effect.tryPromise({
    // Child-process errors may contain command output. Never propagate them.
    catch: () => {
      journal?.({ command: ["adb", "-s", serial, ...args], outcome: "failed" });
      return new ProbeError("adb_failed");
    },
    try: async (signal) => {
      if (!serialPattern.test(serial)) {
        throw new ProbeError("device_selection_required");
      }
      const { stdout } = await execute("adb", ["-s", serial, ...args], {
        maxBuffer: 4 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      journal?.({
        command: ["adb", "-s", serial, ...args],
        outcome: "success",
      });
      return stdout.trim();
    },
  });

export const socketTransport =
  (input: {
    readonly serial: string;
    readonly port: number;
    readonly token: string;
    readonly journal?: Journal | undefined;
  }): Transport =>
  (request) =>
    adb(input.serial, ["get-state"], input.journal).pipe(
      Effect.andThen((state) =>
        state === "device"
          ? Effect.void
          : Effect.fail(new ProbeError("disconnected"))
      ),
      Effect.andThen(
        Effect.tryPromise({
          catch: () => new ProbeError("transport_failed"),
          try: (signal) =>
            (() => {
              const { promise, resolve, reject } =
                Promise.withResolvers<unknown>();
              const socket = createConnection({
                host: "127.0.0.1",
                port: input.port,
              });
              let bytes = "";
              const fail = () => {
                socket.destroy();
                reject(new ProbeError("transport_failed"));
              };
              const abort = () => fail();
              signal.addEventListener("abort", abort, { once: true });
              socket.once("close", () =>
                signal.removeEventListener("abort", abort)
              );
              socket.setTimeout(15_000, fail);
              socket.once("error", fail);
              socket.once("connect", () =>
                socket.write(
                  `${JSON.stringify({ ...request, token: input.token })}\n`
                )
              );
              socket.on("data", (chunk: Buffer) => {
                bytes += chunk.toString("utf-8");
                if (bytes.length > 32 * 1024 * 1024) {
                  fail();
                  return;
                }
                const end = bytes.indexOf("\n");
                if (end === -1) {
                  return;
                }
                socket.destroy();
                try {
                  const result: unknown = JSON.parse(bytes.slice(0, end));
                  resolve(result);
                } catch {
                  fail();
                }
              });
              socket.once("end", () => {
                if (!bytes.includes("\n")) {
                  fail();
                }
              });
              return promise;
            })(),
        })
      )
    );
