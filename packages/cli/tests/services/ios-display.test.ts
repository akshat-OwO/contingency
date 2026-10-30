import {
  IosWorkspaceCommand,
  PlatformRequirements,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  activeIosDisplay,
  iosDisplayOrientation,
} from "../../src/services/ios-stream.ts";
import { readPlatformRequirements } from "../../src/services/platform-requirements.ts";

const integrated = "11111111-1111-1111-1111-111111111111";
const external = "22222222-2222-2222-2222-222222222222";
const port = (id: string, displayClass: number, width: number) =>
  `Port:\n    UUID: ${id}\n    Port Identifier: com.apple.framebuffer.display\n    Power state: On\n    Display class: ${displayClass}\n    Default width: ${width}\n    IOSurface port:\n        width = ${width}\n`;
const inventory = `${port(external, 1, 5000)}${port(integrated, 0, 1206)}Screen Type: Integrated\n`;

it("selects the one integrated surface even when an external surface is larger", () => {
  expect(activeIosDisplay(inventory)).toBe(integrated);
});
it("refuses missing, off, or ambiguous integrated displays", () => {
  expect(activeIosDisplay(port(external, 1, 5000))).toBe(null);
  expect(
    activeIosDisplay(
      inventory
        .replace("Power state: On", "Power state: Off")
        .replaceAll("Power state: On", "Power state: Off")
    )
  ).toBe(null);
  expect(activeIosDisplay(`${inventory}${port(external, 0, 800)}`)).toBe(null);
  expect(activeIosDisplay(`${inventory}Screen Type: Integrated\n`)).toBe(null);
});
it("accepts a replacement only when it again proves a unique integrated display", () => {
  const replaced = inventory.replace(
    integrated,
    "33333333-3333-3333-3333-333333333333"
  );
  expect(activeIosDisplay(replaced)).toBe(
    "33333333-3333-3333-3333-333333333333"
  );
  expect(
    activeIosDisplay(
      replaced
        .replace("IOSurface port:", "Disconnected:")
        .replace("IOSurface port:", "Disconnected:")
    )
  ).toBe(null);
});
it("round-trips stamped iOS requirements without treating them as web or Android", () => {
  const runtime = {
    capabilities: ["semantic-actions", "screenshots"],
    environment: {
      build: "1",
      bundleId: "dev.contingency.ioslogin",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      runtimeVersion: "26.5",
    },
    platform: "ios",
  };
  const saved = readPlatformRequirements([JSON.stringify(runtime)]);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.requirements).toEqual(runtime);
  expect(
    Schema.decodeUnknownResult(PlatformRequirements)({
      ...runtime,
      platform: "android",
    })._tag
  ).toBe("Failure");
});
it("does not admit raw-coordinate commands or private-value transport", () => {
  const decode = Schema.decodeUnknownResult(IosWorkspaceCommand);
  expect(
    decode({
      _tag: "input",
      action: { _tag: "coordinate", x: 1, y: 2 },
      observationId: "one",
      operationId: "one",
      sessionId: "agent-ios-one",
    })._tag
  ).toBe("Failure");
});

it("refuses a second powered integrated port even before it supplies pixels", () => {
  expect(
    activeIosDisplay(
      `${inventory}${port(external, 0, 800).replace("IOSurface port:", "Pending surface:")}`
    )
  ).toBe(null);
});
it("reads orientation only from the positively identified integrated display", () => {
  for (const [display, expected] of [
    ["Portrait", "portrait"],
    ["Portrait Upside Down", "portrait-upside-down"],
    ["Landscape Left", "landscape-left"],
    ["Landscape Right", "landscape-right"],
  ]) {
    expect(
      iosDisplayOrientation(`${inventory}UI Orientation: ${display}\n`)
    ).toBe(expected);
  }
  expect(iosDisplayOrientation(`${inventory}UI Orientation: Ambiguous\n`)).toBe(
    null
  );
});
