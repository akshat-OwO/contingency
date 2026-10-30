import { FlowSkillName, IosWorkspaceSelection } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  readFlowSkillFrontmatter,
  stampFlowSkillProvenance,
} from "../../src/services/flow-skill-package.ts";
import {
  browserRequirements,
  readPlatformRequirements,
} from "../../src/services/platform-requirements.ts";
import { isVerifiedFlowSkill } from "../../src/services/requested-flow-skills.ts";
import { skillRunEmulation } from "../../src/services/run-emulation.ts";

it.effect(
  "round-trips runtime requirements while retaining legacy browser Emulation",
  () =>
    Effect.gen(function* metadataCompatibility() {
      const legacy =
        "---\nname: phone\ndescription: Phone journey\nemulation:\n  viewport: 390x844@2\n  userAgentProfile: chrome-android-mobile\n---\n1. Continue\n   Done when: Complete\n";
      const before = readFlowSkillFrontmatter(legacy);
      expect(before?.runtime.requirements.platform).toBe("web");
      if (before?.emulation === undefined) {
        throw new Error("Missing legacy Emulation");
      }
      const saved = stampFlowSkillProvenance(legacy, {
        emulation: before.emulation,
        hosts: ["example.com"],
        runtime: browserRequirements,
      });
      const after = readFlowSkillFrontmatter(saved);
      if (after === undefined) {
        throw new Error("Missing stamped frontmatter");
      }
      expect(after?.runtime).toEqual({
        diagnostics: [],
        requirements: browserRequirements,
      });
      expect(after?.emulation).toEqual(before?.emulation);
      const effective = yield* skillRunEmulation({
        emulation: after?.emulation,
        name: FlowSkillName.make("phone"),
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
          skillRunEmulation({
            emulation: undefined,
            name: FlowSkillName.make("unsupported"),
            runtime: readPlatformRequirements([value]),
          })
        );
        expect(failed.code).toBe("flow_skill_invalid");
      }
      expect(readPlatformRequirements(["{}", "{}"]).diagnostics).toHaveLength(
        1
      );
    })
);

it.effect(
  "verification is platform-specific and old verification belongs to web",
  () =>
    Effect.sync(() => {
      const files = [
        {
          content: "- Verified: 2026-10-12\n",
          path: "references/verification.md",
        },
      ];
      expect(isVerifiedFlowSkill(files, "web")).toBe(true);
      expect(isVerifiedFlowSkill(files, "android")).toBe(false);
      const android = [
        {
          content: "- Verified: 2026-10-12\n- Platform: android\n",
          path: "references/verification.md",
        },
      ];
      expect(isVerifiedFlowSkill(android, "android")).toBe(true);
      expect(isVerifiedFlowSkill(android, "web")).toBe(false);
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

it("reads Android skills saved with the retired activation allowlist", () => {
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
