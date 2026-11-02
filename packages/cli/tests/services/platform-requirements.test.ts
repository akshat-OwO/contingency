import { FlowName, IosWorkspaceSelection } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  readFlowFrontmatter,
  stampFlowProvenance,
  stampFlowVerification,
} from "../../src/services/flow-package.ts";
import {
  browserRequirements,
  readPlatformRequirements,
} from "../../src/services/platform-requirements.ts";
import { isVerifiedFlow } from "../../src/services/requested-flows.ts";
import { flowRunEmulation } from "../../src/services/run-emulation.ts";

it.effect(
  "round-trips runtime requirements while retaining legacy browser Emulation",
  () =>
    Effect.gen(function* metadataCompatibility() {
      const legacy =
        "---\nname: phone\ndescription: Phone journey\nemulation:\n  viewport: 390x844@2\n  userAgentProfile: chrome-android-mobile\n---\n1. Continue\n   Done when: Complete\n";
      const before = readFlowFrontmatter(legacy);
      expect(before?.runtime.requirements.platform).toBe("web");
      if (before?.emulation === undefined) {
        throw new Error("Missing legacy Emulation");
      }
      const saved = stampFlowProvenance(legacy, {
        emulation: before.emulation,
        hosts: ["example.com"],
        runtime: browserRequirements,
      });
      const after = readFlowFrontmatter(saved);
      if (after === undefined) {
        throw new Error("Missing stamped frontmatter");
      }
      expect(after?.runtime).toEqual({
        diagnostics: [],
        requirements: browserRequirements,
      });
      expect(after?.emulation).toEqual(before?.emulation);
      const effective = yield* flowRunEmulation({
        emulation: after?.emulation,
        name: FlowName.make("phone"),
        runtime: after?.runtime,
      });
      expect(effective?.viewport).toEqual({
        deviceScaleFactor: 2,
        height: 844,
        width: 390,
      });
    })
);

it.effect(
  "refuses unknown requirements and Android before browser execution",
  () =>
    Effect.gen(function* rejectRuntimeMetadata() {
      for (const value of [
        "not-json",
        "{}",
        JSON.stringify({ ...browserRequirements, platform: "ios" }),
        JSON.stringify({ ...browserRequirements, capabilities: ["unknown"] }),
        JSON.stringify({
          ...browserRequirements,
          environment: { engine: "firefox" },
        }),
        JSON.stringify({
          ...browserRequirements,
          environment: { engine: "chromium", ignored: true },
        }),
        JSON.stringify({ ...browserRequirements, ignored: true }),
        JSON.stringify({
          capabilities: [],
          environment: {
            androidVersion: "16",
            appBuild: "42",
            appId: "example.app",
            startingState: "baseline",
          },
          platform: "android",
        }),
      ]) {
        const failed = yield* Effect.flip(
          flowRunEmulation({
            emulation: undefined,
            name: FlowName.make("unsupported"),
            runtime: readPlatformRequirements([value]),
          })
        );
        expect(failed.code).toBe("flow_invalid");
      }
      expect(readPlatformRequirements(["{}", "{}"]).diagnostics).toHaveLength(
        1
      );
    })
);

const verified = (platform: "web" | "android") => [
  {
    content: stampFlowVerification("---\nname: test\n---\n", {
      completedAt: "now",
      inputs: [],
      observableOutcome: "Ready",
      outcome: "passed",
      platform,
      verifiedAt: "now",
    }),
    path: "flow.md",
  },
];

it.effect("verification is platform-specific", () =>
  Effect.sync(() => {
    expect(isVerifiedFlow(verified("web"), "web")).toBe(true);
    expect(isVerifiedFlow(verified("web"), "android")).toBe(false);
    expect(isVerifiedFlow(verified("android"), "android")).toBe(true);
    expect(isVerifiedFlow(verified("android"), "web")).toBe(false);
  })
);

it.effect("persists declared Android preparation in saved requirements", () =>
  Effect.sync(() => {
    const requirements = {
      capabilities: ["semantic-actions", "screenshots"],
      environment: {
        androidVersion: "16",
        appBuild: "36",
        appId: "com.android.settings",
        startingState: "fresh About device",
      },
      platform: "android",
      preparation: {
        activity: "com.android.settings/.Settings$MyDeviceInfoActivity",
        conditions: [{ name: "Device name", role: "text" }],
        kind: "restart-activity",
      },
    };
    expect(readPlatformRequirements([JSON.stringify(requirements)])).toEqual({
      diagnostics: [],
      requirements,
    });
    expect(
      readPlatformRequirements([
        JSON.stringify({
          ...requirements,
          preparation: {
            ...requirements.preparation,
            kind: "restore-snapshot",
          },
        }),
      ]).diagnostics
    ).toHaveLength(1);
  })
);

it("reads Android flows saved with the retired activation allowlist", () => {
  const environment = {
    androidVersion: "16",
    appBuild: "2",
    appId: "dev.fixture",
    startingState: "fresh home",
  };
  const saved = readPlatformRequirements([
    JSON.stringify({
      capabilities: ["semantic-actions"],
      environment,
      platform: "android",
      reversibleActions: [{ name: "Open account", role: "button" }],
    }),
  ]);
  expect(saved).toEqual({
    diagnostics: [],
    requirements: {
      capabilities: ["semantic-actions"],
      environment,
      platform: "android",
    },
  });
});

it("discards the retired iOS activation allowlist", () => {
  const environment = {
    build: "1",
    bundleId: "fixture.app",
    deviceType: "iPhone",
    runtimeVersion: "26.5",
  };
  const saved = readPlatformRequirements([
    JSON.stringify({
      capabilities: ["semantic-actions"],
      environment,
      platform: "ios",
      reversibleActions: [{ name: "Sign in", role: "button" }],
    }),
  ]);
  expect(saved).toEqual({
    diagnostics: [],
    requirements: {
      capabilities: ["semantic-actions"],
      environment,
      platform: "ios",
    },
  });
});

it.effect("round-trips declared iOS starting permission states", () =>
  Effect.gen(function* iosPermissionDeclaration() {
    const environment = {
      build: "1",
      bundleId: "fixture.app",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      permissions: [
        { decision: "revoke", service: "location" },
        { decision: "grant", service: "photos" },
        { decision: "reset", service: "contacts" },
      ],
      runtimeVersion: "26.5",
    } as const;
    const requirements = {
      capabilities: ["semantic-actions"],
      environment,
      platform: "ios",
    };
    expect(readPlatformRequirements([JSON.stringify(requirements)])).toEqual({
      diagnostics: [],
      requirements,
    });
    const selection = {
      device: {
        deviceType: environment.deviceType,
        kind: "simulator",
        name: "Selected",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        runtimeVersion: "26.5",
        udid: "11111111-1111-1111-1111-111111111111",
      },
      environment,
      outcomes: [{ name: "Signed in", role: "text" }],
      setup: {
        conditions: [{ name: "Sign in", role: "button" }],
        kind: "restart-app",
      },
    };
    const decoded = yield* Schema.decodeUnknownEffect(IosWorkspaceSelection)(
      selection
    );
    expect(yield* Schema.encodeEffect(IosWorkspaceSelection)(decoded)).toEqual(
      selection
    );
    expect(
      readPlatformRequirements([
        JSON.stringify({
          ...requirements,
          environment: {
            ...environment,
            permissions: [{ decision: "allow", service: "photos" }],
          },
        }),
      ]).diagnostics
    ).toHaveLength(1);
  })
);
