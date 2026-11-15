// Makes an Android runtime directory under argv[2] the way the backend does,
// owned by this process, with a daemon file and a device claim for argv[4]
// under argv[3]. Prints the directory, then waits until stdin closes or the
// process is killed.
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import {
  ANDROID_RUNTIME_PREFIX,
  writeAndroidRuntimeOwner,
} from "../../../src/services/android-runtime-reclaim.ts";

const [root = "", claims = "", serial = ""] = process.argv.slice(2);
const directory = await mkdtemp(path.join(root, ANDROID_RUNTIME_PREFIX));
await Effect.runPromise(writeAndroidRuntimeOwner(directory, serial));
await writeFile(path.join(directory, "daemon.json"), "{}");
await writeFile(
  path.join(claims, `${path.basename(directory)}.json`),
  JSON.stringify({
    deviceKey: `local:android:none:${serial}`,
    ownerPid: process.pid,
    ownerStartTime: null,
    stateDir: directory,
  })
);
process.stdout.write(`${directory}\n`);
process.stdin.resume();
