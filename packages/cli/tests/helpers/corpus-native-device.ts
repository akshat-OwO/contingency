import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import type {
  AndroidWorkspaceSelection,
  NativeInput,
} from "@contingency/protocol";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  androidNodeInteraction,
  androidNodeName,
} from "../../src/services/android-observation.ts";
import type { AndroidRunInput } from "../../src/services/android-run-contract.ts";
import { createAndroidRun } from "../../src/services/android-run.ts";
import type {
  AndroidDeviceSelection,
  AndroidObservation,
  AndroidRuntimeBackend,
} from "../../src/services/android-runtime-contract.ts";
import { adaptAndroidRuntime } from "../../src/services/android-runtime.ts";
import type { AndroidDeviceStream } from "../../src/services/android-stream.ts";
import { makeAndroidWorkspaceLayer } from "../../src/services/android-workspace.ts";
import type { IosDevice } from "../../src/services/ios-contract.ts";
import {
  iosNodeInteraction,
  iosNodeName,
} from "../../src/services/ios-observation.ts";
import { iosRuntimeError } from "../../src/services/ios-runtime.ts";
import type { IosObservation } from "../../src/services/ios-runtime.ts";
import { nativeHitTest } from "../../src/services/native-app-hit-test.ts";
import type {
  NativeAppPlatform,
  NativeAppRuntimeBackend,
  NativeCaptureOptions,
} from "../../src/services/native-app-runtime-contract.ts";
import { makeGestureRecognizer } from "../../src/services/native-forwarded-input.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import { PlatformRuntimeFactory } from "../../src/services/platform-runtime.ts";
import type { PlatformRuntimeError } from "../../src/services/platform-runtime.ts";
import {
  fakeAndroidAdb,
  fakeAndroidDevice,
} from "../services/fake-android-adb.ts";

const FIXTURES_ROOT = path.join(
  import.meta.dirname,
  "../fixtures/native-snapshots"
);

const CapturedRect = Schema.Struct({
  height: Schema.Number,
  width: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
});

const CapturedNode = Schema.Struct({
  bundleId: Schema.optionalKey(Schema.String),
  depth: Schema.optionalKey(Schema.Number),
  editable: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  hittable: Schema.optionalKey(Schema.Boolean),
  identifier: Schema.optionalKey(Schema.String),
  index: Schema.Number,
  interactionBlocked: Schema.optionalKey(Schema.Literal("covered")),
  kind: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  parentIndex: Schema.optionalKey(Schema.Number),
  password: Schema.optionalKey(Schema.Boolean),
  rect: Schema.optionalKey(CapturedRect),
  ref: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});

const CaptureFile = Schema.Struct({
  capturedAt: Schema.String,
  nodes: Schema.Array(CapturedNode),
  platform: Schema.Literals(["android", "ios"]),
  source: Schema.Struct({
    app: Schema.String,
    corpus: Schema.Boolean,
    screen: Schema.String,
  }),
  viewport: Schema.Struct({
    height: Schema.Number,
    width: Schema.Number,
  }),
});

export interface CorpusCapture extends Schema.Schema.Type<typeof CaptureFile> {
  readonly id: string;
}

export interface CorpusControl {
  readonly name: string;
  readonly role: string;
}

export interface CorpusTransition {
  readonly from: string;
  readonly on: {
    readonly action: "activate" | "fill";
    readonly name: string;
    readonly role: string;
  };
  readonly to: string;
}

export interface CorpusScript {
  readonly start: string;
  readonly transitions: readonly CorpusTransition[];
}

export interface CorpusNativeDevice<
  Backend extends NativeAppRuntimeBackend<AndroidObservation | IosObservation>,
> {
  readonly backend: Backend;
  readonly captures: () => number;
  readonly controlCenter: (
    captureId: string,
    control: CorpusControl
  ) => { readonly x: number; readonly y: number };
  readonly currentCapture: () => string;
  /** Fails every capture as `capture_incomplete` until `recover` runs. */
  readonly failCapturesUntilRecover: () => void;
  /** Fails the next `count` captures as `capture_incomplete`. */
  readonly failNextCaptures: (count: number) => void;
  /** Applies Forwarded Input taps to the scripted screen graph. */
  readonly forwardInputs: (inputs: readonly NativeInput[]) => void;
  readonly recoveries: () => number;
  /** Returns the device to the script's start capture, as app restart does. */
  readonly reset: () => void;
}

