import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { WorkspaceBrowserSetup } from "@/components/agent/workspace-browser-setup";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

/** What the Workspace sent, as the loopback RPC boundary received it. */
interface RecordedCall {
  readonly payload: {
    readonly data: {
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
    readonly type: string;
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
  data: {
    emulation: {
      permissions: [],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    userAgentProfile: "default",
  },
  type: "agent.browser.emulation.updated" as const,
};

const rpcOverrides = {
  agentBrowserEmulationMutation: Atom.fn((payload: RecordedCall) =>
    Effect.sync(() => {
      rpc.emulationPatches.push(payload);
      return emulationResult;
    })
  ),
  agentBrowserEmulationQuery: Atom.fn(() => Effect.succeed(emulationResult)),
  agentBrowserNetworkRequestMutation: Atom.fn(() => Effect.never),
  agentBrowserNetworkRequestsMutation: Atom.fn(() =>
    Effect.succeed({
      data: { requests: [] },
      type: "agent.browser.network.requests.result" as const,
    })
  ),
  agentBrowserStorageClearMutation: Atom.fn(() => Effect.never),
  agentBrowserStorageDeleteMutation: Atom.fn(() => Effect.never),
  agentBrowserStorageGetMutation: Atom.fn((payload: RecordedCall) =>
    Effect.sync(() => {
      rpc.storageReads.push(payload);
      return {
        data: { snapshot: { cookies: [], kind: "cookies" as const, tabId } },
        type: "agent.browser.storage.result" as const,
      };
    })
  ),
  agentBrowserStorageSetMutation: Atom.fn(() => Effect.never),
  agentBrowserTabsMutation: Atom.fn(() =>
    Effect.succeed({
      data: {
        tabs: [
          {
            active: true,
            tabId,
            title: "Shop",
            url: "https://shop.example.com/cart",
          },
        ],
      },
      type: "agent.browser.tabs.result" as const,
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
      data: {
        sessionId,
        viewport: { deviceScaleFactor: 1, height: 667, width: 375 },
      },
      type: "agent.browser.emulation.set",
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
    data: { sessionId, userAgentProfile: "chrome-android-mobile" },
    type: "agent.browser.emulation.set",
  });
  // A viewport here would overwrite the metrics the identity brings with it.
  expect(patch?.payload.data.viewport).toBeUndefined();
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
    payload: {
      data: { kind: "cookies", sessionId, tabId },
      type: "agent.browser.storage.get",
    },
  });
});
