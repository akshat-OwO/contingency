import type { IosWorkspaceSelection } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { IosStartCard } from "@/components/agent/ios-start-card";
import type { AppBundleFile } from "@/lib/rpc";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

const iphone = {
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  kind: "simulator",
  name: "iPhone 17",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  runtimeVersion: "26.5",
  state: "Booted",
  udid: "11111111-2222-3333-4444-555555555555",
} as const;
const { state: _state, ...iphoneSelection } = iphone;

const uploadedApp = {
  appPath: "/tmp/contingency-builds-x/1/Login.app",
  build: "1",
  bundleId: "dev.contingency.ioslogin",
  id: "11111111-1111-1111-1111-111111111111",
  label: "Contingency Public Login",
  name: "Login.app",
};

const devicesAtom = (devices: readonly unknown[]) =>
  Atom.make(() => ({ _tag: "Success", value: devices, waiting: false }));

interface Host {
  readonly devices?: readonly unknown[];
  readonly discard?: (id: string) => Effect.Effect<void>;
  readonly upload?: (
    files: readonly AppBundleFile[]
  ) => Effect.Effect<typeof uploadedApp>;
}

/**
 * The card on its own, as the home renders it with Web offered beside it,
 * over the host reads a test names. The Flow name lives here, as the home
 * holds it above the card.
 */
const Card = ({
  onStart,
}: {
  readonly onStart: (
    flowName: string,
    selection: IosWorkspaceSelection
  ) => boolean;
}) => {
  const [flowName, setFlowName] = useState("new-flow");
  return (
    <IosStartCard
      error={undefined}
      flowName={flowName}
      onClose={vi.fn()}
      onFlowNameChange={setFlowName}
      onOtherPlatform={vi.fn()}
      onStart={(name, selection) => onStart(name, selection)}
      pending={false}
      platforms={["web"]}
    />
  );
};

const renderCard = (
  onStart: (flowName: string, selection: IosWorkspaceSelection) => boolean,
  {
    devices = [iphone],
    discard = () => Effect.void,
    upload = () => Effect.die("No upload in this test."),
  }: Host = {}
) => {
  const overrides = {
    discardTargetAppBuild: discard,
    iosDevicesAtom: devicesAtom(devices),
    listIosApps: () =>
      Effect.succeed([{ build: "3", bundleId: "dev.shop", label: "Shop" }]),
    uploadIosApp: upload,
  };
  return render(
    <RpcDependenciesProvider overrides={overrides}>
      <RegistryProvider>
        <Card onStart={onStart} />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );
};

