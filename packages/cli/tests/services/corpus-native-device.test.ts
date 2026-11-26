import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ANDROID_WIDGET_APP,
  ANDROID_WIDGET_SCRIPT,
  IOS_WIDGET_SCRIPT,
  corpusAndroidSelection,
  corpusIosSimulator,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";

const androidDevice = corpusAndroidSelection().device;
const iosDevice = corpusIosSimulator;

describe("corpus-backed fake native device", () => {
  it("fails at load with capture id and control name when a transition names an absent control", () => {
    expect(() =>
      makeCorpusNativeBackend({
        device: androidDevice,
        platform: "android",
        script: {
          start: "controls",
          transitions: [
            {
              from: "controls",
              on: {
                action: "activate",
                name: "NONEXISTENT BUTTON",
                role: "button",
              },
              to: "alert",
            },
          ],
        },
      })
    ).toThrow(/controls.*NONEXISTENT BUTTON/u);
  });

  it("fails at load with the capture id when a script names a missing capture", () => {
    expect(() =>
      makeCorpusNativeBackend({
        device: androidDevice,
        platform: "android",
        script: { start: "no-such-screen", transitions: [] },
      })
    ).toThrow(/no-such-screen/u);
  });

  it.effect(
    "maps Android corpus nodes, mints generation targets, synthesizes viewport PNGs, and transitions screens",
    () =>
      Effect.gen(function* verifyAndroidCorpusBackend() {
        const fake = makeCorpusNativeBackend({
          device: androidDevice,
          platform: "android",
          script: ANDROID_WIDGET_SCRIPT,
        });

        const first = yield* fake.backend.capture();
        expect(first.generation).toBe(1);
        expect(first.frame).toEqual({ height: 2424, width: 1080 });
        expect(first.ownership.focusedPackage).toBe(ANDROID_WIDGET_APP);
        const png = Buffer.from(first.screenshot.image, "base64");
        expect(png.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        );
        expect(png.readUInt32BE(16)).toBe(1080);
        expect(png.readUInt32BE(20)).toBe(2424);

        const showBottomSheet = first.nodes.find(
          (node) => node.role === "button" && node.name === "SHOW BOTTOM SHEET"
        );
        expect(showBottomSheet?.target).toMatch(/^@e\d+~s1$/u);
        expect(showBottomSheet?.hittable).toBe(true);

        const oldEmail = first.nodes.find(
          (node) => node.role === "text-field" && node.name === "Email"
        );
        // Effects constructed before a newer capture still check generation at run time.
        const deferredActivate = fake.backend.activate(
          showBottomSheet?.target ?? ""
        );
        const deferredFill = fake.backend.fill(
          oldEmail?.target ?? "",
          "ada@example.com"
        );

        const withoutImage = yield* fake.backend.capture({ image: false });
        expect(withoutImage.generation).toBe(2);
        expect(withoutImage.screenshot.image).toBe("");
        expect(withoutImage.frame).toEqual({ height: 2424, width: 1080 });

        // Running an effect constructed from an older generation fails with ref_generation_mismatch.
        const staleActivate = yield* Effect.flip(deferredActivate);
        expect(staleActivate).toMatchObject({
          backendReason: "ref_generation_mismatch",
          code: "runtime_failed",
          operation: "activate",
        });

        const staleFill = yield* Effect.flip(deferredFill);
        expect(staleFill).toMatchObject({
          backendReason: "ref_generation_mismatch",
          code: "runtime_failed",
          operation: "fill",
        });

        // Unknown ref in the current generation fails with stale_ref.
        const missingRef = yield* Effect.flip(
          fake.backend.activate("@e9999~s2")
        );
        expect(missingRef).toMatchObject({
          backendReason: "stale_ref",
          code: "runtime_failed",
          operation: "activate",
        });

        // Current generation target transitions controls -> bottom-sheet -> controls.
        const currentSheetButton = withoutImage.nodes.find(
          (node) => node.role === "button" && node.name === "SHOW BOTTOM SHEET"
        );
        yield* fake.backend.activate(currentSheetButton?.target ?? "");
        expect(fake.currentCapture()).toBe("bottom-sheet");

        const sheet = yield* fake.backend.capture({ image: false });
        const closeSheet = sheet.nodes.find(
          (node) => node.role === "button" && node.name === "CLOSE SHEET"
        );
        expect(closeSheet?.target).toMatch(/^@e\d+~s3$/u);
        yield* fake.backend.activate(closeSheet?.target ?? "");
        expect(fake.currentCapture()).toBe("controls");
      })
  );

  it.effect(
    "names Android nodes with the real androidNodeName, so a row without a label takes its children's text",
    () =>
      Effect.gen(function* verifyAndroidNodeNames() {
        const fake = makeCorpusNativeBackend({
          device: androidDevice,
          platform: "android",
          script: { start: "list", transitions: [] },
        });

        const capture = yield* fake.backend.capture({ image: false });
        const rows = capture.nodes.filter(
          (node) =>
            node.role === "group" && node.hittable && node.name.includes("$")
        );
        expect(rows.map((node) => node.name)).toEqual([
          "Anvil, $7.00",
          "Rocket skates, $14.00",
        ]);
        expect(capture.nodes.find((node) => node.role === "list")?.name).toBe(
          ""
        );
      })
  );

  it.effect(
    "maps iOS corpus captures with the real iOS interaction and naming rules",
    () =>
      Effect.gen(function* verifyIosCorpusBackend() {
        const fake = makeCorpusNativeBackend({
          device: iosDevice,
          platform: "ios",
          script: {
            start: "controls",
            transitions: [
              {
                from: "controls",
                on: { action: "activate", name: "Show alert", role: "button" },
                to: "alert",
              },
            ],
          },
        });
        const first = yield* fake.backend.capture();
        expect(first.platform).toBe("ios");
        expect(first.appId).toBe("dev.contingency.ioswidgets");
        const png = Buffer.from(first.screenshot.image, "base64");
        expect(png.readUInt32BE(16)).toBe(first.frame?.width);
        expect(png.readUInt32BE(20)).toBe(first.frame?.height);
        const showAlert = first.nodes.find(
          (node) => node.role === "button" && node.name === "Show alert"
        );
        expect(showAlert?.target).toMatch(/^@e\d+~s1$/u);
        yield* fake.backend.activate(showAlert?.target ?? "");
        const alert = yield* fake.backend.capture({ image: false });
        expect(
          alert.nodes.some(
            (node) => node.role === "button" && node.name === "Remove"
          )
        ).toBe(true);
      })
  );

  it.effect(
    "preserves the outer iOS window viewport when a system permission alert is presented",
    () =>
      Effect.gen(function* verifyIosSystemAlertViewport() {
        const fake = makeCorpusNativeBackend({
          device: iosDevice,
          platform: "ios",
          script: IOS_WIDGET_SCRIPT,
        });
        const controls = yield* fake.backend.capture({ image: false });
        expect(controls.frame).toEqual({ height: 874, width: 402 });

        const continueButton = controls.nodes.find(
          (node) => node.role === "button" && node.name === "Continue"
        );
        yield* fake.backend.activate(continueButton?.target ?? "");

        const permissionAlert = yield* fake.backend.capture();
        // system-permission-alert.json has a 320x326 alert frame inside the
        // 402x874 window; iosWindowViewport keeps the outer window geometry.
        expect(permissionAlert.frame).toEqual({ height: 874, width: 402 });
        const png = Buffer.from(permissionAlert.screenshot.image, "base64");
        expect(png.readUInt32BE(16)).toBe(402);
        expect(png.readUInt32BE(20)).toBe(874);
        expect(
          permissionAlert.nodes.some(
            (node) => node.role === "button" && node.name === "Allow Once"
          )
        ).toBe(true);
      })
  );

  it.effect(
    "injects capture_incomplete for a fixed count or until recover",
    () =>
      Effect.gen(function* verifyCaptureInjection() {
        const fake = makeCorpusNativeBackend({
          device: androidDevice,
          platform: "android",
          script: ANDROID_WIDGET_SCRIPT,
        });
        fake.failNextCaptures(2);
        expect((yield* Effect.flip(fake.backend.capture())).code).toBe(
          "capture_incomplete"
        );
        expect((yield* Effect.flip(fake.backend.capture())).code).toBe(
          "capture_incomplete"
        );
        expect((yield* fake.backend.capture({ image: false })).generation).toBe(
          1
        );

        fake.failCapturesUntilRecover();
        expect((yield* Effect.flip(fake.backend.capture())).code).toBe(
          "capture_incomplete"
        );
        expect((yield* Effect.flip(fake.backend.capture())).code).toBe(
          "capture_incomplete"
        );
        yield* fake.backend.recover();
        expect(fake.recoveries()).toBe(1);
        expect((yield* fake.backend.capture({ image: false })).generation).toBe(
          2
        );
      })
  );
});
