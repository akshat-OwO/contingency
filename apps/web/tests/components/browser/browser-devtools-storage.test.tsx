import {
  AgentSessionId,
  BrowserRequestId,
  BrowserTabId,
} from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { createElement, useState } from "react";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";

import { BrowserDevtools } from "@/components/browser/browser-devtools";
import type { BrowserDevtoolsProps } from "@/components/browser/browser-devtools";
import { useAgentBrowserTooling } from "@/components/browser/browser-tooling";
import { DismissableLayer } from "@/components/ui/dismissable-layer";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

import {
  stubResizableLayout,
  stubResizeObserver,
} from "../ui/resizable-layout";

const rpc = vi.hoisted(() => ({
  clear: vi.fn(),
  delete: vi.fn(),
  detailAvailable: vi.fn(() => false),
  detailGate: vi.fn((): Effect.Effect<void, Error> => Effect.void),
  get: vi.fn(),
  set: vi.fn(),
}));

const sessionId = AgentSessionId.make("agent-storage");
const tabId = BrowserTabId.make("tab-1");

const cookies = [
  {
    domain: ".example.com",
    expires: -1,
    httpOnly: true,
    name: "sid",
    path: "/",
    sameSite: "Lax" as const,
    secure: true,
    session: true,
    size: 16,
    value: "jwt-fragment-xyz",
  },
];

const rpcOverrides = (() => {
  const updated = {};
  return {
    agentBrowserNetworkRequestGetMutation: Atom.fn(() =>
      rpc.detailGate().pipe(
        Effect.andThen(() =>
          rpc.detailAvailable()
            ? Effect.succeed({
                request: {
                  headers: {},
                  method: "GET",
                  postData: "retry recovered",
                  requestId: BrowserRequestId.make("failed-detail"),
                  resourceType: "fetch",
                  tabId,
                  timestamp: 1,
                  url: "https://app.example.com/failed-detail",
                },
              })
            : Effect.fail(new Error("Request detail unavailable"))
        )
      )
    ),
    agentBrowserStorageClearMutation: Atom.fn((request) => {
      rpc.clear(request);
      return Effect.succeed(updated);
    }),
    agentBrowserStorageDeleteMutation: Atom.fn((request) => {
      rpc.delete(request);
      return Effect.succeed(updated);
    }),
    agentBrowserStorageGetMutation: Atom.fn(
      (request: { readonly payload: { readonly kind: string } }) => {
        rpc.get(request);
        const { kind } = request.payload;
        if (kind === "cookies") {
          return Effect.succeed({
            snapshot: { cookies, kind: "cookies" as const, tabId },
          });
        }
        return Effect.succeed({
          snapshot: {
            entries:
              kind === "local"
                ? { featureFlag: '{"on":true}' }
                : { nonce: "1" },
            kind,
            tabId,
          },
        });
      }
    ),
    agentBrowserStorageSetMutation: Atom.fn((request) => {
      rpc.set(request);
      return Effect.succeed(updated);
    }),
  };
})();

/** Devtools as the Workspace mounts it: over an Agent Session's port. */
const SessionDevtools = (props: Omit<BrowserDevtoolsProps, "tooling">) =>
  createElement(BrowserDevtools, {
    ...props,
    tooling: useAgentBrowserTooling(sessionId),
  });

const devtoolsTree = (
  mutationsLocked = false,
  overrides: Partial<BrowserDevtoolsProps> = {},
  visible = true
) =>
  createElement(
    RpcDependenciesProvider,
    { overrides: rpcOverrides },
    createElement(
      RegistryProvider,
      { defaultIdleTTL: 400 },
      visible
        ? createElement(SessionDevtools, {
            consoleEntries: [],
            dockSide: "right",
            mutationsLocked,
            networkRequests: [],
            onClearConsole: () => {},
            onClearNetwork: () => {},
            onClose: () => {},
            onError: () => {},
            onRefreshNetwork: () => {},
            onSelectPanel: () => {},
            onToggleDockSide: () => {},
            panel: "storage",
            refreshingNetwork: false,
            tabId,
            tabTitle: "App",
            tabUrl: "https://app.example.com/home",
            ...overrides,
          })
        : null
    )
  );
