import type { AndroidWorkspaceSelection } from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidStartCard } from "@/components/agent/android-start-card";
import type { AndroidSetupDiscovery } from "@/components/agent/android-start-card";

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

/**
 * The card on its own, as the home renders it with Web offered beside it.
 * The Flow name lives here, as the home holds it above the card.
 */
const Card = ({
  discovery: given = discovery,
  onClose = vi.fn(),
  onStart = vi.fn(),
  pending = false,
}: {
  readonly discovery?: AndroidSetupDiscovery;
  readonly onClose?: () => void;
  readonly onStart?: (
    flowName: string,
    selection: AndroidWorkspaceSelection
  ) => boolean | undefined;
  readonly pending?: boolean;
}) => {
  const [flowName, setFlowName] = useState("new-flow");
  return (
    <AndroidStartCard
      discovery={given}
      error={undefined}
      flowName={flowName}
      onClose={onClose}
      onFlowNameChange={setFlowName}
      onOtherPlatform={vi.fn()}
      onStart={(name, selection) => onStart(name, selection) ?? false}
      pending={pending}
      platforms={["web"]}
    />
  );
};

/** Opens the collapsed Setup section of the card. */
const openSetup = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Setup/u }));

test("unlocks setup sequentially and submits selectable permission decisions with automatic helper setup", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Card onStart={onOpen} />);
  await openSetup(user);
  // Setup waits for the Target App and says so; its controls stay disabled.
  expect(screen.getByText("Choose the Target App first.")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Starting screen element" })
  ).toBeDisabled();
  // The one ready device is the device: Target App opens without a click.
  expect(
    await screen.findByRole("group", { name: "Pixel_9" })
  ).toHaveTextContent("Running · emulator-5554 · API 36");
  expect(screen.getByRole("combobox", { name: "Device" })).toHaveTextContent(
    "Pixel_9"
  );
  expect(
    screen.getByRole("textbox", { name: "Search installed apps" })
  ).toBeEnabled();
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  expect(
    screen.getByRole("textbox", { name: "Starting screen element" })
  ).toBeEnabled();
  expect(
    screen.getByRole("radio", { name: "Camera: Ask in app" })
  ).toBeChecked();
  await user.type(
    screen.getByRole("textbox", { name: "Starting screen element" }),
    "Sign in"
  );
  await user.type(
    screen.getByRole("textbox", { name: "Done when element" }),
    "Done"
  );
  await user.click(
    within(
      screen.getByRole("radiogroup", { name: "Camera permission" })
    ).getByRole("radio", { name: "Camera: Deny before start" })
  );
  expect(
    screen.queryByRole("textbox", { name: "Additional permission decisions" })
  ).not.toBeInTheDocument();
  expect(document.querySelector("select")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Start teaching" }));
  expect(onOpen).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", {
    name: "Prepare and open app?",
  });
  expect(confirmation).toHaveTextContent("Shop on Pixel_9");
  await user.click(
    within(confirmation).getByRole("button", { name: "Confirm preparation" })
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
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
        startingData: "keep",
      },
    })
  );
});

test("waits for a choice when more than one device is ready", async () => {
  const user = userEvent.setup();
  const [emulator] = await Effect.runPromise(discovery.devices);
  render(
    <Card
      discovery={{
        ...discovery,
        devices: Effect.succeed([
          emulator,
          { ...emulator, avd: "Pixel_8", serial: "emulator-5556" },
        ]),
      }}
    />
  );
  const field = await screen.findByRole("combobox", { name: "Device" });
  expect(field).toHaveTextContent("Choose a device");
  expect(
    screen.getByRole("textbox", { name: "Search installed apps" })
  ).toBeDisabled();
  await user.click(field);
  await user.click(await screen.findByRole("option", { name: /Pixel_8/u }));
  expect(field).toHaveTextContent("Pixel_8");
  expect(
    await screen.findByRole("textbox", { name: "Search installed apps" })
  ).toBeEnabled();
});

test("asks for a new choice when the picked device leaves, rather than taking another", async () => {
  const user = userEvent.setup();
  const [emulator] = await Effect.runPromise(discovery.devices);
  const other = { ...emulator, avd: "Pixel_8", serial: "emulator-5556" };
  let pickedGone = false;
  render(
    <Card
      discovery={{
        ...discovery,
        devices: Effect.sync(() => (pickedGone ? [other] : [emulator, other])),
      }}
    />
  );
  const field = await screen.findByRole("combobox", { name: "Device" });
  await user.click(field);
  await user.click(await screen.findByRole("option", { name: /Pixel_9/u }));
  expect(field).toHaveTextContent("Pixel_9");
  pickedGone = true;
  await user.click(screen.getByRole("button", { name: "Refresh devices" }));
  // The only device left is not the one the user picked.
  expect(await screen.findByText("Choose a device")).toBeVisible();
  expect(field).not.toHaveTextContent("Pixel_8");
  expect(
    screen.getByRole("textbox", { name: "Search installed apps" })
  ).toBeDisabled();
});

