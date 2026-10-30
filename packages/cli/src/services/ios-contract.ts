import type {
  IosRunEnvironment,
  PlatformCapability,
} from "@contingency/protocol";
import { Schema } from "effect";

export const iosUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export const IosDeviceSchema = Schema.Struct({
  deviceType: Schema.String.check(
    Schema.isPattern(/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-/u)
  ),
  kind: Schema.Literal("simulator"),
  name: Schema.String,
  runtime: Schema.String,
  runtimeVersion: Schema.String,
  udid: Schema.String.check(Schema.isPattern(iosUuid)),
});
export type IosDevice = typeof IosDeviceSchema.Type;
export const IosAppSchema = Schema.Struct({
  build: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
  label: Schema.String,
  path: Schema.String,
});
export type IosApp = typeof IosAppSchema.Type;
export type IosEnvironment = typeof IosRunEnvironment.Type;
/** Services `xcrun simctl help privacy` lists on Xcode 27.1, except the bundle-wide `all`. */
export const iosPrivacyServices = [
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;
/** One state per supported service, so the applied order cannot change the outcome. */
export const supportsIosPermissions = (environment: IosEnvironment) => {
  const services = (environment.permissions ?? []).map(
    (state) => state.service
  );
  return (
    services.every((service) =>
      iosPrivacyServices.some((supported) => supported === service)
    ) && new Set(services).size === services.length
  );
};
export interface IosPreparationInput {
  readonly device: IosDevice;
  readonly environment: IosEnvironment;
  /** An explicit path authorizes installation. Omit to use the installed app. */
  readonly appPath?: string;
  readonly requiredCapabilities: readonly PlatformCapability[];
}
const messages = {
  capability_missing: "The selected iOS runtime lacks a required capability.",
  cleanup_failed:
    "Could not stop the session runner. Its private state directory is retained.",
  device_mismatch: "The selected simulator identity changed. Select it again.",
  device_stopped: "Start the selected simulator in Simulator, then refresh.",
  device_unsupported:
    "Explicitly select an iPhone simulator. Physical iPhones and iPads are unsupported.",
  discovery_failed: "Could not read the iOS Simulator inventory.",
  environment_changed:
    "The authorized bundle identifier, build, or runtime changed.",
  host_unsupported: "iOS Simulator requires a local Apple Silicon Mac.",
  os_unsupported: "Select an iPhone simulator running iOS 26 through 27.",
  permission_service_unsupported:
    "Declare each permission service once, from those simctl privacy supports. Notifications and camera are unsupported.",
  physical_device_unsupported:
    "Physical iOS devices are unsupported. Select an iPhone simulator.",
  preparation_failed: "Could not prepare the selected simulator.",
  runtime_missing: "Install the selected iOS Simulator runtime in Xcode.",
  xcode_missing: "Select a full Xcode installation with xcode-select.",
} as const;
export interface IosError {
  readonly _tag: "IosError";
  readonly code: keyof typeof messages;
  readonly message: string;
}
export const iosError = (code: IosError["code"]): IosError => ({
  _tag: "IosError",
  code,
  message: messages[code],
});
export const isSupportedIosVersion = (version: string) =>
  /^(?:26|27)(?:\.\d+)*$/u.test(version);
