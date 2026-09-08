import type {
  BrowserTab,
  RecordingSnapshot,
  SessionEmulation,
} from "@contingency/protocol";
import { BrowserTabId, SessionId } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BrowserWorkspace } from "@/components/create/browser-workspace";
import { createWorkspaceAtom } from "@/components/create/create-workspace-state";
import {
  emulationDraftAtom,
  initialEmulationDraft,
} from "@/components/create/emulation-draft";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

const sessionId = SessionId.make("create-checkout");
const tabId = BrowserTabId.make("tab-1");

const rpc = vi.hoisted(() => ({
  emulation: {
    permissions: [],
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  } satisfies SessionEmulation,
  emulationSet: vi.fn(),
  open: vi.fn(),
  sessionClose: vi.fn(),
  sessionCreate: vi.fn(),
  tabs: [] satisfies BrowserTab[],
  userAgent: vi.fn(),
  viewport: vi.fn(),
}));

/** One mutation atom answering with a fixed payload, recording its request. */
const answer = <A,>(data: A) =>
  Atom.fn(() => Effect.succeed({ data, type: "test.result" }));

const recordingAnswer = <Request, A>(
  call: (request: Request) => void,
  data: A
) =>
  Atom.fn((request: Request) => {
    call(request);
    return Effect.succeed({ data, type: "test.result" });
  });

const rpcOverrides = {
  browserEmulationMutation: Atom.fn(<Request,>(request: Request) => {
    rpc.emulationSet(request);
    return Effect.succeed({
      data: { emulation: rpc.emulation },
      type: "browser.emulation.updated",
    });
  }),
  browserEmulationQuery: answer({ emulation: rpc.emulation }),
  browserFrameAckMutation: answer({}),
  browserInputMutation: answer({}),
  browserNavigationMutation: answer({}),
  browserNetworkRequestMutation: answer({ request: null }),
  browserNetworkRequestsMutation: answer({ requests: [] }),
  browserOpenMutation: Atom.fn(<Request,>(request: Request) => {
    rpc.open(request);
    return Effect.succeed({
      data: { sessionId, url: "https://example.com/" },
      type: "browser.opened",
    });
  }),
  browserSessionAttachMutation: answer({ sessionId, url: "" }),
  browserSessionCloseMutation: recordingAnswer(rpc.sessionClose, {}),
  browserSessionCreateMutation: recordingAnswer(rpc.sessionCreate, {
    sessionId,
  }),
  browserSessionsAtom: Atom.make({
    _tag: "Success",
    value: { data: { sessions: [] }, type: "browser.sessions.result" },
    waiting: false,
  }),
  browserStorageClearMutation: answer({}),
  browserStorageDeleteMutation: answer({}),
  browserStorageGetMutation: answer({
    snapshot: { cookies: [], kind: "cookies", tabId },
  }),
  browserStorageSetMutation: answer({}),
  browserTabCloseMutation: answer({}),
  browserTabNewMutation: answer({}),
  browserTabSwitchMutation: answer({}),
  browserTabsMutation: Atom.fn(() =>
    Effect.succeed({
      data: { tabs: rpc.tabs },
      type: "browser.tabs.result",
    })
  ),
  browserUserAgentMutation: Atom.fn(<Request,>(request: Request) => {
    rpc.userAgent(request);
    return Effect.succeed({
      data: { url: "https://example.com/", userAgentProfile: "default" },
      type: "browser.user-agent.updated",
    });
  }),
  browserViewportMutation: recordingAnswer(rpc.viewport, {
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  }),
  runBrowserStream: () => Effect.never,
};

const renderWorkspace = (recording: RecordingSnapshot | null = null) =>
  render(
    <RegistryProvider
      initialValues={[
        [emulationDraftAtom, initialEmulationDraft],
        [
          createWorkspaceAtom,
          {
            activeTabId: undefined,
            address: "",
            recording,
            selectedSessionId: undefined,
          },
        ],
      ]}
    >
      <RpcDependenciesProvider overrides={rpcOverrides}>
        <BrowserWorkspace />
      </RpcDependenciesProvider>
    </RegistryProvider>
  );

/** A workspace already showing a page, as it is after the first navigation. */
const renderOpenSession = (recording: RecordingSnapshot | null = null) =>
  render(
    <RegistryProvider
      initialValues={[
        [emulationDraftAtom, initialEmulationDraft],
        [
          createWorkspaceAtom,
          {
            activeTabId: tabId,
            address: "https://example.com/",
            recording,
            selectedSessionId: sessionId,
          },
        ],
      ]}
    >
      <RpcDependenciesProvider overrides={rpcOverrides}>
        <BrowserWorkspace />
      </RpcDependenciesProvider>
    </RegistryProvider>
  );