const renderDevtools = (
  mutationsLocked = false,
  overrides: Partial<BrowserDevtoolsProps> = {}
) => render(devtoolsTree(mutationsLocked, overrides));

const openStorage = async () => {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(screen.getByText("sid")).toBeInTheDocument();
  });
  return user;
};

beforeEach(() => {
  rpc.clear.mockReset();
  rpc.delete.mockReset();
  rpc.detailAvailable.mockReset();
  rpc.detailGate.mockReset();
  rpc.detailGate.mockReturnValue(Effect.void);
  rpc.get.mockReset();
  rpc.set.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("opens Storage with Cookies as the default storage area", async () => {
  renderDevtools();
  expect(
    within(screen.getByRole("group", { name: "DevTools panels" })).getByRole(
      "button",
      { name: "Storage" }
    )
  ).toHaveAttribute("aria-pressed", "true");
  const user = await openStorage();
  const area = screen.getByRole("radiogroup", { name: "Storage area" });
  expect(within(area).getByRole("radio", { name: "Cookies" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  expect(
    screen.getByRole("textbox", { name: "Search storage" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Fetch/XHR" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Clear storage for App/u })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeEnabled();
  await user.click(screen.getByRole("radio", { name: "Local" }));
  await waitFor(() => {
    expect(screen.getByText("featureFlag")).toBeInTheDocument();
  });
});

test("keeps inspect and search available while mutate controls stay visible and disabled while the agent controls the browser", async () => {
  renderDevtools(true);
  const user = await openStorage();
  expect(screen.getByText("jwt-fragment-xyz")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add cookie" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Clear Cookies/u })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Delete cookie sid" })
  ).toBeDisabled();
  expect(
    screen.getByText("Storage is locked while the agent controls the browser.")
  ).toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Search storage" }),
    "jwt-fragment"
  );
  expect(screen.getByText("sid")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh storage" })).toBeEnabled();
});

test("confirms Clear-this-store and deletes one cookie immediately", async () => {
  renderDevtools();
  const user = await openStorage();
  await user.click(screen.getByRole("button", { name: "Delete cookie sid" }));
  expect(rpc.delete).toHaveBeenCalled();
  expect(screen.queryByText("Clear this store?")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Clear Cookies/u }));
  expect(
    screen.getByText("Clear all cookies for this origin?")
  ).toBeInTheDocument();
  expect(rpc.clear).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(rpc.clear).toHaveBeenCalled();
});

test("requires Save on the cookie form and cancels without writing", async () => {
  renderDevtools();
  const user = await openStorage();
  await user.click(screen.getByRole("button", { name: "Add cookie" }));
  await user.type(screen.getByLabelText("Name"), "preview");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rpc.set).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Add cookie" }));
  await user.type(screen.getByLabelText("Name"), "preview");
  await user.type(screen.getByLabelText("Value"), "1");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(rpc.set).toHaveBeenCalled();
});

test("adds a Web Storage entry inline and disables Refresh while a cookie draft is dirty", async () => {
  renderDevtools();
  const user = await openStorage();
  await user.click(screen.getByRole("radio", { name: "Local" }));
  await waitFor(() => {
    expect(screen.getByText("featureFlag")).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "Add entry" }));
  await user.type(screen.getByLabelText("New storage key"), "flag");
  await user.click(screen.getByLabelText("New storage value"));
  expect(rpc.set).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("New storage value"), "on");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(rpc.set).toHaveBeenCalled();
  });
  await user.click(screen.getByRole("radio", { name: "Cookies" }));
  await user.click(screen.getByRole("button", { name: "Add cookie" }));
  expect(
    screen.getByRole("button", { name: "Refresh storage" })
  ).toBeDisabled();
});