test("keeps a picked emulator chosen when it comes back under a new serial", async () => {
  const user = userEvent.setup();
  const [emulator] = await Effect.runPromise(discovery.devices);
  const other = { ...emulator, avd: "Pixel_8", serial: "emulator-5556" };
  let rebooted = false;
  render(
    <Card
      discovery={{
        ...discovery,
        devices: Effect.sync(() =>
          rebooted
            ? [{ ...emulator, serial: "emulator-5558" }, other]
            : [emulator, other]
        ),
      }}
    />
  );
  const field = await screen.findByRole("combobox", { name: "Device" });
  await user.click(field);
  await user.click(await screen.findByRole("option", { name: /Pixel_9/u }));
  rebooted = true;
  await user.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(
    await screen.findByText("Running · emulator-5558 · API 36")
  ).toBeVisible();
  expect(field).toHaveTextContent("Pixel_9");
});

test("offers the .apk upload before a device is chosen", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const [emulator] = await Effect.runPromise(discovery.devices);
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
      id: "33333333-3333-3333-3333-333333333333",
      name: file.name,
    })
  );
  render(
    <Card
      discovery={{
        ...discovery,
        devices: Effect.succeed([
          emulator,
          { ...emulator, avd: "Pixel_8", serial: "emulator-5556" },
        ]),
        upload,
      }}
    />
  );
  expect(
    await screen.findByText("Choose a device to list its apps.")
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Upload an .apk" })).toBeEnabled();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(
    picker ?? document.createElement("input"),
    new File(["PK"], "shop.apk", {
      type: "application/vnd.android.package-archive",
    })
  );
  expect(
    await screen.findByText("dev.shop · build 2 · installs with your consent")
  ).toBeVisible();
  // The build is the Target App; Start still waits for a device.
  expect(
    screen.getByRole("button", { name: "Start teaching" })
  ).toHaveAccessibleDescription("Choose a running device to continue.");
});

test("keeps the installed-app frame in place while the apps load", async () => {
  const [shop] = await Effect.runPromise(discovery.apps());
  const listed = Effect.runSync(Deferred.make<readonly (typeof shop)[]>());
  render(
    <Card discovery={{ ...discovery, apps: () => Deferred.await(listed) }} />
  );
  const loading = await screen.findByText("Reading installed apps…");
  const frame = loading.parentElement;
  expect(frame).toHaveClass("h-44", "rounded-lg", "border");
  Effect.runSync(Deferred.succeed(listed, [shop]));
  const list = await screen.findByRole("list", { name: "Installed apps" });
  // The same frame holds the list, so the steps below it do not move.
  expect(list.parentElement).toBe(frame);
  expect(frame).toHaveClass("h-44");
});

test("disables physical devices with their refusal reason before app discovery", async () => {
  const user = userEvent.setup();
  const apps = vi.fn(discovery.apps);
  render(
    <Card
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
    />
  );
  await user.click(await screen.findByRole("combobox", { name: "Device" }));
  const phone = await screen.findByRole("option", {
    name: /physical_device_unsupported/u,
  });
  expect(phone).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("textbox", { name: "Search installed apps" })
  ).toBeDisabled();
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
    <Card
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
    />
  );
  expect(screen.queryByText(/Android Studio, then refresh/u)).toBeNull();
  await user.click(
    await screen.findByRole("button", { name: "Start Pixel_9" })
  );
  expect(boot).toHaveBeenCalledWith("Pixel_9");
  // Discovery refreshes by itself; the one ready device is chosen.
  expect(
    await screen.findByText("Running · emulator-5554 · API 36")
  ).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Search installed apps" })
  ).toBeEnabled();
});

test("keeps the card usable and shows why a start failed", async () => {
  const user = userEvent.setup();
  render(
    <Card
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
  // The native picker is hidden from pointers; the trigger is what people use.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
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
    <Card discovery={{ ...discovery, discard, upload }} onStart={onOpen} />
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
  await user.click(screen.getByRole("button", { name: "Start teaching" }));
  expect(onOpen).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", {
    name: "Prepare and open app?",
  });
  expect(confirmation).toHaveTextContent("Shop on Pixel_9");
  await user.click(
    within(confirmation).getByRole("button", { name: "Confirm preparation" })
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
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

test("opens Teaching with Setup collapsed and empty optional conditions", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Card onStart={onOpen} />);
  expect(screen.getByRole("button", { name: /^Setup/u })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  await user.click(screen.getByRole("button", { name: "Start teaching" }));
  expect(onOpen).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", {
    name: "Prepare and open app?",
  });
  expect(confirmation).toHaveTextContent("Shop on Pixel_9");
  await user.click(
    within(confirmation).getByRole("button", { name: "Confirm preparation" })
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(
    "new-flow",
    expect.objectContaining({
      outcomes: [],
      setup: {
        activity: "dev.shop/.Main",
        conditions: [],
        kind: "restart-activity",
        startingData: "keep",
      },
    })
  );
});