/** The payload of the last `browser.open`, which carries the snapshot. */
const openedEmulation = () => {
  const call = rpc.open.mock.calls.at(-1)?.[0];
  return call?.payload.data;
};

const chooseIdentity = async (label: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: "User agent" }));
  const options = await screen.findAllByRole("option");
  const option = options.find((element) => element.textContent === label);
  if (option === undefined) {
    throw new Error(`No identity labelled ${label} is offered.`);
  }
  await userEvent.click(option);
};

const submitAddress = async (url: string) => {
  const address = screen.getByRole("textbox", { name: "Browser address" });
  await userEvent.type(address, `${url}{Enter}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.tabs = [];
});

afterEach(cleanup);

test("composes Emulation before a session exists and applies it at the first navigation", async () => {
  renderWorkspace();

  await chooseIdentity("Chrome — Android Mobile");
  await userEvent.click(screen.getByRole("button", { name: "Emulation" }));
  const locale = screen.getByLabelText("Locale");
  await userEvent.type(locale, "de-DE");
  await userEvent.tab();
  await userEvent.keyboard("{Escape}");
  await submitAddress("example.com");

  const opened = openedEmulation();
  if (opened === undefined) {
    throw new Error("The first navigation sent no request.");
  }
  expect(opened.url).toBe("example.com");
  // One value carrying every setting the controls displayed, rather than an
  // identity now and an environment patched in after the first request.
  expect(opened.emulation).toMatchObject({
    locale: "de-DE",
    userAgentProfile: "chrome-android-mobile",
  });
  const { viewport } = opened.emulation;
  expect(viewport.width).toBeLessThan(1280);
  expect(viewport.deviceScaleFactor).toBeGreaterThan(1);
});

test("uses the active tab origin as the default location permission scope", async () => {
  rpc.tabs = [
    {
      active: true,
      label: null,
      tabId,
      title: "Shop",
      type: "page",
      url: "https://shop.example/cart",
    },
  ];
  renderOpenSession();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Shop" })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("button", { name: "Emulation" }));
  await userEvent.type(screen.getByLabelText("Latitude"), "52.52");
  await userEvent.type(screen.getByLabelText("Longitude"), "13.405");
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));

  const currentWebsite = screen.getByRole("radio", {
    name: /Current website only \(https:\/\/shop\.example\)/u,
  });
  expect(currentWebsite).toBeChecked();
  await userEvent.click(
    screen.getByRole("button", { name: "Apply and grant location" })
  );

  const request = rpc.emulationSet.mock.calls.at(-1)?.[0];
  expect(request.payload.data).toMatchObject({
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: [
      {
        origin: "https://shop.example",
        permission: "geolocation",
        state: "granted",
      },
    ],
    sessionId,
  });
});

test("sends a viewport edit made in the same tick as the submission", async () => {
  renderWorkspace();

  await chooseIdentity("Chrome — Android Mobile");
  const address = screen.getByRole("textbox", { name: "Browser address" });
  await userEvent.type(address, "example.com");

  // No render happens between the edit and the submission, so a submission
  // that read its viewport out of the last render would send the stale one.
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Viewport width"), {
      target: { value: "500" },
    });
    fireEvent.submit(address.closest("form"));
    await Promise.resolve();
  });

  const submitted = openedEmulation();
  if (submitted === undefined) {
    throw new Error("The submission sent no request.");
  }
  const { userAgentProfile, viewport } = submitted.emulation;
  expect(viewport.width).toBe(500);
  // Editing the viewport is an override of the identity's default, not a
  // retreat from the identity itself.
  expect(userAgentProfile).toBe("chrome-android-mobile");
});

test("reapplies the identity onto the open session rather than reopening it", async () => {
  renderOpenSession();

  await chooseIdentity("Chrome — Android Mobile");

  const request = rpc.userAgent.mock.calls.at(-1)?.[0];
  // The whole identity is reapplied and the current URL reloaded, on the
  // session that already holds the page's cookies and storage.
  expect(request.payload.data).toMatchObject({
    sessionId,
    url: "https://example.com/",
    userAgentProfile: "chrome-android-mobile",
  });
  expect(rpc.open).not.toHaveBeenCalled();
  expect(rpc.sessionCreate).not.toHaveBeenCalled();
  expect(rpc.sessionClose).not.toHaveBeenCalled();
});

test("locks the Emulation controls while the session is being recorded", async () => {
  const recording = {
    captureMode: "ordinary",
    flow: { steps: [], title: "Checkout" },
    initialUrl: "https://example.com/",
    phase: "active",
    recordedSteps: [],
    revision: 1,
    sessionId,
    tabId,
    undoAvailable: false,
  } satisfies unknown;
  renderOpenSession(recording);

  expect(screen.getByRole("combobox", { name: "User agent" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Emulation" })).toBeDisabled();
  await Promise.resolve();
});