/** Synthesized PNG cache keyed by `${width}x${height}`. */
const pngCache = new Map<string, string>();
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      // oxlint-disable-next-line eslint/no-bitwise -- Standard IEEE 802.3 CRC-32 polynomial.
      value = (value & 1) === 0 ? value >>> 1 : 0xed_b8_83_20 ^ (value >>> 1);
    }
    // oxlint-disable-next-line eslint/no-bitwise -- Unsigned 32-bit CRC entry.
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    // oxlint-disable-next-line eslint/no-bitwise -- Standard CRC-32 accumulation.
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  // oxlint-disable-next-line eslint/no-bitwise -- Final CRC-32 XOR.
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array) => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length
  );
  return chunk;
};

/**
 * Synthesizes a valid minimal grayscale PNG of exact pixel dimensions.
 * Cached per size so captures pay no repeated compression cost.
 */
export const synthesizePngBase64 = (width: number, height: number): string => {
  const key = `${width}x${height}`;
  const cached = pngCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  // 1-bit grayscale, deflate, standard filter, non-interlaced.
  ihdr[8] = 1;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowBytes = 1 + Math.ceil(width / 8);
  const raw = Buffer.alloc(rowBytes * height);
  const compressed = deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
  pngCache.set(key, png);
  return png;
};

const captureCache = new Map<string, CorpusCapture>();

