import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidSetupSheet } from "@/components/agent/android-setup-sheet";

const discovery = {
  apps: () =>
    Effect.succeed([
      {
        label: "Shop",
        launchActivity: "dev.shop/.Main",
        package: "dev.shop",
        versionCode: "1",
        versionName: "1",
      },
    ]),
  devices: Effect.succeed([
    {
      api: 36,
      avd: "Pixel_9",
      fingerprint: "build",
      kind: "emulator",
      model: "Pixel",
      release: "16",
      serial: "emulator-5554",
      state: "device",
    } as const,
  ]),
};
afterEach(cleanup);

test("unlocks setup sequentially and submits selectable permission decisions with automatic helper setup", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(
    <AndroidSetupSheet
      discovery={discovery}
      open
      onOpen={onOpen}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  expect(screen.getByRole("group", { name: "Target App" })).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Starting screen element" })
  ).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: /Pixel_9/u }));
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  expect(
    screen.getByRole("textbox", { name: "Starting screen element" })
  ).toBeEnabled();
  expect(
    screen.getByRole("combobox", { name: "Camera permission" })
  ).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Starting screen element" }),
    "Sign in"
  );
  await user.type(
    screen.getByRole("textbox", { name: "Done when element" }),
    "Done"
  );
  await user.click(screen.getByRole("combobox", { name: "Camera permission" }));
  await user.click(
    await screen.findByRole("option", { name: "Deny before start" })
  );
  expect(
    screen.queryByRole("textbox", { name: "Additional permission decisions" })
  ).not.toBeInTheDocument();
  expect(document.querySelector("select")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open session" }));
  expect(onOpen).toHaveBeenCalledWith(
    "new-flow",
    expect.objectContaining({
      environment: expect.objectContaining({
        permissions: [
          { decision: "revoke", permission: "android.permission.CAMERA" },
        ],
      }),
      helperConsent: "auto",
    })
  );
});

test("disables physical devices with their refusal reason before app discovery", async () => {
  const apps = vi.fn(discovery.apps);
  render(
    <AndroidSetupSheet
      discovery={{
        apps,
        devices: Effect.succeed([
          {
            api: 36,
            avd: null,
            fingerprint: "phone-build",
            kind: "physical",
            model: "Phone",
            release: "16",
            serial: "phone",
            state: "device",
          },
        ]),
      }}
      open
      onOpen={vi.fn()}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  const phone = await screen.findByRole("button", {
    name: /physical_device_unsupported/u,
  });
  expect(phone).toBeDisabled();
  expect(screen.getByRole("group", { name: "Target App" })).toBeDisabled();
  expect(apps).not.toHaveBeenCalled();
});
