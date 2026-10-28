import {
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { hostProcessIsAlive } from "./agent-session-resources.ts";
import type { ProcessIsAlive } from "./agent-session-resources.ts";
import { iosError, iosUuid } from "./ios-contract.ts";
import { requireIosHost } from "./ios-discovery.ts";
import { stopIosRunner } from "./ios-runner.ts";
import { decodeIosJson, iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const Record = Schema.Struct({
  directory: Schema.optional(Schema.String),
  owner: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  udid: Schema.String.check(Schema.isPattern(iosUuid)),
});
export const defaultIosResourceDirectory = () =>
  path.join(homedir(), ".contingency/ios-session-simulators");
const recordIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ catch: () => iosError("cleanup_failed"), try: run });
export const makeIosSessionResources = (
  directory = defaultIosResourceDirectory(),
  io: IosSimctlService = iosSimctlHost,
  isAlive: ProcessIsAlive = hostProcessIsAlive,
  stopRunner: typeof stopIosRunner = stopIosRunner
) => {
  // Startup reclamation passes reclaiming: another process may already have
  // reclaimed the same dead owner's Session Simulator and removed its record.
  const remove = (udid: string, reclaiming = false) =>
    Effect.gen(function* deleteRecordedSimulator() {
      if (!iosUuid.test(udid)) {
        return yield* Effect.fail(iosError("cleanup_failed"));
      }
      const text = yield* recordIo(async () => {
        try {
          return await readFile(path.join(directory, `${udid}.json`), "utf-8");
        } catch (error) {
          if (
            reclaiming &&
            Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)
          ) {
            return;
          }
          throw error;
        }
      });
      if (text === undefined) {
        return;
      }
      const record = yield* decodeIosJson(Record, text);
      if (record.udid !== udid) {
        return yield* Effect.fail(iosError("cleanup_failed"));
      }
      const ownedDirectory = record.directory;
      if (ownedDirectory !== undefined) {
        // A recorded state directory must belong to our temporary directory namespace.
        if (
          path.dirname(ownedDirectory) !== tmpdir() ||
          !path.basename(ownedDirectory).startsWith("contingency-ios-")
        ) {
          return yield* Effect.fail(iosError("cleanup_failed"));
        }
        yield* stopRunner(ownedDirectory, udid);
      }
      // simctl delete shuts down booted devices too. A missing device counts as deleted,
      // but other failures retain the record for a later startup.
      const deleted = yield* Effect.result(io.device(["delete", udid]));
      if (deleted._tag === "Failure") {
        const inventory = yield* decodeIosJson(
          Schema.Struct({
            devices: Schema.Record(
              Schema.String,
              Schema.Array(Schema.Struct({ udid: Schema.String }))
            ),
          }),
          yield* io.devices()
        );
        if (
          Object.values(inventory.devices).some((devices) =>
            devices.some((device) => device.udid === udid)
          )
        ) {
          return yield* Effect.fail(iosError("cleanup_failed"));
        }
      }
      yield* recordIo(async () => {
        try {
          await unlink(path.join(directory, `${udid}.json`));
        } catch (error) {
          if (
            !Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)
          ) {
            throw error;
          }
        }
      });
      if (ownedDirectory !== undefined) {
        yield* recordIo(() =>
          rm(ownedDirectory, { force: true, recursive: true })
        );
      }
    });
  return {
    cleanup: () =>
      Effect.gen(function* cleanupRecordedSimulators() {
        const entries = yield* recordIo(async () => {
          try {
            return await readdir(directory);
          } catch (error) {
            if (
              Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(
                error
              )
            ) {
              return [];
            }
            throw error;
          }
        });
        let checkedHost = false;
        for (const entry of entries) {
          const udid = entry.endsWith(".json") ? entry.slice(0, -5) : "";
          if (!iosUuid.test(udid)) {
            continue;
          }
          // A partial/corrupt record cannot authorize deleting any device.
          const parsed = yield* Effect.result(
            recordIo(() => readFile(path.join(directory, entry), "utf-8")).pipe(
              Effect.flatMap((text) => decodeIosJson(Record, text))
            )
          );
          if (
            parsed._tag === "Failure" ||
            parsed.success.udid !== udid ||
            isAlive(parsed.success.owner)
          ) {
            continue;
          }
          if (!checkedHost) {
            yield* requireIosHost(io);
            checkedHost = true;
          }
          yield* remove(udid, true);
        }
      }),
    isRecorded: (stateDirectory: string) =>
      Effect.gen(function* directoryIsRecorded() {
        const entries = yield* recordIo(async () => {
          try {
            return await readdir(directory);
          } catch (error) {
            if (
              Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(
                error
              )
            ) {
              return [];
            }
            throw error;
          }
        });
        for (const entry of entries) {
          if (!entry.endsWith(".json") || !iosUuid.test(entry.slice(0, -5))) {
            continue;
          }
          const record = yield* recordIo(() =>
            readFile(path.join(directory, entry), "utf-8")
          ).pipe(Effect.flatMap((text) => decodeIosJson(Record, text)));
          if (record.directory === stateDirectory) {
            return true;
          }
        }
        return false;
      }),
    record: (udid: string, owner = process.pid, stateDirectory?: string) =>
      Effect.gen(function* recordSessionSimulator() {
        const input =
          stateDirectory === undefined
            ? { owner, udid }
            : { directory: stateDirectory, owner, udid };
        const record = yield* Schema.decodeUnknownEffect(Record)(input).pipe(
          Effect.mapError(() => iosError("cleanup_failed"))
        );

        yield* recordIo(() =>
          mkdir(directory, { mode: 0o700, recursive: true })
        );
        yield* recordIo(() =>
          writeFile(
            path.join(directory, `${udid}.json`),
            JSON.stringify(record),
            { flag: "wx", mode: 0o600 }
          )
        );
      }),
    remove,
  };
};
export const cleanupIosSessionSimulators = () =>
  makeIosSessionResources().cleanup();
