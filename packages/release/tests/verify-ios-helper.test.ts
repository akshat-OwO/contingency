import { describe, expect, it } from "vitest";

import {
  simulatorBooted,
  parseIntegratedDisplay,
  selectIosRuntime,
  validateHelperPacket,
  validateHelperArchitecture,
} from "../src/verify-ios-helper.ts";

const display = "A1B2C3D4-1234-1234-1234-123456789ABC";
const port = (id = display, kind = 0, surface = true) => `Port:
    UUID: ${id}
    Port Identifier: com.apple.framebuffer.display
    Display class: ${kind}
    Power state: On
${surface ? "    IOSurface port: 0x1234\n" : ""}`;

describe("integrated display inventory", () => {
  it("selects the integrated IOSurface UUID, ignoring external ports", () => {
    expect(
      parseIntegratedDisplay(
        `${port("00000000-0000-0000-0000-000000000000", 1)}${port()}`
      )
    ).toBe(display);
    expect(parseIntegratedDisplay(port().replaceAll("\n", "\r\n"))).toBe(
      display
    );
    expect(
      parseIntegratedDisplay(
        `${port().replace("Power state: On", "Power state: Off")}${port()}`
      )
    ).toBe(display);
  });
  it("binds the explicit primary integrated screen when an iPhone has two panels", () => {
    const primary = port().replace(
      "    Display class: 0\n",
      "    Display class: 0\n    Default width: 1398\n    Default height: 2034\n"
    );
    const secondary = port("00000000-0000-0000-0000-000000000000").replace(
      "    Display class: 0\n",
      "    Display class: 0\n    Default width: 2007\n    Default height: 2853\n"
    );
    const screen =
      "\n    (1) LCD:\n        Device Name: primary\n        Screen Type: Integrated\n        Pixel Size: {1398, 2034}\n";
    expect(parseIntegratedDisplay(`${secondary}${primary}${screen}`)).toBe(
      display
    );
    expect(() =>
      parseIntegratedDisplay(
        `${secondary}${primary}${screen.replace("Integrated", "TVOut")}`
      )
    ).toThrow();
    expect(() =>
      parseIntegratedDisplay(`${primary}${primary}${screen}`)
    ).toThrow();
  });
  it("refuses missing, external, malformed, and ambiguous ports", () => {
    for (const output of [
      "",
      port(display, 1),
      port(display, 0, false),
      port("invalid"),
      `${port()}${port()}`,
    ]) {
      expect(() => parseIntegratedDisplay(output)).toThrow();
    }
  });
});

const packet = {
  displayPort: display,
  height: 1566,
  sequence: 2,
  sourceSequence: 0,
  width: 720,
};
describe("helper packets", () => {
  it("accepts increasing sequences and a static source counter", () => {
    expect(
      validateHelperPacket(JSON.stringify(packet), display.toLowerCase(), 1)
    ).toEqual(packet);
  });
  it("rejects malformed packets, invalid sizes, counters, sequences, and identities", () => {
    for (const value of [
      null,
      {},
      { ...packet, width: 0 },
      { ...packet, height: -1 },
      { ...packet, sequence: 1 },
      { ...packet, sequence: 0.5 },
      { ...packet, sourceSequence: -1 },
      { ...packet, displayPort: "bad" },
      { ...packet, displayPort: "00000000-0000-0000-0000-000000000000" },
    ]) {
      expect(() =>
        validateHelperPacket(JSON.stringify(value), display, 1)
      ).toThrow();
    }
    expect(() => validateHelperPacket("not json", display, 1)).toThrow();
    expect(() =>
      validateHelperPacket(JSON.stringify(packet), display, 3)
    ).toThrow();
  });
});

const runtime = (version: string, isAvailable = true) => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`,
  isAvailable,
  name: `iOS ${version}`,
  supportedDeviceTypes: [{ identifier: "iphone", name: "iPhone 17" }],
  version,
});
describe("runtime selection", () => {
  it("uses numeric versions and skips unavailable and non-iOS runtimes", () => {
    const selected = selectIosRuntime(
      JSON.stringify({
        runtimes: [
          runtime("26.9"),
          runtime("26.10"),
          runtime("27.1", false),
          { ...runtime("99"), identifier: "tvOS" },
        ],
      })
    );
    expect(selected.runtime.version).toBe("26.10");
    expect(selected.device.identifier).toBe("iphone");
  });
  it("refuses missing iOS runtimes and unsupported newest runtimes", () => {
    expect(() => selectIosRuntime('{"runtimes":[]}')).toThrow();
    expect(() =>
      selectIosRuntime(
        JSON.stringify({
          runtimes: [
            runtime("26"),
            { ...runtime("27"), supportedDeviceTypes: [] },
          ],
        })
      )
    ).toThrow();
  });
});

describe("helper executing architecture", () => {
  it("accepts current and older native sample formats", () => {
    for (const [architecture, types] of [
      ["arm64", ["ARM64", "ARM-64 (Native)"]],
    ] as const) {
      for (const codeType of types) {
        expect(
          validateHelperArchitecture(
            `Process: framebuffer [123]\nCode Type: ${codeType}\n`,
            123,
            architecture
          ).codeType
        ).toBe(codeType);
      }
    }
  });
  it("rejects translation, wrong slices, unknown types, and other processes", () => {
    for (const [name, codeType, architecture] of [
      ["framebuffer [123]", "X86_64", "x86_64"],
      ["framebuffer [123]", "X86-64 (Native)", "x86_64"],
      ["framebuffer [123]", "X86-64 (Translated)", "x86_64"],
      ["framebuffer [123]", "ARM64", "x86_64"],
      ["framebuffer [123]", "unknown", "arm64"],
      ["arch [123]", "ARM64", "arm64"],
      ["framebuffer [456]", "ARM64", "arm64"],
    ] as const) {
      expect(() =>
        validateHelperArchitecture(
          `Process: ${name}\nCode Type: ${codeType}\n`,
          123,
          architecture
        )
      ).toThrow();
    }
  });
});

const bootInventory = (state: string) =>
  JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { state: "Shutdown", udid: "OTHER" },
        { state, udid: "OWNED" },
      ],
    },
  });

describe("simulator boot state", () => {
  it("reports only the owned simulator's state", () => {
    expect(simulatorBooted(bootInventory("Booted"), "OWNED")).toBe(true);
    expect(simulatorBooted(bootInventory("Booting"), "OWNED")).toBe(false);
  });
  it("refuses a simulator missing from the inventory", () => {
    expect(() => simulatorBooted(bootInventory("Booted"), "MISSING")).toThrow(
      "missing from the inventory"
    );
  });
});
