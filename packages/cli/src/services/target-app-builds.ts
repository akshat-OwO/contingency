/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- An upload is a byte stream read in order, and a bundle is checked one file at a time to bound open descriptors. */
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  TargetAppBuildRefusal,
  UploadedAndroidApp,
  UploadedIosApp,
} from "@contingency/protocol";
import { Context, Effect, Layer, Schema, Scope } from "effect";

import { parseApkBadging, readLocalApkBadging } from "./android-discovery.ts";
import { iosCommand } from "./ios-simctl.ts";

type RefusalCode = TargetAppBuildRefusal["code"];

const refusalMessages = {
  apk_incomplete:
    "The .apk lacks a package name, version code, or launchable activity.",
  apk_unreadable: "Could not read the .apk's manifest.",
  build_tools_missing:
    "Reading an .apk needs Android SDK build-tools. Install them in Android Studio.",
  build_unknown:
    "That build is no longer uploaded. Choose the .app or .apk again.",
  device_build:
    "This is a device build. Choose a build for iPhone Simulator (CFBundleSupportedPlatforms lacks iPhoneSimulator).",
  executable_missing:
    "The .app lacks the executable its Info.plist names in CFBundleExecutable.",
  info_plist_incomplete:
    "Info.plist lacks CFBundleIdentifier, CFBundleVersion, or CFBundleExecutable.",
  info_plist_unreadable: "The .app has no readable Info.plist.",
  not_apk: "Choose an .apk file.",
  not_app_bundle: "Choose a folder whose name ends in .app.",
  upload_invalid: "The upload was incomplete or malformed. Try again.",
  upload_too_large: "The build is too large to upload.",
} as const satisfies Record<RefusalCode, string>;

export interface TargetAppBuildError extends TargetAppBuildRefusal {
  readonly _tag: "TargetAppBuildError";
}

export const targetAppBuildError = (
  code: RefusalCode,
  message: string = refusalMessages[code]
): TargetAppBuildError => ({ _tag: "TargetAppBuildError", code, message });

const isBuildError = (cause: unknown): cause is TargetAppBuildError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "TargetAppBuildError";

/** Upload ceilings: generous for real builds, bounded for a local disk. */
export const targetAppBuildLimits = {
  bytes: 4 * 1024 * 1024 * 1024,
  files: 100_000,
  pathBytes: 4096,
} as const;

const InfoPlist = Schema.Struct({
  CFBundleDisplayName: Schema.optional(Schema.String),
  CFBundleExecutable: Schema.optional(Schema.String),
  CFBundleIdentifier: Schema.optional(Schema.String),
  CFBundleName: Schema.optional(Schema.String),
  CFBundleSupportedPlatforms: Schema.optional(Schema.Array(Schema.String)),
  CFBundleVersion: Schema.optional(Schema.String),
});

export interface TargetAppBuildReaders {
  /** An Info.plist (binary or XML) as JSON text. */
  readonly plist: (file: string) => Effect.Effect<string, unknown>;
  /** `aapt2 dump badging` output for an APK on this host. */
  readonly badging: (
    apk: string
  ) => Effect.Effect<string, { readonly code: string }>;
}

const hostReaders: TargetAppBuildReaders = {
  badging: readLocalApkBadging,
  plist: (file) =>
    iosCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]),
};

/** First bytes of a Mach-O file, thin or universal, in either byte order. */
const machOMagics = new Set([
  0xfe_ed_fa_ce, 0xce_fa_ed_fe, 0xfe_ed_fa_cf, 0xcf_fa_ed_fe, 0xca_fe_ba_be,
  0xbe_ba_fe_ca,
]);

const isMachO = async (file: string) => {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && machOMagics.has(head.readUInt32BE(0));
  } finally {
    await handle.close();
  }
};

const listFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
};

/**
 * Browser uploads drop file modes. The main executable, framework binaries,
 * and helpers must be executable again, or the app installs but cannot
 * launch. Returns the files made executable.
 */
