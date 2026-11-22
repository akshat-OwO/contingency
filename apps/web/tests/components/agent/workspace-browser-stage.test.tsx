import { RegistryProvider } from "@effect/atom-react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { WorkspaceBrowserStage } from "@/components/agent/workspace-browser-stage";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

import {
  stubResizableLayout,
  stubResizeObserver,
} from "../ui/resizable-layout";

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

const renderSetup = (
  userHoldsBrowser = true,
  emulationFixed = false,
  ended = false
) =>
  render(
    <Harness>
      <WorkspaceBrowserStage
        browserControls={null}
        consoleEntries={[]}
        emulationFixed={emulationFixed}
        ended={ended}
        onClearConsole={() => {}}
        sessionId={sessionId}
        streamStatus="live"
        teaching={false}
        userHoldsBrowser={userHoldsBrowser}

        topBar={(deviceBar) => deviceBar}
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
      "The agent holds the browser. Take control to change its Emulation or storage.",
      // The device bar's lock tooltip carries the same words, kept mounted.
      { selector: "p" }
    )
  ).toBeVisible();
  expect(screen.getByLabelText("Latitude")).toBeDisabled();
});

test("fixes the Emulation once recording starts", async () => {
  renderSetup(true, true);
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  expect(screen.getByLabelText("Device")).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  expect(
    screen.getByText(
      "Emulation is fixed once recording starts: the recording declares the Emulation it was demonstrated under.",
      // The device bar's lock tooltip carries the same words, kept mounted.
      { selector: "p" }
    )
  ).toBeVisible();
  expect(screen.getByLabelText("Latitude")).toBeDisabled();
  expect(rpc.emulationPatches).toHaveLength(0);
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
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Emulation" })
  ).not.toBeInTheDocument();
});

test("keeps the Emulation card open when Escape dismisses its Permission select", async () => {
  renderSetup();
  expect(await screen.findByText("1280 × 720")).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  await user.click(screen.getByLabelText("Permission"));
  expect(await screen.findByRole("option", { name: "camera" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: "camera" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Emulation" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Emulation" })
  ).not.toBeInTheDocument();
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

test("pressing the open DevTools panel keeps it open and dismisses a card", async () => {
  renderSetup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Console" }));
  expect(await screen.findByRole("region", { name: "Console" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Emulation" }));
  expect(screen.getByRole("region", { name: "Emulation" })).toBeVisible();

  const panels = screen.getByRole("group", { name: "DevTools panels" });
  const consolePanel = within(panels).getByRole("button", { name: "Console" });
  await user.click(consolePanel);
  expect(
    screen.queryByRole("region", { name: "Emulation" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Console" })).toBeVisible();
  expect(consolePanel).toHaveAttribute("aria-pressed", "true");
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

/** The docked DevTools panel the Console sits in. */
const consolePanel = () =>
  screen
    .getByRole("region", { name: "Console" })
    .closest('[data-slot="resizable-panel"]');

test("resizes docked DevTools in pixels and keeps the size when it reopens", async () => {
  // A 1280px region leaves the stage and DevTools 1212px beside the rail.
  const restoreLayout = stubResizableLayout({
    height: 600,
    outside: { height: 600, width: 1280 },
    width: 1212,
  });
  const observer = stubResizeObserver();
  onTestFinished(() => {
    observer.restore();
    restoreLayout();
  });
  renderSetup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Console" }));
  const width = () =>
    Math.round(consolePanel()?.getBoundingClientRect().width ?? 0);
  const separator = screen.getByRole("separator", { name: "Resize DevTools" });
  // The handle reports the stage's share: DevTools starts 432px wide, may
  // shrink to 220px, and may take 70% of the region.
  await waitFor(() => {
    expect(width()).toBe(432);
  });
  expect(separator).toHaveAttribute("aria-valuenow", "64");
  expect(separator).toHaveAttribute("aria-valuemin", "30");
  expect(separator).toHaveAttribute("aria-valuemax", "82");

  separator.focus();
  // Each arrow trades 16px; ArrowLeft grows DevTools beside the page.
  await user.keyboard("{ArrowLeft}");
  expect(width()).toBe(448);
  await user.keyboard("{ArrowLeft}{ArrowRight}");
  expect(width()).toBe(448);

  await user.click(screen.getByRole("button", { name: "Close DevTools" }));
  await user.click(screen.getByRole("button", { name: "Console" }));
  await waitFor(() => {
    expect(width()).toBe(448);
  });
});

test("switches DevTools panels from its header", async () => {
  renderSetup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Console" }));
  const panels = await screen.findByRole("group", { name: "DevTools panels" });
  await user.click(within(panels).getByRole("button", { name: "Network" }));
  expect(await screen.findByRole("region", { name: "Network" })).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Console" })
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("navigation", { name: "Browser tools" })).getByRole(
      "button",
      { name: "Network" }
    )
  ).toHaveAttribute("aria-pressed", "true");
});

test("marks the live stream on the rail", async () => {
  renderSetup();
  expect(
    await screen.findByRole("button", { name: "Stream diagnostics" })
  ).toHaveAttribute("aria-description", "Live");
});

test("an ended stage hides the device bar and the tools rail", () => {
  renderSetup(false, false, true);
  expect(
    screen.queryByRole("toolbar", { name: "Device controls" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Browser tools" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Browser stage" })).toBeVisible();
});