test("Escape cancels the inline storage draft while keeping the Storage card open, then a second Escape closes the card", async () => {
  const onCardDismiss = vi.fn();
  const CardHarness = () => {
    const [open, setOpen] = useState(true);
    return open ? (
      <DismissableLayer
        onDismiss={() => {
          onCardDismiss();
          setOpen(false);
        }}
        render={<section aria-label="Storage card" />}
      >
        <SessionDevtools
          consoleEntries={[]}
          dockSide="right"
          mutationsLocked={false}
          networkRequests={[]}
          onClearConsole={() => {}}
          onClearNetwork={() => {}}
          onClose={() => setOpen(false)}
          onError={() => {}}
          onRefreshNetwork={() => {}}
          onSelectPanel={() => {}}
          onToggleDockSide={() => {}}
          panel="storage"
          refreshingNetwork={false}
          tabId={tabId}
          tabTitle="App"
          tabUrl="https://app.example.com/home"
        />
      </DismissableLayer>
    ) : null;
  };

  render(
    <RpcDependenciesProvider overrides={rpcOverrides}>
      <RegistryProvider defaultIdleTTL={400}>
        <CardHarness />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );

  const user = await openStorage();
  await user.click(screen.getByRole("radio", { name: "Local" }));
  await waitFor(() => {
    expect(screen.getByText("featureFlag")).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "Add entry" }));
  const keyInput = screen.getByLabelText("New storage key");
  await user.click(keyInput);
  await user.keyboard("{Enter}");
  expect(keyInput).toHaveAttribute("aria-invalid", "true");
  expect(rpc.set).not.toHaveBeenCalled();
  await user.type(keyInput, "temp");
  expect(keyInput).not.toHaveAttribute("aria-invalid", "true");

  // First Escape cancels the draft without writing or closing the surrounding card.
  await user.keyboard("{Escape}");
  expect(screen.queryByLabelText("New storage key")).toBeNull();
  expect(rpc.set).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Storage card" })
  ).toBeInTheDocument();
  expect(onCardDismiss).not.toHaveBeenCalled();

  // Second Escape closes the Storage card itself.
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Storage card" })).toBeNull();
  expect(onCardDismiss).toHaveBeenCalledTimes(1);
});

test("lists network requests as a table with durations and switches panels from the header", async () => {
  // jsdom has no layout; supply the viewport dimensions to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  const onSelectPanel = vi.fn<BrowserDevtoolsProps["onSelectPanel"]>();
  renderDevtools(false, {
    networkRequests: [
      {
        durationMs: 42.4,
        method: "GET",
        requestId: BrowserRequestId.make("shop-document"),
        resourceType: "document",
        status: 200,
        tabId,
        timestamp: 1,
        url: "https://app.example.com/shop.html",
      },
    ],
    onSelectPanel,
    panel: "network",
  });
  const table = screen.getByRole("table", { name: "Network requests" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent)
  ).toEqual(["Path", "Status", "Type", "Time"]);
  const [, row] = within(table).getAllByRole("row");
  expect(row).toHaveTextContent("GET shop.html 200 document 42 ms");
  expect(screen.getByText("1 request")).toBeInTheDocument();
  const panels = screen.getByRole("group", { name: "DevTools panels" });
  expect(
    within(panels).getByRole("button", { name: "Network" })
  ).toHaveAttribute("aria-pressed", "true");
  await userEvent
    .setup()
    .click(within(panels).getByRole("button", { name: "Console" }));
  expect(onSelectPanel).toHaveBeenCalledWith("console");
});

