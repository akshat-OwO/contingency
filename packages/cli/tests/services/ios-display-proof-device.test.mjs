import { expect, it } from "vitest";

import { foldWithPanelReadback } from "../../../../.cursor/skills/verify-contingency/bin/ios-display-proof-device.mjs";

const unsupportedHingeReadback = () =>
  Object.assign(
    new Error(
      "CoreDevice reported no hinge angle sample: Unknown option '--device'"
    ),
    {
      code: "COMMAND_FAILED",
      details: {
        args: [
          "devicectl",
          "device",
          "motion",
          "hinge-angle",
          "--device",
          "owned-udid",
        ],
        exitCode: 64,
        processExitError: true,
      },
    }
  );

it("retains a failed SDK hinge confirmation and requires panel evidence", async () => {
  const after = { active: ["LCD-1"] };
  const proof = await foldWithPanelReadback(
    () => Promise.reject(unsupportedHingeReadback()),
    () => Promise.resolve(after)
  );
  expect(proof.after).toBe(after);
  expect(proof.result.sdkError.code).toBe("COMMAND_FAILED");
  expect(proof.result.hingeAngleConfirmed).toBe(false);
});

it("fails when independent panel readback cannot confirm the transition", async () => {
  await expect(
    foldWithPanelReadback(
      () => Promise.reject(unsupportedHingeReadback()),
      () => Promise.reject(new Error("Expected inner panel did not activate"))
    )
  ).rejects.toThrow("Expected inner panel did not activate");
});

it("does not reinterpret other command failures as confirmation failures", async () => {
  const error = unsupportedHingeReadback();
  error.details.args = ["fold-helper", "--pose", "open"];
  await expect(
    foldWithPanelReadback(
      () => Promise.reject(error),
      () => Promise.reject(new Error("Must not read back an unknown failure"))
    )
  ).rejects.toBe(error);
});