/** A file inside a chosen folder, as the folder picker reports it. */
const folderFile = (path: string) => {
  const file = new File(["x"], path.split("/").at(-1) ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

test("uploads a simulator .app folder and starts with its temporary copy", async () => {
  // The native picker is hidden from pointers; the trigger is what people use.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const onStart = vi.fn(() => true);
  const discard = vi.fn(() => Effect.void);
  const upload = vi.fn((_files: readonly AppBundleFile[]) =>
    Effect.succeed(uploadedApp)
  );
  renderCard(onStart, { discard, upload });
  const card = screen.getByRole("form", { name: "Teach on iOS" });
  // The one booted simulator is chosen, as there is nothing to pick between.
  expect(
    await within(card).findByRole("button", {
      name: /iPhone 17/u,
      pressed: true,
    })
  ).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Upload a simulator .app" })
  ).toBeVisible();
  const picker = card.querySelector<HTMLInputElement>('input[type="file"]');
  expect(picker).toHaveAttribute("webkitdirectory");
  await user.upload(picker ?? document.createElement("input"), [
    folderFile("Login.app/Info.plist"),
    folderFile("Login.app/Login"),
  ]);
  expect(
    await within(card).findByText(
      "dev.contingency.ioslogin · build 1 · installs with your consent"
    )
  ).toBeVisible();
  expect(upload.mock.calls[0]?.[0].map((entry) => entry.path)).toEqual([
    "Login.app/Info.plist",
    "Login.app/Login",
  ]);

  await user.click(
    within(card).getByRole("button", { name: "Start teaching" })
  );
  expect(onStart).toHaveBeenCalledTimes(1);
  // The selection the setup Sheet sent before the card replaced it.
  expect(onStart).toHaveBeenCalledWith("new-flow", {
    appPath: uploadedApp.appPath,
    device: iphoneSelection,
    environment: {
      build: "1",
      bundleId: "dev.contingency.ioslogin",
      deviceType: iphone.deviceType,
      runtimeVersion: "26.5",
    },
    outcomes: [],
    setup: { conditions: [], kind: "restart-app", startingData: "keep" },
  });
  // The session owns the upload now; it is not discarded here.
  expect(discard).not.toHaveBeenCalled();
});

test("starts an installed app with the declared Setup", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn(() => true);
  renderCard(onStart);
  const card = screen.getByRole("form", { name: "Teach on iOS" });
  await user.click(await within(card).findByRole("button", { name: /Shop/u }));
  const setup = within(card).getByRole("button", { name: /^Setup/u });
  expect(setup).toHaveAttribute("aria-expanded", "false");
  await user.click(setup);
  await user.click(within(card).getByRole("radio", { name: /^Clear app data/u }));
  const starting = within(card).getByRole("textbox", {
    name: "Starting screen element",
  });
  expect(starting).not.toBeRequired();
  await user.type(starting, " Welcome ");
  await user.click(
    within(card).getByRole("combobox", { name: "Starting screen role" })
  );
  await user.click(await screen.findByRole("option", { name: "button" }));
  await user.type(
    within(card).getByRole("textbox", { name: "Done when element" }),
    "Finished"
  );
  await user.click(
    within(card).getByRole("button", { name: "Start teaching" })
  );
  expect(onStart).toHaveBeenCalledWith("new-flow", {
    device: iphoneSelection,
    environment: {
      build: "3",
      bundleId: "dev.shop",
      deviceType: iphone.deviceType,
      runtimeVersion: "26.5",
    },
    outcomes: [{ name: "Finished", role: "text" }],
    setup: {
      conditions: [{ name: "Welcome", role: "button" }],
      kind: "restart-app",
      startingData: "clear",
    },
  });
});

test("Start teaching waits for a valid Flow name, a running simulator and a Target App", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn(() => true);
  renderCard(onStart, {
    devices: [
      iphone,
      {
        ...iphone,
        name: "iPhone 16e",
        udid: "66666666-2222-3333-4444-555555555555",
      },
    ],
  });
  const card = screen.getByRole("form", { name: "Teach on iOS" });
  const start = within(card).getByRole("button", { name: "Start teaching" });
  const name = within(card).getByRole("textbox", { name: "Flow name" });
  // A name that cannot be a Flow name never reaches the start (the Sheet
  // threw on it).
  await user.clear(name);
  await user.type(name, "check/out");
  expect(start).toBeDisabled();
  expect(start).toHaveAccessibleDescription("Name the Flow to continue.");
  await user.clear(name);
  await user.type(name, "checkout");
  // Two simulators are running, so one must be picked.
  expect(start).toHaveAccessibleDescription(
    "Choose a running simulator to continue."
  );
  await user.click(
    within(card).getByRole("button", { name: /iPhone 16e/u })
  );
  expect(start).toHaveAccessibleDescription(
    "Choose the Target App to continue."
  );
  await user.click(await within(card).findByRole("button", { name: /Shop/u }));
  expect(start).toBeEnabled();
  await user.click(start);
  expect(onStart).toHaveBeenCalledWith(
    "checkout",
    expect.objectContaining({
      device: expect.objectContaining({ name: "iPhone 16e" }),
    })
  );
});

test("asks for a simulator to be started when none is running", () => {
  renderCard(vi.fn(), { devices: [{ ...iphone, state: "Shutdown" }] });
  expect(
    screen.getByRole("button", { name: "Start teaching" })
  ).toHaveAccessibleDescription("Start a simulator to continue.");
});

test("closing the card discards an upload no session claimed", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const discard = vi.fn((_id: string) => Effect.void);
  const view = renderCard(vi.fn(), {
    discard,
    upload: () => Effect.succeed(uploadedApp),
  });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(picker ?? document.createElement("input"), [
    folderFile("Login.app/Info.plist"),
  ]);
  await screen.findByRole("button", { name: "Remove Login.app" });
  expect(discard).not.toHaveBeenCalled();
  view.unmount();
  expect(discard).toHaveBeenCalledWith(uploadedApp.id);
});
