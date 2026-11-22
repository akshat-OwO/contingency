import type {
  AndroidDiscoveredApp,
  AndroidDiscoveredAppsEvent,
  AndroidWorkspaceSelection,
} from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect, Stream } from "effect";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidStartCard } from "@/components/agent/android-start-card";
import type { AndroidSetupDiscovery } from "@/components/agent/android-start-card";

const shopApp: AndroidDiscoveredApp = {
  label: "Shop",
  launchActivity: "dev.shop/.Main",
  package: "dev.shop",
  versionCode: "1",
  versionName: "1",
};

const discovery: AndroidSetupDiscovery = {
  apps: () => Stream.make({ _tag: "snapshot", apps: [shopApp] }),
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

/** The installed-app picker, a combobox as on the #744 card. */
const targetApp = () => screen.getByRole("combobox", { name: "Target App" });

/** Picks the installed Shop once the device's apps are listed. */
const chooseShop = async (user: ReturnType<typeof userEvent.setup>) => {
  const picker = targetApp();
  // The picker waits, disabled, until the apps are read.
  await vi.waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  await user.click(
    await screen.findByRole("option", { name: "Shop dev.shop · build 1" })
  );
  return picker;
};

/** Opens the collapsed Setup section of the card. */
const openSetup = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Setup/u }));

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
  expect(targetApp()).toBeDisabled();
  await user.click(field);
  await user.click(
    await screen.findByRole("option", {
      name: "Pixel_8 · Android 16 emulator-5556",
    })
  );
  expect(field).toHaveTextContent("Pixel_8");
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
});

test("unlocks setup sequentially and submits selectable permission decisions with automatic helper setup", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<Card onStart={onOpen} />);
  await openSetup(user);
  // Setup waits for the Target App and says so; its controls stay disabled.
  expect(screen.getByText("Choose the Target App first.")).toBeVisible();
  const startElement = screen.getByRole("textbox", {
    name: "Starting screen element",
  });
  expect(startElement).toBeDisabled();
  // The one ready device is the device: Target App opens without a click.
  expect(
    await screen.findByRole("group", { name: "Pixel_9" })
  ).toHaveTextContent("Running · emulator-5554");
  // The field reads as the prototype: the device, then its Android version.
  expect(screen.getByRole("combobox", { name: "Device" })).toHaveTextContent(
    /^Pixel_9 · Android 16$/u
  );
  const picker = await chooseShop(user);
  expect(picker).toHaveValue("Shop");
  expect(startElement).toBeEnabled();
  const cameraPermission = screen.getByRole("radiogroup", {
    name: "Camera permission",
  });
  expect(
    within(cameraPermission).getByRole("radio", { name: "Camera: Ask in app" })
  ).toBeChecked();
  await user.click(startElement);
  await user.paste("Sign in");
  const doneElement = screen.getByRole("textbox", {
    name: "Done when element",
  });
  await user.click(doneElement);
  await user.paste("Done");
  await user.click(
    within(cameraPermission).getByRole("radio", {
      name: "Camera: Deny before start",
    })
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
  expect(targetApp()).toBeDisabled();
});

test("keeps a picked emulator chosen when it comes back under a new serial", async () => {
  const user = userEvent.setup();
  const [emulator] = await Effect.runPromise(discovery.devices);
  const other = { ...emulator, avd: "Pixel_8", serial: "emulator-5556" };
  let rebooted = false;
  let reused = false;
  const stranger = { ...emulator, avd: "Pixel_7", serial: "emulator-5554" };
  render(
    <Card
      discovery={{
        ...discovery,
        devices: Effect.sync(() => {
          if (!rebooted) {
            return [emulator, other];
          }
          const moved = { ...emulator, serial: "emulator-5558" };
          return reused ? [stranger, moved, other] : [moved, other];
        }),
      }}
    />
  );
  const field = await screen.findByRole("combobox", { name: "Device" });
  await user.click(field);
  await user.click(await screen.findByRole("option", { name: /Pixel_9/u }));
  rebooted = true;
  await user.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(await screen.findByText("Running · emulator-5558")).toBeVisible();
  expect(field).toHaveTextContent("Pixel_9");
  // Another AVD takes the old serial: the pick stays with its AVD.
  reused = true;
  await user.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(await screen.findByText("Running · emulator-5558")).toBeVisible();
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

test("keeps the Target App field in place while the apps load", async () => {
  const user = userEvent.setup();
  const listed = Effect.runSync(
    Deferred.make<readonly AndroidDiscoveredApp[]>()
  );
  render(
    <Card
      discovery={{
        ...discovery,
        apps: () =>
          Stream.fromEffect(
            Deferred.await(listed).pipe(
              Effect.map((apps) => ({ _tag: "snapshot" as const, apps }))
            )
          ),
      }}
    />
  );
  // The one field says it is reading, so nothing below it moves.
  expect(
    await screen.findByText("Reading installed apps…")
  ).toBeInTheDocument();
  expect(targetApp()).toBeDisabled();
  expect(targetApp()).toHaveAttribute("placeholder", "Reading installed apps…");
  expect(targetApp()).toHaveAccessibleDescription("Reading installed apps…");
  Effect.runSync(Deferred.succeed(listed, [shopApp]));
  await chooseShop(user);
  expect(targetApp()).toHaveValue("Shop");
});

test("enriches labels progressively without reordering rows or resetting selection", async () => {
  const user = userEvent.setup();
  const zetaResolved = Effect.runSync(
    Deferred.make<AndroidDiscoveredAppsEvent>()
  );
  const alphaResolved = Effect.runSync(
    Deferred.make<AndroidDiscoveredAppsEvent>()
  );
  render(
    <Card
      discovery={{
        ...discovery,
        apps: () =>
          Stream.make<AndroidDiscoveredAppsEvent>({
            _tag: "snapshot",
            apps: [
              {
                label: "dev.zeta",
                launchActivity: "dev.zeta/.Main",
                package: "dev.zeta",
                versionCode: "10",
                versionName: "",
              },
              {
                label: "dev.alpha",
                launchActivity: "dev.alpha/.Main",
                package: "dev.alpha",
                versionCode: "2",
                versionName: "",
              },
            ],
          }).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(zetaResolved))),
            Stream.concat(Stream.fromEffect(Deferred.await(alphaResolved)))
          ),
      }}
    />
  );

  // Picker is enabled immediately with fallback package labels.
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
  await user.click(targetApp());
  await user.click(
    await screen.findByRole("option", { name: "dev.zeta dev.zeta · build 10" })
  );
  expect(targetApp()).toHaveValue("dev.zeta");

  // Fill a setup field before labels arrive to prove enrichment preserves form state.
  await openSetup(user);
  const startField = screen.getByRole("textbox", {
    name: "Starting screen element",
  });
  await user.type(startField, "Welcome");
  expect(startField).toHaveValue("Welcome");

  // Resolve labels out of alphabetical order; row order and form state stay intact.
  Effect.runSync(
    Deferred.succeed(zetaResolved, {
      _tag: "metadata",
      label: "Zeta App",
      package: "dev.zeta",
      versionCode: "10",
      versionName: "1.0",
    })
  );
  Effect.runSync(
    Deferred.succeed(alphaResolved, {
      _tag: "metadata",
      label: "Alpha App",
      package: "dev.alpha",
      versionCode: "2",
      versionName: "0.2",
    })
  );

  await vi.waitFor(() => expect(targetApp()).toHaveValue("Zeta App"));
  expect(startField).toHaveValue("Welcome");

  // Reopen the list and verify stable order (Zeta App remains before Alpha App).
  await user.clear(targetApp());
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Zeta App dev.zeta · build 10",
    "Alpha App dev.alpha · build 2",
  ]);
});

