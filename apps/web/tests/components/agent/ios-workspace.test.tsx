import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { IosRecovery } from "@/components/agent/ios-workspace";

afterEach(cleanup);

test("offers transport recovery for a structured capture refusal", async () => {
  const onRecover = vi.fn();
  render(
    <IosRecovery
      pending={false}
      refusal={{ code: "capture_incomplete", recovery: "recover" }}
      onRecover={onRecover}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Recover selected simulator" }));
  expect(onRecover).toHaveBeenCalledExactlyOnceWith("recover");
});

test("returns to the Target App only for a foreground refusal", async () => {
  const onRecover = vi.fn();
  render(
    <IosRecovery
      pending={false}
      refusal={{
        code: "foreign_app_foreground",
        recovery: "return-to-target-app",
      }}
      onRecover={onRecover}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Return to Target App" }));
  expect(onRecover).toHaveBeenCalledExactlyOnceWith("return-to-target-app");
});
