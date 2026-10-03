import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { WorkspaceBrowserStage } from "@/components/agent/workspace-browser-stage";
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
      <WorkspaceBrowserStage
        consoleEntries={[]}
        onClearConsole={() => {}}
        sessionId={sessionId}
        teaching={false}
        userHoldsBrowser={userHoldsBrowser}
      >
        <canvas aria-label="Live browser viewport" />
      </WorkspaceBrowserStage>
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
  expect(screen.getByRole("radio", { name: "1×" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  // The stage keeps the live frame it was handed beneath its tools.
  expect(screen.getByLabelText("Live browser viewport")).toBeInTheDocument();
});

test("rotates the applied viewport without changing its pixel ratio", async () => {
  renderSetup();
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Rotate viewport" }));
  await waitFor(() => {
    expect(rpc.emulationPatches).toHaveLength(1);
  });
  expect(rpc.emulationPatches.at(0)).toMatchObject({
    payload: {
      sessionId,
      viewport: { deviceScaleFactor: 1, height: 1280, width: 720 },
    },
  });
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
  await user.click(screen.getByRole("button", { name: "User agent" }));
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
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  expect(screen.getByLabelText("Device")).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  expect(
    screen.getByText(
      "The agent holds the browser. Take control to change its Emulation or storage."
    )
  ).toBeVisible();
  expect(screen.getByLabelText("Latitude")).toBeDisabled();
});

test("shows a fractional pixel ratio an identity applied", async () => {
  emulationResult.emulation.viewport.deviceScaleFactor = 2.625;
  try {
    renderSetup();
    expect(
      await screen.findByRole("radio", { name: "2.625×" })
    ).toHaveAttribute("aria-checked", "true");
  } finally {
    emulationResult.emulation.viewport.deviceScaleFactor = 1;
  }
});

test("keeps the Emulation card open when Escape dismisses its own dialog", async () => {
  renderSetup();
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  await user.type(screen.getByLabelText("Latitude"), "52.52");
  await user.type(screen.getByLabelText("Longitude"), "13.405");
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(screen.getByRole("region", { name: "Emulation" })).toBeVisible();
  expect(screen.getByLabelText("Latitude")).toHaveValue("52.52");
});

test("opens a configuration card over the stage and closes it with Escape", async () => {
  renderSetup();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  expect(screen.getByRole("region", { name: "Emulation" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Emulation" })
  ).not.toBeInTheDocument();
});

test("inspects the storage of the tab the Agent Session is showing", async () => {
  renderSetup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Storage" }));
  await waitFor(() => {
    expect(rpc.storageReads.length).toBeGreaterThan(0);
  });
  expect(rpc.storageReads.at(0)).toMatchObject({
    payload: { kind: "cookies", sessionId, tabId },
  });
});

test("docks an inspection panel beside the stage and moves it below", async () => {
  renderSetup();
  const canvas = screen.getByLabelText("Live browser viewport");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Console" }));
  expect(await screen.findByRole("region", { name: "Console" })).toBeVisible();
  const separator = screen.getByRole("separator", { name: "Resize DevTools" });
  expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await user.click(screen.getByRole("button", { name: "Dock to bottom" }));
  expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await user.click(screen.getByRole("button", { name: "Close DevTools" }));
  expect(
    screen.queryByRole("region", { name: "Console" })
  ).not.toBeInTheDocument();
  // Docking, moving, and closing the inspector keep the same live frame
  // rather than remounting it.
  expect(screen.getByLabelText("Live browser viewport")).toBe(canvas);
});