test("searches installed apps by name or package and says when none match", async () => {
  const user = userEvent.setup();
  render(
    <Card
      discovery={{
        ...discovery,
        apps: () =>
          Stream.make({
            _tag: "snapshot" as const,
            apps: [
              {
                label: "Shop",
                launchActivity: "dev.shop/.Main",
                package: "dev.shop",
                versionCode: "1",
                versionName: "1",
              },
              {
                label: "Fixture Shop",
                launchActivity: "dev.contingency.checkout/.Main",
                package: "dev.contingency.checkout",
                versionCode: "1",
                versionName: "1",
              },
            ],
          }),
      }}
    />
  );
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
  await user.type(targetApp(), "contingency.check");
  expect(
    await screen.findByRole("option", {
      name: "Fixture Shop dev.contingency.checkout · build 1",
    })
  ).toBeVisible();
  expect(screen.queryByRole("option", { name: /^Shop /u })).toBeNull();
  await user.clear(targetApp());
  await user.type(targetApp(), "nothing-here");
  expect(await screen.findByText("No launchable app matches.")).toBeVisible();
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
  expect(targetApp()).toBeDisabled();
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
  expect(await screen.findByText("Running · emulator-5554")).toBeVisible();
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
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
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
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
  await chooseShop(user);
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
  await chooseShop(user);
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
  await chooseShop(user);
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
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
  expect(start).toHaveAccessibleDescription(
    "Choose the Target App to continue."
  );
  await chooseShop(user);
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
  await chooseShop(user);
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

test("Escape closes an open Device select or Target App combobox before folding the card", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Card onClose={onClose} />);
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());

  await user.click(screen.getByRole("combobox", { name: "Device" }));
  expect(await screen.findByRole("option", { name: /Pixel_9/u })).toBeVisible();
  await user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("option", { name: /Pixel_9/u })).toBeNull()
  );
  expect(onClose).not.toHaveBeenCalled();

  await user.click(targetApp());
  expect(
    await screen.findByRole("option", { name: "Shop dev.shop · build 1" })
  ).toBeVisible();
  expect(targetApp()).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("option", { name: "Shop dev.shop · build 1" })
    ).toBeNull()
  );
  expect(targetApp()).toHaveAttribute("aria-expanded", "false");
  expect(onClose).not.toHaveBeenCalled();

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
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
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

test("Escape with focus outside the start form leaves the card and its unclaimed upload open", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const onClose = vi.fn();
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
      id: "44444444-4444-4444-4444-444444444444",
      name: file.name,
    })
  );
  render(
    <div>
      <button type="button">Outside action</button>
      <Card discovery={{ ...discovery, discard, upload }} onClose={onClose} />
    </div>
  );
  await vi.waitFor(() => expect(targetApp()).toBeEnabled());
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(
    picker ?? document.createElement("input"),
    new File(["PK"], "shop.apk", {
      type: "application/vnd.android.package-archive",
    })
  );
  await screen.findByRole("button", { name: "Remove shop.apk" });

  // Escape from an unrelated control outside the form leaves the card open.
  await user.click(screen.getByRole("button", { name: "Outside action" }));
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
  expect(screen.getByRole("form", { name: "Teach on Android" })).toBeVisible();

  // Escape from the sibling "Other platforms" pill also leaves the card open.
  await user.click(screen.getByRole("button", { name: "Web" }));
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();

  // Focusing back inside the form restores nested-popup-first Escape folding.
  await user.click(screen.getByRole("textbox", { name: "Flow name" }));
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});