test("shows a failed detail fetch instead of reporting empty headers or payload", async () => {
  // jsdom has no layout; supply the viewport dimensions to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  renderDevtools(false, {
    networkRequests: [
      {
        method: "GET",
        requestId: BrowserRequestId.make("failed-detail"),
        resourceType: "fetch",
        tabId,
        timestamp: 1,
        url: "https://app.example.com/failed-detail",
      },
    ],
    panel: "network",
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /failed-detail/u }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load request details"
  );
  expect(screen.queryByText("No headers recorded.")).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Payload" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not load request details"
  );
  expect(
    screen.queryByText("This request has no payload.")
  ).not.toBeInTheDocument();
  rpc.detailAvailable.mockReturnValue(true);
  await user.click(
    screen.getByRole("button", { name: "Close request details" })
  );
  await user.click(screen.getByRole("button", { name: /failed-detail/u }));
  expect(await screen.findByText("retry recovered")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("ignores a late failed detail fetch after the same request is reselected", async () => {
  const old = await Effect.runPromise(Deferred.make<null, Error>());
  rpc.detailGate.mockReturnValueOnce(Deferred.await(old));
  // jsdom has no layout; supply the viewport dimensions to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  renderDevtools(false, {
    networkRequests: [
      {
        method: "GET",
        requestId: BrowserRequestId.make("failed-detail"),
        resourceType: "fetch",
        tabId,
        timestamp: 1,
        url: "https://app.example.com/failed-detail",
      },
    ],
    panel: "network",
  });

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /failed-detail/u }));
  expect(
    await screen.findByText("Loading request details…")
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Close request details" })
  );
  rpc.detailAvailable.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: /failed-detail/u }));
  await user.click(screen.getByRole("radio", { name: "Payload" }));
  expect(await screen.findByText("retry recovered")).toBeInTheDocument();
  await act(async () => {
    await Effect.runPromise(Deferred.fail(old, new Error("old fetch failed")));
  });
  expect(screen.getByText("retry recovered")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each(["before", "after"] as const)(
  "recovers retained request state when the old fetch completes %s remount",
  async (completion) => {
    // Keep the registry's production idle TTL under virtual time so state cannot
    // disappear merely because a slow runner took longer to remount the panel.
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
    const gate = await Effect.runPromise(Deferred.make<null>());
    rpc.detailGate.mockReturnValueOnce(
      Deferred.await(gate).pipe(Effect.asVoid)
    );
    rpc.detailAvailable.mockReturnValue(true);
    const options = {
      networkRequests: [
        {
          method: "GET",
          requestId: BrowserRequestId.make("failed-detail"),
          resourceType: "fetch",
          tabId,
          timestamp: 1,
          url: "https://app.example.com/failed-detail",
        },
      ],
      panel: "network" as const,
    };
    const view = renderDevtools(false, options);
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: /failed-detail/u }));
    });
    expect(screen.getByText("Loading request details…")).toBeInTheDocument();
    view.rerender(devtoolsTree(false, options, false));
    const finishOld = () =>
      act(async () => {
        await Effect.runPromise(Deferred.succeed(gate, null));
      });
    if (completion === "before") {
      await finishOld();
    }
    view.rerender(devtoolsTree(false, options));
    if (completion === "after") {
      await finishOld();
    }
    expect(
      screen.queryByText("Loading request details…")
    ).not.toBeInTheDocument();
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: /failed-detail/u }));
    });
    await act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Payload" }));
    });
    expect(screen.getByText("retry recovered")).toBeInTheDocument();
  }
);

/** The Resizable panel the open request detail sits in. */
const detailPanel = () =>
  screen
    .getByRole("button", { name: "Close request details" })
    .closest('[data-slot="resizable-panel"]');

