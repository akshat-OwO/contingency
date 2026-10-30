import { makeNativeAppSessionLifecycle } from "./native-app-session-lifecycle.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";

/** Preserve the platform adapter's serial vocabulary at its existing callers. */
export const makeAndroidSessionLifecycle = (
  input: Omit<
    Parameters<typeof makeNativeAppSessionLifecycle>[0],
    "deviceId" | "readDeviceId"
  > & {
    readonly serial: string;
    readonly readSerial: Parameters<
      typeof makeNativeAppSessionLifecycle
    >[0]["readDeviceId"];
  }
) =>
  makeNativeAppSessionLifecycle({
    ...input,
    deviceId: input.serial,
    error: platformRuntimeError,
    readDeviceId: input.readSerial,
  });