test("cancel and Escape leave setup unsubmitted, then confirmation submits only once", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn(() => true);
  render(<Card onStart={onOpen} />);
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  const prepare = screen.getByRole("button", { name: "Start teaching" });
  await user.click(prepare);
  const dialog = screen.getByRole("dialog", { name: "Prepare and open app?" });
  expect(dialog).toHaveTextContent("without reinstalling it");
  expect(dialog).not.toHaveTextContent("Reinstall the selected APK");
  expect(dialog).toHaveTextContent("including replacing a newer helper");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(onOpen).not.toHaveBeenCalled();
  await user.click(prepare);
  await user.keyboard("{Escape}");
  expect(onOpen).not.toHaveBeenCalled();
  await user.click(prepare);
  fireEvent.change(screen.getByDisplayValue("new-flow"), {
    target: { value: "changed-flow" },
  });
  expect(
    screen.getByRole("button", { name: "Confirm preparation" })
  ).toBeDisabled();
  expect(onOpen).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(prepare);
  await user.dblClick(
    screen.getByRole("button", { name: "Confirm preparation" })
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("saves Clear Starting Data and names the data loss before preparing", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Card onStart={onOpen} />);
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  await openSetup(user);
  const startingData = screen.getByRole("radiogroup", {
    name: "Starting data",
  });
  expect(
    within(startingData).getByRole("radio", { name: /Keep current data/u })
  ).toBeChecked();
  await user.click(
    within(startingData).getByRole("radio", { name: /Clear app data/u })
  );
  await user.click(screen.getByRole("button", { name: "Start teaching" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Prepare and open app?",
  });
  expect(confirmation).toHaveTextContent(
    "removes Shop's sign-in and local data"
  );
  expect(confirmation).not.toHaveTextContent("preserving existing app data");
  await user.click(
    within(confirmation).getByRole("button", { name: "Confirm preparation" })
  );
  expect(onOpen).toHaveBeenCalledWith(
    "new-flow",
    expect.objectContaining({
      setup: expect.objectContaining({ startingData: "clear" }),
    })
  );
});

test("Start teaching waits for a device, a Target App and a valid Flow name", async () => {
  const user = userEvent.setup();
  render(<Card />);
  const card = screen.getByRole("form", { name: "Teach on Android" });
  const start = within(card).getByRole("button", { name: "Start teaching" });
  expect(start).toBeDisabled();
  const shop = await screen.findByRole("button", { name: /Shop/u });
  expect(start).toHaveAccessibleDescription(
    "Choose the Target App to continue."
  );
  await user.click(shop);
  expect(start).toBeEnabled();
  const name = within(card).getByRole("textbox", { name: "Flow name" });
  await user.clear(name);
  expect(start).toBeDisabled();
  expect(start).toHaveAccessibleDescription("Name the Flow to continue.");
  await user.type(name, "checkout");
  expect(start).toBeEnabled();
});

test("Escape folds the card away, but only closes the confirmation over it", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onStart = vi.fn();
  render(<Card onClose={onClose} onStart={onStart} />);
  await user.click(await screen.findByRole("button", { name: /Shop/u }));
  await user.click(screen.getByRole("button", { name: "Start teaching" }));
  expect(
    screen.getByRole("dialog", { name: "Prepare and open app?" })
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "Prepare and open app?" })
  ).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(onStart).not.toHaveBeenCalled();
  screen.getByRole("textbox", { name: "Flow name" }).focus();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("closing the card discards an upload no session claimed", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
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
      id: "22222222-2222-2222-2222-222222222222",
      name: file.name,
    })
  );
  const view = render(<Card discovery={{ ...discovery, discard, upload }} />);
  await screen.findByRole("button", { name: /Shop/u });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(
    picker ?? document.createElement("input"),
    new File(["PK"], "shop.apk", {
      type: "application/vnd.android.package-archive",
    })
  );
  await screen.findByRole("button", { name: "Remove shop.apk" });
  expect(discard).not.toHaveBeenCalled();
  view.unmount();
  expect(discard).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222");
});
