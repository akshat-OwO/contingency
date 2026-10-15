import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect } from "effect";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("helper/", import.meta.url));
await Effect.runPromise(
  Effect.tryPromise({
    catch: () =>
      new Error(
        "Android helper build failed. Check JDK, SDK 36, and Gradle repository access."
      ),
    try: async (signal) => {
      const { stdout, stderr } = await execute(
        `${helper}gradlew`,
        ["--no-daemon", "assembleDebug"],
        { cwd: helper, maxBuffer: 8 * 1024 * 1024, signal }
      );
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    },
  })
);
