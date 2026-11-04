import {
  AgentSessionId,
  BrowserRequestId,
  BrowserTabId,
} from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BrowserDevtools } from "@/components/browser/browser-devtools";
import type { BrowserDevtoolsProps } from "@/components/browser/browser-devtools";
import { useAgentBrowserTooling } from "@/components/browser/browser-tooling";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

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

const renderDevtools = (
  mutationsLocked = false,
  overrides: Partial<BrowserDevtoolsProps> = {}
) =>
  render(
    createElement(
      RpcDependenciesProvider,
      { overrides: rpcOverrides },
      createElement(
        RegistryProvider,
        null,
        createElement(SessionDevtools, {
          consoleEntries: [],
          dockSide: "right",
          mutationsLocked,
          networkRequests: [],
          onClearConsole: () => {},
          onClearNetwork: () => {},
          onClose: () => {},
          onError: () => {},
          onRefreshNetwork: () => {},
          onToggleDockSide: () => {},
          panel: "storage",
          refreshingNetwork: false,
          tabId,
          tabTitle: "App",
          tabUrl: "https://app.example.com/home",
          ...overrides,
        })
      )
    )
  );

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
});

test("opens Storage with Cookies as the default inner tab", async () => {
  renderDevtools();
  expect(screen.getByRole("heading", { name: "Storage" })).toBeVisible();
  const user = await openStorage();
  expect(screen.getByRole("tab", { name: /Cookies/u })).toHaveAttribute(
    "aria-selected",
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
  await user.click(screen.getByRole("tab", { name: /localStorage/u }));
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
  await user.click(screen.getByRole("tab", { name: /localStorage/u }));
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
  await user.click(screen.getByRole("tab", { name: /Cookies/u }));
  await user.click(screen.getByRole("button", { name: "Add cookie" }));
  expect(
    screen.getByRole("button", { name: "Refresh storage" })
  ).toBeDisabled();
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
