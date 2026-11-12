import { cleanup, render, screen, within } from "@testing-library/react";
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
  boot: () => Effect.void,
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
  discard: () => Effect.void,
  upload: () => Effect.die("No upload in this test."),
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
  await user.click(screen.getByText("Optional steps"));
  // A locked step says what unlocks it rather than showing dead inputs.
  expect(
    screen.queryByRole("textbox", { name: "Starting screen element" })
  ).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "Starting screen" })).getByText(
      "Choose the Target App first."
    )
  ).toBeVisible();
  // The one ready device is the device: Target App opens without a click.
  expect(
    await screen.findByRole("button", { name: /Pixel_9/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("group", { name: "Target App" })).toBeEnabled();
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  expect(
    screen.getByRole("textbox", { name: "Starting screen element" })
  ).toBeEnabled();
  expect(
    screen.getByRole("combobox", { name: "Camera permission" })
  ).toBeEnabled();
  await user.type(
    screen.getByRole("textbox", { name: "Starting screen element" }),
    "Sign in"
  );
  await user.type(
    screen.getByRole("textbox", { name: "Done when element" }),
    "Done"
  );
  await user.click(screen.getByRole("button", { name: "Optional steps" }));
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
      outcomes: [{ name: "Done", role: "text" }],
      setup: {
        activity: "dev.shop/.Main",
        conditions: [{ name: "Sign in", role: "text" }],
        kind: "restart-activity",
      },
    })
  );
});

test("waits for a choice when more than one device is ready", async () => {
  const [emulator] = await Effect.runPromise(discovery.devices);
  render(
    <AndroidSetupSheet
      discovery={{
        ...discovery,
        devices: Effect.succeed([
          emulator,
          { ...emulator, avd: "Pixel_8", serial: "emulator-5556" },
        ]),
      }}
      open
      onOpen={vi.fn()}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  expect(
    await screen.findByRole("button", { name: /Pixel_8/u })
  ).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("group", { name: "Target App" })).toBeDisabled();
});

test("disables physical devices with their refusal reason before app discovery", async () => {
  const apps = vi.fn(discovery.apps);
  render(
    <AndroidSetupSheet
      discovery={{
        ...discovery,
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

test("starts a stopped emulator from its card and selects it once it boots", async () => {
  const user = userEvent.setup();
  const [emulator] = await Effect.runPromise(discovery.devices);
  let booted = false;
  const boot = vi.fn(() =>
    Effect.sync(() => {
      booted = true;
    })
  );
  render(
    <AndroidSetupSheet
      discovery={{
        ...discovery,
        boot,
        devices: Effect.sync(() => [
          booted
            ? emulator
            : {
                api: null,
                avd: "Pixel_9",
                fingerprint: null,
                kind: "emulator" as const,
                model: null,
                release: null,
                serial: "avd:Pixel_9",
                state: "stopped" as const,
              },
        ]),
      }}
      open
      onOpen={vi.fn()}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  expect(screen.queryByText(/Android Studio, then refresh/u)).toBeNull();
  await user.click(
    await screen.findByRole("button", { name: "Start Pixel_9" })
  );
  expect(boot).toHaveBeenCalledWith("Pixel_9");
  // Discovery refreshes by itself; the one ready device is chosen.
  expect(
    await screen.findByRole("button", { name: /Pixel_9/u, pressed: true })
  ).toBeEnabled();
  expect(screen.getByRole("group", { name: "Target App" })).toBeEnabled();
});

test("keeps the sheet usable and shows why a start failed", async () => {
  const user = userEvent.setup();
  render(
    <AndroidSetupSheet
      discovery={{
        ...discovery,
        boot: () =>
          Effect.fail({ message: "Missing system image for Pixel_9" }),
        devices: Effect.succeed([
          {
            api: null,
            avd: "Pixel_9",
            fingerprint: null,
            kind: "emulator",
            model: null,
            release: null,
            serial: "avd:Pixel_9",
            state: "stopped",
          },
        ]),
      }}
      open
      onOpen={vi.fn()}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  await user.click(
    await screen.findByRole("button", { name: "Start Pixel_9" })
  );
  expect(
    await screen.findByText("Missing system image for Pixel_9")
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Try starting Pixel_9" })
  ).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Flow name" })).toBeEnabled();
});

test("uploads an .apk as the Target App and opens Teaching with its temporary copy and empty optional conditions", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn(() => true);
  const discard = vi.fn(() => Effect.void);
  const upload = vi.fn((file: File) =>
    Effect.succeed({
      apkPath: "/tmp/contingency-builds-x/1/target.apk",
      app: {
        label: "Shop",
        launchActivity: "dev.shop/.Main",
        package: "dev.shop",
        versionCode: "2",
        versionName: "2",
      },
      id: "11111111-1111-1111-1111-111111111111",
      name: file.name,
    })
  );
  render(
    <AndroidSetupSheet
      discovery={{ ...discovery, discard, upload }}
      open
      onOpen={onOpen}
      onOpenChange={vi.fn()}
      pending={false}
    />
  );
  await screen.findByRole("button", { name: /Shop/u });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(picker).toBeInstanceOf(HTMLInputElement);
  await user.upload(
    picker ?? document.createElement("input"),
    new File(["PK"], "shop.apk", {
      type: "application/vnd.android.package-archive",
    })
  );
  // Build 1 is installed, so installing build 2 replaces it.
  expect(
    await screen.findByText(
      "dev.shop · build 2 · replaces build 1 with your consent"
    )
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Open session" }));
  expect(onOpen).toHaveBeenCalledWith(
    "new-flow",
    expect.objectContaining({
      apkPath: "/tmp/contingency-builds-x/1/target.apk",
      environment: expect.objectContaining({
        appBuild: "2",
        appId: "dev.shop",
      }),
      outcomes: [],
      setup: expect.objectContaining({
        activity: "dev.shop/.Main",
        conditions: [],
      }),
    })
  );
  // The session owns the upload now; it is not discarded here.
  expect(discard).not.toHaveBeenCalled();
});

test("opens Teaching with collapsed empty optional conditions", async () => {
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
  expect(
    screen.getByRole("button", { name: "Optional steps" })
  ).toHaveAttribute("aria-expanded", "false");
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  await user.click(screen.getByRole("button", { name: "Open session" }));
  expect(onOpen).toHaveBeenCalledWith(
    "new-flow",
    expect.objectContaining({
      outcomes: [],
      setup: {
        activity: "dev.shop/.Main",
        conditions: [],
        kind: "restart-activity",
      },
    })
  );
});