const readCaptureFile = (
  platform: NativeAppPlatform,
  fileId: string
): CorpusCapture | undefined => {
  const cacheKey = `${platform}:${fileId}`;
  const cached = captureCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const fullPath = path.join(FIXTURES_ROOT, platform, `${fileId}.json`);
  let text: string;
  try {
    text = readFileSync(fullPath, "utf-8");
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownSync(CaptureFile)(JSON.parse(text));
  const capture: CorpusCapture = { ...decoded, id: fileId };
  captureCache.set(cacheKey, capture);
  return capture;
};

/**
 * Loads one capture from `tests/fixtures/native-snapshots/{platform}`.
 * Accepts either the file id (e.g. `corpus-controls`) or the widget corpus
 * screen name (e.g. `controls`).
 */
export const loadCorpusCapture = (
  platform: NativeAppPlatform,
  idOrScreen: string
): CorpusCapture => {
  const direct = readCaptureFile(platform, idOrScreen);
  if (direct !== undefined) {
    return direct;
  }
  const prefixed = readCaptureFile(platform, `corpus-${idOrScreen}`);
  if (
    prefixed !== undefined &&
    prefixed.source.corpus &&
    prefixed.source.screen === idOrScreen
  ) {
    return prefixed;
  }
  throw new Error(
    `Corpus capture "${idOrScreen}" was not found for platform "${platform}".`
  );
};

interface MappedNode {
  readonly bounds?: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly covered: boolean;
  readonly editable: boolean;
  readonly hittable: boolean;
  readonly name: string;
  readonly packageName: string | null;
  readonly password: boolean;
  readonly role: string;
  readonly target: string;
}

const mapNodes = (
  platform: NativeAppPlatform,
  capture: CorpusCapture,
  generation: number
): readonly MappedNode[] =>
  capture.nodes.map((node, index) => {
    const target =
      node.ref === undefined
        ? ""
        : `@${node.ref.replace(/^@/u, "")}~s${generation}`;
    const interaction =
      platform === "android"
        ? androidNodeInteraction(node)
        : iosNodeInteraction(node);
    const name =
      platform === "android"
        ? androidNodeName(capture.nodes, index)
        : iosNodeName(capture.nodes, index);
    const packageName =
      platform === "android"
        ? (node.bundleId ?? null)
        : (node.bundleId ?? capture.source.app);
    const observed: MappedNode = {
      ...interaction,
      editable: target !== "" && interaction.editable,
      hittable: target !== "" && interaction.hittable,
      name,
      packageName,
      target,
    };
    return node.rect === undefined
      ? observed
      : { ...observed, bounds: node.rect };
  });

const generationPattern = /~s(?<generation>\d+)$/u;

const runtimeErrorFor = (
  platform: NativeAppPlatform,
  code: "capture_incomplete" | "runtime_failed"
): PlatformRuntimeError =>
  platform === "ios" ? iosRuntimeError(code) : platformRuntimeError(code);

const validateScript = (platform: NativeAppPlatform, script: CorpusScript) => {
  const captures = new Map<string, CorpusCapture>();
  const ensureCapture = (name: string) => {
    const existing = captures.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const loaded = loadCorpusCapture(platform, name);
    captures.set(name, loaded);
    return loaded;
  };
  ensureCapture(script.start);
  for (const transition of script.transitions) {
    const fromCapture = ensureCapture(transition.from);
    ensureCapture(transition.to);
    const nodes = mapNodes(platform, fromCapture, 1);
    const match = nodes.find(
      (node) =>
        node.role === transition.on.role &&
        node.name === transition.on.name &&
        !node.covered &&
        (transition.on.action !== "fill" || node.editable)
    );
    if (match === undefined) {
      throw new Error(
        `Corpus script transition control not found in capture "${transition.from}": ${transition.on.role} "${transition.on.name}".`
      );
    }
  }
  return captures;
};

interface CorpusAndroidBackendOptions {
  readonly device: AndroidDeviceSelection;
  readonly platform: "android";
  readonly script: CorpusScript;
  readonly sessionId?: string;
}

interface CorpusIosBackendOptions {
  readonly device: IosDevice;
  readonly platform: "ios";
  readonly script: CorpusScript;
  readonly sessionId?: string;
}

export function makeCorpusNativeBackend(
  options: CorpusAndroidBackendOptions
): CorpusNativeDevice<AndroidRuntimeBackend>;
export function makeCorpusNativeBackend(
  options: CorpusIosBackendOptions
): CorpusNativeDevice<NativeAppRuntimeBackend<IosObservation>>;
export function makeCorpusNativeBackend(
  options: CorpusAndroidBackendOptions | CorpusIosBackendOptions
): CorpusNativeDevice<
  AndroidRuntimeBackend | NativeAppRuntimeBackend<IosObservation>
> {
  const captures = validateScript(options.platform, options.script);
  const sessionId = options.sessionId ?? `corpus-${options.platform}-session`;
  let currentId = options.script.start;
  let generation = 0;
  let captureCount = 0;
  let recoveryCount = 0;
  let failRemaining = 0;
  let failUntilRecover = false;
  let activeNodes = new Map<string, MappedNode>();
  const recognizer = makeGestureRecognizer();
  let forwardedSequence = 0;

  const currentCapture = () => {
    const found = captures.get(currentId);
    if (found === undefined) {
      throw new Error(`Missing loaded corpus capture "${currentId}".`);
    }
    return found;
  };

  const transitionFor = (
    action: "activate" | "fill",
    node: Pick<MappedNode, "name" | "role">
  ) =>
    options.script.transitions.find(
      (candidate) =>
        candidate.from === currentId &&
        candidate.on.action === action &&
        candidate.on.role === node.role &&
        candidate.on.name === node.name
    );

  const resolveTarget = (
    target: string,
    operation: "activate" | "fill"
  ): Effect.Effect<MappedNode, PlatformRuntimeError> =>
    Effect.suspend<MappedNode, PlatformRuntimeError, never>(() => {
      const match = generationPattern.exec(target)?.groups?.["generation"];
      if (match !== undefined && Number(match) !== generation) {
        return Effect.fail({
          ...runtimeErrorFor(options.platform, "runtime_failed"),
          backendReason: "ref_generation_mismatch",
          operation,
        });
      }
      const node = activeNodes.get(target);
      if (node === undefined) {
        return Effect.fail({
          ...runtimeErrorFor(options.platform, "runtime_failed"),
          backendReason: "stale_ref",
          operation,
        });
      }
      return Effect.succeed(node);
    });

  const capture = (
    captureOptions?: NativeCaptureOptions
  ): Effect.Effect<AndroidObservation | IosObservation, PlatformRuntimeError> =>
    Effect.suspend<
      AndroidObservation | IosObservation,
      PlatformRuntimeError,
      never
    >(() => {
      captureCount += 1;
      if (failUntilRecover || failRemaining > 0) {
        if (failRemaining > 0) {
          failRemaining -= 1;
        }
        return Effect.fail({
          ...runtimeErrorFor(options.platform, "capture_incomplete"),
          operation: "capture",
        });
      }
      generation += 1;
      const screen = currentCapture();
      const nodes = mapNodes(options.platform, screen, generation);
      activeNodes = new Map(
        nodes.flatMap((node) =>
          node.target === "" ? [] : [[node.target, node]]
        )
      );
      const { height, width } = screen.viewport;
      const screenshot = {
        capturedAt: screen.capturedAt,
        encoding: "base64" as const,
        format: "png" as const,
        image:
          captureOptions?.image === false
            ? ""
            : synthesizePngBase64(width, height),
      };
      if (options.platform === "android") {
        const observation: AndroidObservation = {
          backendSessionId: sessionId,
          capture: {
            complete: true,
            mode: "interactive-windows",
            secureWindowVisibility: "unverified",
            windowCount: 1,
          },
          device: options.device,
          frame: { height, width },
          generation,
          id: `${sessionId}-obs-${generation}`,
          nodes,
          ownership: {
            focusedPackage: screen.source.app,
            kind: "experimental-host-check",
            systemDialogAuthority: "unsupported",
          },
          platform: "android",
          screenshot,
        };
        return Effect.succeed(observation);
      }
      const observation: IosObservation = {
        appId: screen.source.app,
        backendSessionId: sessionId,
        device: options.device,
        frame: { height, width },
        generation,
        id: `${sessionId}-obs-${generation}`,
        nodes,
        platform: "ios",
        screenshot,
      };
      return Effect.succeed(observation);
    });

  const activate = (target: string) =>
    resolveTarget(target, "activate").pipe(
      Effect.tap((node) =>
        Effect.sync(() => {
          const next = transitionFor("activate", node);
          if (next !== undefined) {
            currentId = next.to;
          }
        })
      ),
      Effect.asVoid
    );

  const fill = (target: string, _text: string) =>
    resolveTarget(target, "fill").pipe(
      Effect.map((node) => {
        const next = transitionFor("fill", node);
        if (next !== undefined) {
          currentId = next.to;
        }
        return {
          confirmation: node.password
            ? ("unconfirmed" as const)
            : ("confirmed" as const),
          outcome: "entered" as const,
        };
      })
    );

  const recover = () =>
    Effect.sync(() => {
      recoveryCount += 1;
      failUntilRecover = false;
    });

  const baseBackend = {
    activate,
    capture,
    close: () => Effect.void,
    fill,
    recover,
    sessionId,
    systemKey: () => Effect.void,
    validate: () => Effect.void,
  };
  const backend =
    options.platform === "ios"
      ? { ...baseBackend, rotate: () => Effect.void }
      : baseBackend;

  return {
    // SAFETY: `capture` produces AndroidObservation when platform is "android"
    // and IosObservation when platform is "ios", matching the overload signatures.
    backend: backend as
      | AndroidRuntimeBackend
      | NativeAppRuntimeBackend<IosObservation>,
    captures: () => captureCount,
    controlCenter: (captureId, control) => {
      const screen =
        captures.get(captureId) ??
        loadCorpusCapture(options.platform, captureId);
      const nodes = mapNodes(options.platform, screen, 1);
      const found = nodes.find(
        (node) => node.role === control.role && node.name === control.name
      );
      if (found?.bounds === undefined) {
        throw new Error(
          `Control ${control.role} "${control.name}" has no bounds in capture "${captureId}".`
        );
      }
      return {
        x: (found.bounds.x + found.bounds.width / 2) / screen.viewport.width,
        y: (found.bounds.y + found.bounds.height / 2) / screen.viewport.height,
      };
    },
    currentCapture: () => currentId,
    failCapturesUntilRecover: () => {
      failUntilRecover = true;
    },
    failNextCaptures: (count) => {
      failRemaining = count;
    },
    forwardInputs: (inputs) => {
      for (const input of inputs) {
        forwardedSequence += 1;
        for (const { gesture } of recognizer.feed(input, forwardedSequence)) {
          if (gesture._tag !== "tap") {
            continue;
          }
          const screen = currentCapture();
          const nodes = mapNodes(options.platform, screen, generation || 1);
          const hit = nativeHitTest(
            nodes,
            gesture.x * screen.viewport.width,
            gesture.y * screen.viewport.height
          );
          if (hit === undefined || hit.covered) {
            continue;
          }
          const next = transitionFor("activate", hit);
          if (next !== undefined) {
            currentId = next.to;
          }
        }
      }
    },
    recoveries: () => recoveryCount,
    reset: () => {
      currentId = options.script.start;
      recognizer.reset();
    },
  };
}

export const ANDROID_WIDGET_APP = "dev.contingency.physicalfixture";

export const ANDROID_WIDGET_SCRIPT: CorpusScript = {
  start: "controls",
  transitions: [
    {
      from: "controls",
      on: { action: "activate", name: "SHOW ALERT", role: "button" },
      to: "alert",
    },
    {
      from: "controls",
      on: { action: "activate", name: "SHOW BOTTOM SHEET", role: "button" },
      to: "bottom-sheet",
    },
    {
      from: "bottom-sheet",
      on: { action: "activate", name: "CLOSE SHEET", role: "button" },
      to: "controls",
    },
  ],
};

export const corpusAndroidSelection = (
  overrides: {
    readonly outcomes?: AndroidWorkspaceSelection["outcomes"];
    readonly conditions?: AndroidWorkspaceSelection["setup"]["conditions"];
  } = {}
): AndroidWorkspaceSelection => ({
  device: {
    api: 36,
    avd: "fixture",
    fingerprint: "fixture",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "2",
    appId: ANDROID_WIDGET_APP,
    startingState: "Controls",
  },
  helperConsent: "none",
  outcomes: overrides.outcomes ?? [{ name: "Last action: none", role: "text" }],
  setup: {
    activity: `${ANDROID_WIDGET_APP}/.MainActivity`,
    conditions: overrides.conditions ?? [
      { name: "Last action: none", role: "text" },
    ],
    kind: "restart-activity",
  },
});

const makeCorpusAndroidStream = (
  device: CorpusNativeDevice<AndroidRuntimeBackend>
): AndroidDeviceStream => ({
  access: { path: "/android/stream/corpus", token: "corpus" },
  authorized: () => false,
  forward: (inputs) =>
    Effect.sync(() => {
      device.forwardInputs(inputs);
    }),
  frames: Stream.empty,
  packets: Stream.empty,
});

/**
 * Builds an `AndroidWorkspace` layer backed by a corpus fake device.
 * Depends on the process's `FlowCatalog`, `TeachingRecordingStore`, and
 * `FileSystem` so it shares persisted Flows and recordings with MCP tools.
 */
export const makeCorpusAndroidWorkspaceLayer = (options: {
  readonly device: CorpusNativeDevice<AndroidRuntimeBackend>;
  readonly installedBuild?: string;
  readonly root: () => string;
}) => {
  const androidFactory = {
    capabilities: [
      "semantic-actions",
      "screenshots",
      "private-input",
      "teaching-capture",
      "emulation",
    ] as const,
    createRun: (input: AndroidRunInput) =>
      createAndroidRun(input, {
        installedBuild: () => Effect.succeed(options.installedBuild ?? "2"),
        preflight: () => Effect.void,
        restart: () =>
          Effect.sync(() => {
            options.device.reset();
          }),
        start: (startup) =>
          Effect.sync(() => {
            options.device.reset();
          }).pipe(
            Effect.andThen(
              adaptAndroidRuntime({ backend: options.device.backend, startup })
            )
          ),
      }),
    platform: "android" as const,
    start: () => Effect.fail(platformRuntimeError("runtime_failed")),
  };
  const runtimeFactory = Layer.succeed(PlatformRuntimeFactory, {
    android: androidFactory,
    start: () => Effect.fail(platformRuntimeError("runtime_failed")),
    web: {
      capabilities: [],
      platform: "web",
      start: () => Effect.die("unused"),
    },
  });
  return makeAndroidWorkspaceLayer({
    acquireStream: () =>
      Effect.succeed(makeCorpusAndroidStream(options.device)),
    adb: fakeAndroidAdb(fakeAndroidDevice()),
    root: options.root,
  }).pipe(Layer.provide(runtimeFactory));
};
