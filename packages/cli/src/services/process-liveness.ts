import { Option, Schema } from "effect";

const ProcessError = Schema.Struct({ code: Schema.optional(Schema.String) });

/**
 * Whether a process with this PID exists. EPERM means it exists under another
 * user; only ESRCH proves it is gone, so any other failure counts as alive.
 */
export const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !Schema.decodeUnknownOption(ProcessError)(error).pipe(
      Option.exists(({ code }) => code === "ESRCH")
    );
  }
};
