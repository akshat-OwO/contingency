import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { WorkspaceBrowserSetup } from "@/components/agent/workspace-browser-setup";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

/** What the Workspace sent, as the loopback RPC boundary received it. */
interface RecordedCall {
  readonly payload: {
    readonly kind?: string;
    readonly sessionId?: string;
    readonly tabId?: string;
    readonly userAgentProfile?: string;
    readonly viewport?: {
      readonly deviceScaleFactor: number;
      readonly height: number;
      readonly width: number;
    };
  };
}

interface RecordedCalls {
  emulationPatches: RecordedCall[];
  storageReads: RecordedCall[];
}

const rpc = vi.hoisted((): RecordedCalls => ({
  emulationPatches: [],
  storageReads: [],
}));

const sessionId = "agent-one";
const tabId = "tab-1";

const emulationResult = {
  emulation: {
    permissions: [],
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  },
  userAgentProfile: "default",
};

const rpcOverrides = {
  agentBrowserEmulationGetMutation: Atom.fn(() =>
    Effect.succeed(emulationResult)
  ),
  agentBrowserEmulationSetMutation: Atom.fn((payload: RecordedCall) =>
    Effect.sync(() => {
      rpc.emulationPatches.push(payload);
      return emulationResult;
    })
  ),
  agentBrowserNetworkRequestGetMutation: Atom.fn(() => Effect.never),
  agentBrowserNetworkRequestsGetMutation: Atom.fn(() =>
    Effect.succeed({ requests: [] })
  ),
  agentBrowserStorageClearMutation: Atom.fn(() => Effect.never),
  agentBrowserStorageDeleteMutation: Atom.fn(() => Effect.never),
  agentBrowserStorageGetMutation: Atom.fn((payload: RecordedCall) =>
    Effect.sync(() => {
      rpc.storageReads.push(payload);
      return { snapshot: { cookies: [], kind: "cookies" as const, tabId } };
    })
  ),
  agentBrowserStorageSetMutation: Atom.fn(() => Effect.never),
  agentBrowserTabsGetMutation: Atom.fn(() =>
    Effect.succeed({
      tabs: [
        {
          active: true,
          tabId,
          title: "Shop",
          url: "https://shop.example.com/cart",
        },
      ],
    })
  ),
};

const Harness = ({ children }: { readonly children: ReactNode }) => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <RegistryProvider>{children}</RegistryProvider>
  </RpcDependenciesProvider>
);

const renderSetup = (userHoldsBrowser = true) =>
  render(
    <Harness>
      <WorkspaceBrowserSetup
        consoleEntries={[]}
        onClearConsole={() => {}}
        onClose={() => {}}
        sessionId={sessionId}
        teaching={false}
        userHoldsBrowser={userHoldsBrowser}
      />
    </Harness>
  );

afterEach(() => {
  cleanup();
  rpc.emulationPatches = [];
  rpc.storageReads = [];
});

test("reads the Agent Session's Emulation and shows what the browser applies", async () => {
  renderSetup();
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  expect(screen.getByLabelText("Emulation")).toBeEnabled();
});

test("applies a device preset to the browser the Agent Session owns", async () => {
  renderSetup();
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Device"));
  await user.click(await screen.findByRole("option", { name: "iPhone SE" }));
  await waitFor(() => {
    expect(rpc.emulationPatches).toHaveLength(1);
  });
  expect(rpc.emulationPatches.at(0)).toMatchObject({
    payload: {
      sessionId,
      viewport: { deviceScaleFactor: 1, height: 667, width: 375 },
    },
  });
});

test("sends an identity alone so the session applies its own device metrics", async () => {
  renderSetup();
  // The applied Emulation has landed, so nothing below is racing the read.
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("User agent"));
  await user.click(
    await screen.findByRole("option", { name: "Chrome — Android Mobile" })
  );
  await waitFor(() => {
    expect(rpc.emulationPatches).toHaveLength(1);
  });
  const [patch] = rpc.emulationPatches;
  expect(patch?.payload).toEqual({
    sessionId,
    userAgentProfile: "chrome-android-mobile",
  });
  // A viewport here would overwrite the metrics the identity brings with it.
  expect(patch?.payload.viewport).toBeUndefined();
});

test("refuses browser setup while the agent holds the browser", async () => {
  renderSetup(false);
  expect(
    await screen.findByText(
      "The agent holds the browser. Take control to change its Emulation or storage."
    )
  ).toBeVisible();
  expect(screen.getByLabelText("Emulation")).toBeDisabled();
});

test("inspects the storage of the tab the Agent Session is showing", async () => {
  renderSetup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Storage" }));
  await waitFor(() => {
    expect(rpc.storageReads.length).toBeGreaterThan(0);
  });
  expect(rpc.storageReads.at(0)).toMatchObject({
    payload: { kind: "cookies", sessionId, tabId },
  });
});
