import { Schema } from "effect";

import { AndroidDiscoveredApp } from "./android-workspace.ts";

/**
 * Where the Workspace uploads a Target App build. The CLI keeps each upload in
 * a temporary directory until a session claims it, and deletes it when that
 * session ends.
 */
export const targetAppBuildPaths = {
  android: "/target-app-builds/android",
  ios: "/target-app-builds/ios",
  root: "/target-app-builds",
} as const;

/** One upload's handle, used to discard it before a session claims it. */
export const TargetAppBuildId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u)
);

/** An uploaded simulator `.app`, read from its own Info.plist. */
// oxlint-disable-next-line eslint/no-redeclare
export const UploadedIosApp = Schema.Struct({
  /** The session's temporary copy. Never a path the person typed. */
  appPath: Schema.NonEmptyString,
  build: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
  id: TargetAppBuildId,
  label: Schema.String,
  name: Schema.NonEmptyString,
});
export type UploadedIosApp = typeof UploadedIosApp.Type;

/** An uploaded `.apk`, read as an installed app is. */
// oxlint-disable-next-line eslint/no-redeclare
export const UploadedAndroidApp = Schema.Struct({
  apkPath: Schema.NonEmptyString,
  app: AndroidDiscoveredApp,
  id: TargetAppBuildId,
  name: Schema.NonEmptyString,
});
export type UploadedAndroidApp = typeof UploadedAndroidApp.Type;

/** Why an upload was refused, before any device command. */
// oxlint-disable-next-line eslint/no-redeclare
export const TargetAppBuildRefusal = Schema.Struct({
  code: Schema.Literals([
    "upload_invalid",
    "upload_too_large",
    "not_app_bundle",
    "info_plist_unreadable",
    "info_plist_incomplete",
    "device_build",
    "executable_missing",
    "not_apk",
    "apk_unreadable",
    "apk_incomplete",
    "build_tools_missing",
    "build_unknown",
  ]),
  message: Schema.String,
});
export type TargetAppBuildRefusal = typeof TargetAppBuildRefusal.Type;

/** An app already on a simulator, read from its Info.plist. */
// oxlint-disable-next-line eslint/no-redeclare
export const IosInstalledApp = Schema.Struct({
  build: Schema.String,
  bundleId: Schema.String,
  label: Schema.String,
});
export type IosInstalledApp = typeof IosInstalledApp.Type;

/**
 * The upload body for a `.app` folder: per file, a 4-byte big-endian path
 * length, the UTF-8 path relative to the folder's parent (so it starts with
 * `Name.app/`), an 8-byte big-endian size, then the file's bytes.
 */
export const encodeIosBuildEntryHeader = (
  relativePath: string,
  size: number
): Uint8Array<ArrayBuffer> => {
  const name = new TextEncoder().encode(relativePath);
  const header = new Uint8Array(new ArrayBuffer(4 + name.length + 8));
  const view = new DataView(header.buffer);
  view.setUint32(0, name.length);
  header.set(name, 4);
  view.setBigUint64(4 + name.length, BigInt(size));
  return header;
};
