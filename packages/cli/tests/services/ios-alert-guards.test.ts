import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect } from "effect";

const AGENT_DEVICE_SRC = path.resolve(
  import.meta.dirname,
  "../../node_modules/agent-device/dist/src"
);

interface PatchedDevice {
  readonly appleOs?:
    | "ios"
    | "ipados"
    | "macos"
    | "tvos"
    | "visionos"
    | "watchos";
  readonly id: string;
  readonly kind: "device" | "emulator" | "simulator";
  readonly name: string;
  readonly platform: "android" | "apple" | "ios" | "linux" | "macos";
  readonly target?: "desktop" | "mobile" | "tv";
}

interface AlertTargetPayload {
  readonly alertAction?: "accept" | "dismiss" | "press";
  readonly appBundleId?: string;
  readonly buttonIndex?: number;
  readonly buttonLabel?: string;
  readonly expectedMessage?: string;
  readonly surface?: string;
}

interface AlertOperationResult {
  readonly data?: { readonly message?: string };
  readonly message?: string;
  readonly ok?: boolean;
}

interface EmptyContext {
  readonly signal?: AbortSignal;
}

type ActOnAlertFn = (
  device: PatchedDevice,
  execution: EmptyContext,
  action: "accept" | "dismiss" | "press",
  options?: AlertTargetPayload,
  env?: Record<string, string | undefined>
) => Promise<AlertOperationResult>;

type CreateAndroidInteractorFn = (
  device: PatchedDevice,
  options?: EmptyContext
) => {
  readonly acceptAlert: (
    options?: AlertTargetPayload
  ) => Promise<AlertOperationResult>;
  readonly dismissAlert: (
    options?: AlertTargetPayload
  ) => Promise<AlertOperationResult>;
};

interface SnapshotCommandArgs {
  readonly bindDevice: () => Promise<{
    readonly operations: {
      readonly acceptAlert: (
        options: AlertTargetPayload
      ) => Promise<AlertOperationResult>;
      readonly dismissAlert: () => Promise<AlertOperationResult>;
    };
  }>;
  readonly createCommandSurface: () => EmptyContext;
  readonly inspectFacts: () => Promise<{
    readonly operations: Record<string, { readonly available: boolean }>;
  }>;
  readonly logPath: string;
  readonly platformResourceCleanup: {
    readonly cleanupSessionlessExecutionHost: () => Promise<void>;
  };
  readonly platformServices: EmptyContext;
  readonly req: {
    readonly command: string;
    readonly flags?: EmptyContext;
    readonly input?: AlertTargetPayload;
    readonly positionals?: readonly string[];
  };
  readonly sessionName: string;
  readonly sessionStore: {
    readonly host: { readonly env: Record<string, string | undefined> };
    readonly lookup: (name: string) => string;
    readonly recordAction: () => void;
    readonly requireCurrent: (ref: string) => {
      readonly actions: readonly string[];
      readonly appBundleId?: string;
      readonly device: PatchedDevice;
      readonly name: string;
    };
    readonly resolveCurrent: (ref: string) => {
      readonly actions: readonly string[];
      readonly appBundleId?: string;
      readonly device: PatchedDevice;
      readonly name: string;
    };
  };
}

type HandleSnapshotCommandsFn = (
  input: SnapshotCommandArgs
) => Promise<AlertOperationResult | null>;

interface PatchedAlertModule {
  readonly t: ActOnAlertFn;
}

interface PatchedSnapshotModule {
  readonly handleSnapshotCommands: HandleSnapshotCommandsFn;
}

interface PatchedAndroidModule {
  readonly n: CreateAndroidInteractorFn;
}

const patchedModuleUrl = (filename: string): string =>
  pathToFileURL(path.join(AGENT_DEVICE_SRC, filename)).href;

const loadActOnAlert = async (): Promise<ActOnAlertFn> => {
  // SAFETY: Patched `agent-device/dist/src/alert.js` exports `actOnAlert` as `t`.
  const mod = (await import(
    patchedModuleUrl("alert.js")
  )) as PatchedAlertModule;
  return mod.t;
};