export const restoreExecutableBits = async (
  bundle: string,
  executable: string
): Promise<readonly string[]> => {
  const restored: string[] = [];
  const main = path.join(bundle, executable);
  for (const file of await listFiles(bundle)) {
    if (file === main || (await isMachO(file))) {
      await chmod(file, 0o755);
      restored.push(file);
    }
  }
  return restored;
};

const validSegment = (segment: string) =>
  segment !== "" &&
  segment !== "." &&
  segment !== ".." &&
  !segment.includes("\0") &&
  !segment.includes("\\");

/** Joins incoming chunks and hands out exact byte counts. */
class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }

  /** False when the body ended exactly at a record boundary. */
  async hasMore(): Promise<boolean> {
    await this.fill(1);
    return this.buffer.length > 0;
  }

  async take(count: number): Promise<Buffer> {
    await this.fill(count);
    if (this.buffer.length < count) {
      throw targetAppBuildError("upload_invalid");
    }
    const taken = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return taken;
  }

  /** Streams `count` bytes into `handle` without holding them in memory. */
  async pipe(count: number, handle: FileHandle): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      await this.fill(1);
      if (this.buffer.length === 0) {
        throw targetAppBuildError("upload_invalid");
      }
      const piece = this.buffer.subarray(
        0,
        Math.min(remaining, this.buffer.length)
      );
      await handle.write(piece);
      this.buffer = this.buffer.subarray(piece.length);
      remaining -= piece.length;
    }
  }

  private async fill(count: number) {
    while (this.buffer.length < count && !this.done) {
      const next = await this.iterator.next();
      if (next.done === true) {
        this.done = true;
      } else {
        this.buffer = Buffer.concat([this.buffer, next.value]);
      }
    }
  }
}

/**
 * Rebuilds an uploaded `.app` folder under `directory`. Returns the bundle's
 * folder name. Every path stays inside one `.app` folder.
 */
const writeAppEntries = async (
  body: AsyncIterable<Uint8Array>,
  directory: string
): Promise<string> => {
  const reader = new ChunkReader(body);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bundle: string | undefined;
  let files = 0;
  let bytes = 0;
  while (await reader.hasMore()) {
    const lengthBytes = await reader.take(4);
    const nameLength = lengthBytes.readUInt32BE(0);
    if (nameLength === 0 || nameLength > targetAppBuildLimits.pathBytes) {
      throw targetAppBuildError("upload_invalid");
    }
    let relative: string;
    try {
      relative = decoder.decode(await reader.take(nameLength));
    } catch {
      throw targetAppBuildError("upload_invalid");
    }
    const sizeBytes = await reader.take(8);
    const size = sizeBytes.readBigUInt64BE(0);
    files += 1;
    bytes += Number(size);
    if (
      files > targetAppBuildLimits.files ||
      size > BigInt(targetAppBuildLimits.bytes) ||
      bytes > targetAppBuildLimits.bytes
    ) {
      throw targetAppBuildError("upload_too_large");
    }
    const segments = relative.split("/");
    const [root] = segments;
    if (root === undefined || !root.endsWith(".app") || root === ".app") {
      throw targetAppBuildError("not_app_bundle");
    }
    if (
      segments.length < 2 ||
      !segments.every(validSegment) ||
      (bundle !== undefined && root !== bundle)
    ) {
      throw targetAppBuildError("upload_invalid");
    }
    bundle = root;
    const target = path.join(directory, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    const handle = await open(target, "wx", 0o644);
    try {
      await reader.pipe(Number(size), handle);
    } finally {
      await handle.close();
    }
  }
  if (bundle === undefined) {
    throw targetAppBuildError("upload_invalid");
  }
  return bundle;
};

/** Writes an uploaded APK and returns its SHA-256. */
const writeApk = async (
  body: AsyncIterable<Uint8Array>,
  target: string
): Promise<string> => {
  const hash = createHash("sha256");
  const handle = await open(target, "wx", 0o600);
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > targetAppBuildLimits.bytes) {
        throw targetAppBuildError("upload_too_large");
      }
      if (head.length < 4) {
        head = Buffer.concat([head, chunk]).subarray(0, 4);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  // An APK is a ZIP archive.
  if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw targetAppBuildError("not_apk");
  }
  return hash.digest("hex");
};

