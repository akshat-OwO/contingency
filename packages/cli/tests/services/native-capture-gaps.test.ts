import { expect, it } from "@effect/vitest";

import {
  openCaptureGaps,
  repairCaptureGaps,
  repairsCaptureAutomatically,
} from "../../src/services/native-capture-gaps.ts";

const at = "2026-11-15T00:00:00.000Z";

it("a repair covers one occurrence of its gap, in order", () => {
  const summary = {
    captureGaps: ["capture_incomplete", "capture_incomplete"],
    captureRepairs: [
      { at, by: "automatic" as const, code: "capture_incomplete" },
    ],
  };
  expect(openCaptureGaps(summary)).toEqual(["capture_incomplete"]);
  expect(openCaptureGaps({ captureGaps: ["device_disconnected"] })).toEqual([
    "device_disconnected",
  ]);
});

it("Recover repairs every open gap except a secure window or unverified input", () => {
  const repaired = repairCaptureGaps(
    {
      captureGaps: [
        "capture_incomplete",
        "secure_window",
        "forwarded_input_unverified",
        "device_disconnected",
      ],
      captureRepairs: [
        { at, by: "automatic" as const, code: "capture_incomplete" },
      ],
    },
    "user",
    at
  );
  expect(repaired.captureRepairs).toEqual([
    { at, by: "automatic", code: "capture_incomplete" },
    { at, by: "user", code: "device_disconnected" },
  ]);
  expect(openCaptureGaps(repaired)).toEqual([
    "secure_window",
    "forwarded_input_unverified",
  ]);
  // Nothing open to repair leaves the summary as it was.
  const clean = { captureGaps: [] };
  expect(repairCaptureGaps(clean, "user", at)).toBe(clean);
});

it("only an agent-controlled, running Run or Dry Run repairs itself", () => {
  expect(
    repairsCaptureAutomatically({
      controller: "agent",
      kind: "dry-run",
      phase: "running",
    })
  ).toBe(true);
  expect(
    repairsCaptureAutomatically({
      controller: "agent",
      kind: "teaching",
      phase: "running",
    })
  ).toBe(false);
  expect(
    repairsCaptureAutomatically({
      controller: "user",
      kind: "run",
      phase: "running",
    })
  ).toBe(false);
  expect(
    repairsCaptureAutomatically({
      controller: "agent",
      kind: "run",
      phase: "paused",
    })
  ).toBe(false);
});