const loadHandleSnapshotCommands =
  async (): Promise<HandleSnapshotCommandsFn> => {
    // SAFETY: Patched `agent-device/dist/src/snapshot2.js` exports `handleSnapshotCommands`.
    const mod = (await import(
      patchedModuleUrl("snapshot2.js")
    )) as PatchedSnapshotModule;
    return mod.handleSnapshotCommands;
  };

const loadCreateAndroidInteractor =
  async (): Promise<CreateAndroidInteractorFn> => {
    // SAFETY: Patched `agent-device/dist/src/android2.js` exports `createAndroidInteractor` as `n`.
    const mod = (await import(
      patchedModuleUrl("android2.js")
    )) as PatchedAndroidModule;
    return mod.n;
  };

const expectUnsupportedGuard = async (
  promise: Promise<AlertOperationResult | null>
) => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  if (!(caught instanceof AppError)) {
    throw new Error("Expected AppError");
  }
  expect(caught.code).toBe("UNSUPPORTED_OPERATION");
  expect(caught.details?.["dispatched"]).toBe("no");
  expect(caught.details?.["reason"]).toBe("unsupported_alert_guard");
};

const macosDevice: PatchedDevice = {
  appleOs: "macos",
  id: "mac-local",
  kind: "device",
  name: "Mac",
  platform: "macos",
  target: "desktop",
};

const appleMacosDevice: PatchedDevice = {
  appleOs: "macos",
  id: "mac-apple-platform",
  kind: "device",
  name: "Mac",
  platform: "apple",
  target: "desktop",
};

const tvosDevice: PatchedDevice = {
  appleOs: "tvos",
  id: "tv-sim-1",
  kind: "simulator",
  name: "Apple TV",
  platform: "ios",
  target: "tv",
};

const androidDevice: PatchedDevice = {
  id: "emulator-5554",
  kind: "emulator",
  name: "Pixel",
  platform: "android",
  target: "mobile",
};

const iosDevice: PatchedDevice = {
  appleOs: "ios",
  id: "ios-sim-1",
  kind: "simulator",
  name: "iPhone 17",
  platform: "ios",
  target: "mobile",
};

const makeSnapshotArgs = (input: {
  readonly action: string;
  readonly device: PatchedDevice;
  readonly onAcceptAlert?: (options: AlertTargetPayload) => void;
  readonly onBindOrInspect?: () => void;
  readonly payload?: AlertTargetPayload;
}): SnapshotCommandArgs => ({
  bindDevice: () => {
    input.onBindOrInspect?.();
    return Promise.resolve({
      operations: {
        acceptAlert: (options: AlertTargetPayload) => {
          input.onAcceptAlert?.(options);
          return Promise.resolve({ message: "accepted" });
        },
        dismissAlert: () => Promise.resolve({ message: "dismissed" }),
      },
    });
  },
  createCommandSurface: () => ({}),
  inspectFacts: () => {
    input.onBindOrInspect?.();
    return Promise.resolve({
      operations: {
        acceptAlert: { available: true },
        awaitAlert: { available: true },
        dismissAlert: { available: true },
        readAlert: { available: true },
      },
    });
  },
  logPath: "/tmp/agent-device-test.log",
  platformResourceCleanup: {
    cleanupSessionlessExecutionHost: () => Promise.resolve(),
  },
  platformServices: {},
  req:
    input.payload === undefined
      ? {
          command: "alert",
          flags: {},
          positionals: [input.action],
        }
      : {
          command: "alert",
          flags: {},
          input: input.payload,
          positionals: [input.action],
        },
  sessionName: "test-session",
  sessionStore: {
    host: { env: {} },
    lookup: () => "session-ref",
    recordAction: () => {},
    requireCurrent: () => ({
      actions: [],
      appBundleId: "dev.contingency.test",
      device: input.device,
      name: "test-session",
    }),
    resolveCurrent: () => ({
      actions: [],
      appBundleId: "dev.contingency.test",
      device: input.device,
      name: "test-session",
    }),
  },
});

