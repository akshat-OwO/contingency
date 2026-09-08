import { BrowserTabId, SessionId } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BrowserDevtools } from "@/components/create/browser-devtools";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

const rpc = vi.hoisted(() => ({
  clear: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

const sessionId = SessionId.make("create-storage");
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
  const updated = { data: {}, type: "browser.storage.updated" as const };
  return {
    browserNetworkRequestMutation: Atom.fn(() =>
      Effect.succeed({
        data: {
          request: {
            headers: {},
            method: "GET",
            requestId: "r1",
            resourceType: "Document",
            tabId,
            timestamp: 1,
            url: "https://app.example.com",
          },
        },
        type: "browser.network.request.result" as const,
      })
    ),
    browserStorageClearMutation: Atom.fn((request) => {
      rpc.clear(request);
      return Effect.succeed(updated);
    }),
    browserStorageDeleteMutation: Atom.fn((request) => {
      rpc.delete(request);
      return Effect.succeed(updated);
    }),
    browserStorageGetMutation: Atom.fn(
      (request: {
        readonly payload: { readonly data: { readonly kind: string } };
      }) => {
        rpc.get(request);
        const { kind } = request.payload.data;
        if (kind === "cookies") {
          return Effect.succeed({
            data: { snapshot: { cookies, kind: "cookies" as const, tabId } },
            type: "browser.storage.result" as const,
          });
        }
        return Effect.succeed({
          data: {
            snapshot: {
              entries:
                kind === "local"
                  ? { featureFlag: '{"on":true}' }
                  : { nonce: "1" },
              kind,
              tabId,
            },
          },
          type: "browser.storage.result" as const,
        });
      }
    ),
    browserStorageSetMutation: Atom.fn((request) => {
      rpc.set(request);
      return Effect.succeed(updated);
    }),
  };
})();

const renderDevtools = (mutationsLocked = false) =>
  render(
    createElement(
      RpcDependenciesProvider,
      { overrides: rpcOverrides },
      createElement(
        RegistryProvider,
        null,
        createElement(BrowserDevtools, {
          consoleEntries: [],
          mutationsLocked,
          networkRequests: [],
          onClearConsole: () => {},
          onClearNetwork: () => {},
          onClose: () => {},
          onError: () => {},
          onRefreshNetwork: () => {},
          refreshingNetwork: false,
          sessionId,
          tabId,
          tabTitle: "App",
          tabUrl: "https://app.example.com/home",
        })
      )
    )
  );

const openStorage = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Storage" }));
  await waitFor(() => {
    expect(screen.getByText("sid")).toBeInTheDocument();
  });
  return user;
};

beforeEach(() => {
  rpc.clear.mockReset();
  rpc.delete.mockReset();
  rpc.get.mockReset();
  rpc.set.mockReset();
});

afterEach(() => {
  cleanup();
});

test("opens Storage beside Console and Network with Cookies as the default inner tab", async () => {
  renderDevtools();
  expect(screen.getByRole("tab", { name: "Storage" })).toHaveTextContent(
    /^Storage$/u
  );
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

test("keeps inspect and search available while mutate controls stay visible and disabled during a Recording", async () => {
  renderDevtools(true);
  const user = await openStorage();
  expect(screen.getByText("jwt-fragment-xyz")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add cookie" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Clear Cookies/u })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Delete cookie sid" })
  ).toBeDisabled();
  expect(
    screen.getByText("Storage is locked while the Recording is in progress.")
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
