import type { DeviceEraseState } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { useDeviceErase } from "@/components/agent/device-erase";
import { simulatorInventoryKey } from "@/components/agent/ios-setup-state";
import type { IosListedDevice } from "@/components/agent/ios-setup-state";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

/** The host's erase state: which simulators this process owns. */
interface Host {
  owned: readonly string[];
  reads: number;
}
const host: Host = { owned: [], reads: 0 };
const readDeviceEraseState = Effect.sync((): DeviceEraseState => {
  host.reads += 1;
  return { owned: { android: [], ios: [...host.owned] }, requests: [] };
});

const OwnedList = ({ devices }: { readonly devices: IosListedDevice[] }) => {
  const { controls } = useDeviceErase(
    "ios",
    true,
    simulatorInventoryKey(devices),
    () => {
      // Erasing is not part of this test.
    }
  );
  return <output aria-label="Owned">{controls.owned.join(",")}</output>;
};

const Owned = ({ devices }: { readonly devices: IosListedDevice[] }) => (
  <RpcDependenciesProvider overrides={{ readDeviceEraseState }}>
    <OwnedList devices={devices} />
  </RpcDependenciesProvider>
);

const simulator = (state: string): IosListedDevice => ({
  name: "iPhone 17",
  runtimeVersion: "26.5",
  state,
  udid: "SIM-1",
});

test("reads ownership again once a simulator it started is running", async () => {
  const view = render(<Owned devices={[simulator("Shutdown")]} />);
  await vi.waitFor(() => expect(host.reads).toBe(1));
  expect(screen.getByRole("status", { name: "Owned" }).textContent).toBe("");
  // Start finished: the host now owns it, and the inventory reports it booted.
  host.owned = ["SIM-1"];
  view.rerender(<Owned devices={[simulator("Booted")]} />);
  await vi.waitFor(() =>
    expect(screen.getByRole("status", { name: "Owned" }).textContent).toBe(
      "SIM-1"
    )
  );
});
