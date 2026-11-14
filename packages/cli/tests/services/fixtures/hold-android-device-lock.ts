// Takes the device lock at argv[2] in its own process, reports the outcome on
// stdout, and holds the lock until stdin closes or the process is killed.
import { Effect } from "effect";

import { acquireAndroidDeviceLock } from "../../../src/services/android-device-lock.ts";

const lockPath = process.argv[2] ?? "";
const result = await Effect.runPromise(
  Effect.result(acquireAndroidDeviceLock(lockPath))
);
process.stdout.write(
  result._tag === "Success" ? "held\n" : `refused ${result.failure.code}\n`
);
if (result._tag === "Success") {
  process.stdin.resume();
}