interface Upload {
  readonly platform: "ios" | "android";
  readonly directory: string;
  /** The `.app` folder or `.apk` file a session installs. */
  readonly path: string;
  readonly sha256: string | null;
  claimed: boolean;
}

export interface ClaimedTargetAppBuild {
  readonly path: string;
  readonly sha256: string | null;
}

export interface TargetAppBuildsService {
  /** Rebuilds an uploaded `.app` folder and checks it is a simulator build. */
  readonly receiveIos: (
    body: AsyncIterable<Uint8Array>
  ) => Effect.Effect<UploadedIosApp, TargetAppBuildError>;
  /** Stores an uploaded `.apk` and reads it as an installed app is read. */
  readonly receiveAndroid: (
    body: AsyncIterable<Uint8Array>,
    name: string
  ) => Effect.Effect<UploadedAndroidApp, TargetAppBuildError>;
  /** Deletes an upload no session has claimed. */
  readonly discard: (id: string) => Effect.Effect<void>;
  /**
   * Hands one upload to a session. Closing `scope` deletes it, whether the
   * session ends, fails to start, or is cancelled. Only a current, unclaimed
   * upload of the same platform is accepted.
   */
  readonly claim: (
    platform: Upload["platform"],
    buildPath: string,
    scope: Scope.Scope
  ) => Effect.Effect<ClaimedTargetAppBuild, TargetAppBuildError>;
}

export const TargetAppBuilds = Context.Service<TargetAppBuildsService>(
  "contingency/TargetAppBuilds"
);

const remove = (directory: string) =>
  Effect.promise(() => rm(directory, { force: true, recursive: true }));

/**
 * Temporary Target App builds for this process. Each upload lives in its own
 * directory under one root, which is removed when the layer's scope closes.
 */