it.effect(
  "refuses alert press and guarded accept/dismiss on macOS and tvOS in patched alert.js before invoking the helper",
  () =>
    Effect.promise(async () => {
      const actOnAlert = await loadActOnAlert();

      await expectUnsupportedGuard(
        actOnAlert(macosDevice, {}, "press", {
          appBundleId: "com.example.mac",
          buttonLabel: "Allow",
        })
      );
      await expectUnsupportedGuard(
        actOnAlert(macosDevice, {}, "accept", {
          appBundleId: "com.example.mac",
          expectedMessage: "Allow Notifications?",
        })
      );
      await expectUnsupportedGuard(
        actOnAlert(appleMacosDevice, {}, "dismiss", {
          appBundleId: "com.example.mac",
          buttonIndex: 0,
        })
      );
      await expectUnsupportedGuard(
        actOnAlert(tvosDevice, {}, "accept", {
          appBundleId: "com.example.tv",
          expectedMessage: "Allow Notifications?",
        })
      );
    })
);

it.effect(
  "refuses alert press and guarded accept/dismiss on non-iOS backends in patched snapshot2.js while keeping unguarded macOS accept and guarded iOS press",
  () =>
    Effect.promise(async () => {
      const handleSnapshotCommands = await loadHandleSnapshotCommands();

      let sideEffects = 0;
      const bump = () => {
        sideEffects += 1;
      };

      await expectUnsupportedGuard(
        handleSnapshotCommands(
          makeSnapshotArgs({
            action: "accept",
            device: macosDevice,
            onBindOrInspect: bump,
            payload: { expectedMessage: "Allow Camera?" },
          })
        )
      );
      await expectUnsupportedGuard(
        handleSnapshotCommands(
          makeSnapshotArgs({
            action: "press",
            device: macosDevice,
            onBindOrInspect: bump,
            payload: { buttonLabel: "Allow" },
          })
        )
      );
      await expectUnsupportedGuard(
        handleSnapshotCommands(
          makeSnapshotArgs({
            action: "dismiss",
            device: androidDevice,
            onBindOrInspect: bump,
            payload: { buttonIndex: 1 },
          })
        )
      );
      expect(sideEffects).toBe(0);

      // Unguarded accept on macOS stays admitted and reaches the runtime operation.
      const macosCalls: AlertTargetPayload[] = [];
      await handleSnapshotCommands(
        makeSnapshotArgs({
          action: "accept",
          device: macosDevice,
          onAcceptAlert: (options) => {
            macosCalls.push(options);
          },
        })
      );
      expect(macosCalls).toHaveLength(1);

      // Guarded press on iOS stays admitted and forwards alertAction + selectors.
      const iosCalls: AlertTargetPayload[] = [];
      await handleSnapshotCommands(
        makeSnapshotArgs({
          action: "press",
          device: iosDevice,
          onAcceptAlert: (options) => {
            iosCalls.push(options);
          },
          payload: {
            buttonLabel: "Allow Once",
            expectedMessage: "Allow Location?",
          },
        })
      );
      expect(iosCalls).toHaveLength(1);
      expect(iosCalls[0]?.alertAction).toBe("press");
      expect(iosCalls[0]?.buttonLabel).toBe("Allow Once");
      expect(iosCalls[0]?.expectedMessage).toBe("Allow Location?");
    })
);

it.effect(
  "refuses alert press and guarded accept/dismiss on the patched Android interactor before dispatching input",
  () =>
    Effect.promise(async () => {
      const createAndroidInteractor = await loadCreateAndroidInteractor();
      const interactor = createAndroidInteractor(androidDevice, {});

      await expectUnsupportedGuard(
        interactor.acceptAlert({ expectedMessage: "Allow Notifications?" })
      );
      await expectUnsupportedGuard(
        interactor.acceptAlert({ alertAction: "press", buttonLabel: "Allow" })
      );
      await expectUnsupportedGuard(interactor.dismissAlert({ buttonIndex: 0 }));
    })
);