test("opens a request's detail beside the list and resizes it from the keyboard", async () => {
  // jsdom has no layout; supply the viewport dimensions to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  // The split is 1000px wide; its 6px handle leaves the panes 994px.
  const restoreLayout = stubResizableLayout({
    handle: 6,
    height: 300,
    width: 1000,
  });
  const observer = stubResizeObserver();
  onTestFinished(() => {
    observer.restore();
    restoreLayout();
  });
  rpc.detailAvailable.mockReturnValue(true);
  renderDevtools(false, {
    dockSide: "bottom",
    networkRequests: [
      {
        method: "GET",
        requestId: BrowserRequestId.make("split-detail"),
        resourceType: "fetch",
        tabId,
        timestamp: 1,
        url: "https://app.example.com/split-detail",
      },
    ],
    panel: "network",
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /split-detail/u }));
  const handle = screen.getByRole("separator", {
    name: "Resize request details",
  });
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  // The handle reports the list's share in percent: the detail starts at
  // 360px of 994px, and the list keeps 400px while the detail keeps 320px.
  await waitFor(() => {
    expect(handle).toHaveAttribute("aria-valuenow", "64");
  });
  expect(handle).toHaveAttribute("aria-valuemin", "40");
  expect(handle).toHaveAttribute("aria-valuemax", "68");
  expect(Math.round(detailPanel()?.getBoundingClientRect().width ?? 0)).toBe(
    360
  );
  // The list stays usable beside the detail.
  expect(
    screen.getByRole("button", { name: /split-detail/u })
  ).toBeInTheDocument();
  handle.focus();
  // Each arrow trades 16px between the list and the detail.
  await user.keyboard("{ArrowLeft}");
  expect(Math.round(detailPanel()?.getBoundingClientRect().width ?? 0)).toBe(
    376
  );
  expect(handle).toHaveAttribute("aria-valuenow", "62");
  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(Math.round(detailPanel()?.getBoundingClientRect().width ?? 0)).toBe(
    344
  );
  expect(handle).toHaveAttribute("aria-valuenow", "65");
  await user.click(
    screen.getByRole("button", { name: "Close request details" })
  );
  expect(
    screen.queryByRole("separator", { name: "Resize request details" })
  ).not.toBeInTheDocument();
});

test("keeps the detail at its minimum while the split can't fit both panes, then restores its size", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  // 600px leaves the panes 594px: less than the list's 400px and the
  // detail's 320px together.
  const split = { handle: 6, height: 300, width: 600 };
  const restoreLayout = stubResizableLayout(split);
  const observer = stubResizeObserver();
  onTestFinished(() => {
    observer.restore();
    restoreLayout();
  });
  rpc.detailAvailable.mockReturnValue(true);
  renderDevtools(false, {
    dockSide: "bottom",
    networkRequests: [
      {
        method: "GET",
        requestId: BrowserRequestId.make("compact-detail"),
        resourceType: "fetch",
        tabId,
        timestamp: 1,
        url: "https://app.example.com/compact-detail",
      },
    ],
    panel: "network",
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /compact-detail/u }));
  const handle = screen.getByRole("separator", {
    name: "Resize request details",
  });
  const detailWidth = () =>
    Math.round(detailPanel()?.getBoundingClientRect().width ?? 0);
  await waitFor(() => {
    expect(detailWidth()).toBe(320);
  });

  // A drag toward the detail can't take it below its minimum.
  const pointer = {
    bubbles: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  };
  const at = (type: string, clientX: number, buttons: number) =>
    new PointerEvent(type, { ...pointer, buttons, clientX, clientY: 100 });
  act(() => {
    handle.dispatchEvent(at("pointerdown", 274, 1));
  });
  act(() => {
    document.dispatchEvent(at("pointermove", 500, 1));
  });
  act(() => {
    document.dispatchEvent(at("pointerup", 500, 0));
  });
  await waitFor(() => {
    expect(detailWidth()).toBe(320);
  });

  handle.focus();
  await user.keyboard("{ArrowRight}");
  expect(detailWidth()).toBe(320);

  // Neither moved the 360px the detail opens at: a split with room for both
  // panes gives it back.
  split.width = 1000;
  act(() => {
    observer.report();
  });
  await waitFor(() => {
    expect(detailWidth()).toBe(360);
  });
});