export const makeTargetAppBuilds = (
  readers: TargetAppBuildReaders = hostReaders
): Effect.Effect<TargetAppBuildsService, never, Scope.Scope> =>
  Effect.gen(function* makeBuilds() {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "contingency-builds-"))),
      remove
    );
    const uploads = new Map<string, Upload>();
    const forget = (id: string) =>
      Effect.suspend(() => {
        const upload = uploads.get(id);
        uploads.delete(id);
        return upload === undefined ? Effect.void : remove(upload.directory);
      });
    const readInfo = (bundle: string) =>
      readers.plist(path.join(bundle, "Info.plist")).pipe(
        Effect.flatMap((text) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(InfoPlist))(text)
        ),
        Effect.mapError(() => targetAppBuildError("info_plist_unreadable"))
      );
    const receiveIos: TargetAppBuildsService["receiveIos"] = (body) =>
      Effect.gen(function* receiveApp() {
        const id = randomUUID();
        const directory = path.join(root, id);
        const result = yield* Effect.gen(function* rebuild() {
          const name = yield* Effect.tryPromise({
            catch: (cause) =>
              isBuildError(cause)
                ? cause
                : targetAppBuildError("upload_invalid"),
            try: async () => {
              await mkdir(directory, { mode: 0o700 });
              return writeAppEntries(body, directory);
            },
          });
          const bundle = path.join(directory, name);
          const info = yield* readInfo(bundle);
          const missing = (
            [
              "CFBundleIdentifier",
              "CFBundleVersion",
              "CFBundleExecutable",
            ] as const
          ).filter((key) => (info[key] ?? "").trim() === "");
          if (missing.length > 0) {
            return yield* Effect.fail(
              targetAppBuildError(
                "info_plist_incomplete",
                `Info.plist lacks ${missing.join(", ")}.`
              )
            );
          }
          if (
            !(info.CFBundleSupportedPlatforms ?? []).includes("iPhoneSimulator")
          ) {
            return yield* Effect.fail(targetAppBuildError("device_build"));
          }
          const executable = info.CFBundleExecutable ?? "";
          const executablePath = path.join(bundle, executable);
          const present = yield* Effect.promise(() =>
            lstat(executablePath).then(
              (entry) => entry.isFile() && !executable.includes("/"),
              () => false
            )
          );
          if (!present) {
            return yield* Effect.fail(
              targetAppBuildError("executable_missing")
            );
          }
          yield* Effect.tryPromise({
            catch: () => targetAppBuildError("upload_invalid"),
            try: () => restoreExecutableBits(bundle, executable),
          });
          const bundleId = info.CFBundleIdentifier ?? "";
          return {
            appPath: bundle,
            build: info.CFBundleVersion ?? "",
            bundleId,
            id,
            label: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
            name,
          } satisfies UploadedIosApp;
        }).pipe(Effect.onError(() => remove(directory)));
        uploads.set(id, {
          claimed: false,
          directory,
          path: result.appPath,
          platform: "ios",
          sha256: null,
        });
        return result;
      });
    const receiveAndroid: TargetAppBuildsService["receiveAndroid"] = (
      body,
      name
    ) =>
      Effect.gen(function* receiveApk() {
        if (!name.toLowerCase().endsWith(".apk")) {
          return yield* Effect.fail(targetAppBuildError("not_apk"));
        }
        const id = randomUUID();
        const directory = path.join(root, id);
        const apkPath = path.join(directory, "target.apk");
        const result = yield* Effect.gen(function* inspect() {
          const sha256 = yield* Effect.tryPromise({
            catch: (cause) =>
              isBuildError(cause)
                ? cause
                : targetAppBuildError("upload_invalid"),
            try: async () => {
              await mkdir(directory, { mode: 0o700 });
              return writeApk(body, apkPath);
            },
          });
          const metadata = yield* readers
            .badging(apkPath)
            .pipe(
              Effect.mapError((cause) =>
                targetAppBuildError(
                  cause.code === "android_build_tools_missing"
                    ? "build_tools_missing"
                    : "apk_unreadable"
                )
              )
            );
          const app = parseApkBadging(metadata);
          if (app === undefined) {
            return yield* Effect.fail(targetAppBuildError("apk_incomplete"));
          }
          return { app, sha256 };
        }).pipe(Effect.onError(() => remove(directory)));
        uploads.set(id, {
          claimed: false,
          directory,
          path: apkPath,
          platform: "android",
          sha256: result.sha256,
        });
        return {
          apkPath,
          app: result.app,
          id,
          name,
        } satisfies UploadedAndroidApp;
      });
    return {
      claim: (platform, buildPath, scope) =>
        Effect.gen(function* claimUpload() {
          const found = [...uploads.entries()].find(
            ([, upload]) =>
              upload.path === buildPath &&
              upload.platform === platform &&
              !upload.claimed
          );
          if (found === undefined) {
            return yield* Effect.fail(targetAppBuildError("build_unknown"));
          }
          const [id, upload] = found;
          const exists = yield* Effect.promise(() =>
            stat(upload.path).then(
              () => true,
              () => false
            )
          );
          if (!exists) {
            uploads.delete(id);
            return yield* Effect.fail(targetAppBuildError("build_unknown"));
          }
          upload.claimed = true;
          yield* Scope.addFinalizer(scope, forget(id));
          return { path: upload.path, sha256: upload.sha256 };
        }),
      discard: (id) =>
        Effect.suspend(() =>
          uploads.get(id)?.claimed === false ? forget(id) : Effect.void
        ),
      receiveAndroid,
      receiveIos,
    } satisfies TargetAppBuildsService;
  });

export const TargetAppBuildsLive = Layer.effect(
  TargetAppBuilds,
  makeTargetAppBuilds()
);
