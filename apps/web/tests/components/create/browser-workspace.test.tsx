import type {
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
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createWorkspaceAtom } from "@/components/create/create-workspace-state";
import {
  emulationDraftAtom,
  initialEmulationDraft,
} from "@/components/create/emulation-draft";

const sessionId = SessionId.make("create-checkout");
const tabId = BrowserTabId.make("tab-1");

const rpc = vi.hoisted(() => ({
  emulation: {
    permissions: [],
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  } as SessionEmulation,
  emulationSet: vi.fn(),
  open: vi.fn(),
  sessionClose: vi.fn(),
  sessionCreate: vi.fn(),
  userAgent: vi.fn(),
  viewport: vi.fn(),
}));

/** One mutation atom answering with a fixed payload, recording its request. */
const answer = <A,>(call: ((request: unknown) => void) | null, data: A) =>
  Atom.fn((request: unknown) => {
    call?.(request);
    return Effect.succeed({ data, type: "test.result" });
  });

vi.mock("@/lib/rpc", () => ({
  browserEmulationMutation: Atom.fn((request: unknown) => {
    rpc.emulationSet(request);
    return Effect.succeed({
      data: { emulation: rpc.emulation },
      type: "browser.emulation.updated" as const,
    });
  }),
  browserEmulationQuery: answer(null, { emulation: rpc.emulation }),
  browserFrameAckMutation: answer(null, {}),
  browserInputMutation: answer(null, {}),
  browserNavigationMutation: answer(null, {}),
  browserNetworkRequestMutation: answer(null, { request: null }),
  browserNetworkRequestsMutation: answer(null, { requests: [] }),
  browserOpenMutation: Atom.fn((request: unknown) => {
    rpc.open(request);
    return Effect.succeed({
      data: { sessionId, url: "https://example.com/" },
      type: "browser.opened" as const,
    });
  }),
  browserSessionAttachMutation: answer(null, { sessionId, url: "" }),
  browserSessionCloseMutation: answer(rpc.sessionClose, {}),
  browserSessionCreateMutation: answer(rpc.sessionCreate, { sessionId }),
  browserSessionsAtom: Atom.make({
    _tag: "Success" as const,
    value: { data: { sessions: [] }, type: "browser.sessions.result" },
    waiting: false,
  }),
  browserStorageClearMutation: answer(null, {}),
  browserStorageDeleteMutation: answer(null, {}),
  browserStorageGetMutation: answer(null, {
    snapshot: { cookies: [], kind: "cookies", tabId },
  }),
  browserStorageSetMutation: answer(null, {}),
  browserTabCloseMutation: answer(null, {}),
  browserTabNewMutation: answer(null, {}),
  browserTabSwitchMutation: answer(null, {}),
  browserTabsMutation: answer(null, { tabs: [] }),
  browserUserAgentMutation: Atom.fn((request: unknown) => {
    rpc.userAgent(request);
    return Effect.succeed({
      data: { url: "https://example.com/", userAgentProfile: "default" },
      type: "browser.user-agent.updated" as const,
    });
  }),
  browserViewportMutation: answer(rpc.viewport, {
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  }),
  runBrowserStream: () => Effect.never,
}));

const { BrowserWorkspace } =
  await import("@/components/create/browser-workspace");

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
      <BrowserWorkspace />
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
      <BrowserWorkspace />
    </RegistryProvider>
  );

/** The payload of the last `browser.open`, which carries the snapshot. */
const openedEmulation = () => {
  const call = rpc.open.mock.calls.at(-1)?.[0] as
    | { readonly payload: { readonly data: Record<string, unknown> } }
    | undefined;
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
  const { viewport } = opened.emulation as {
    readonly viewport: {
      readonly deviceScaleFactor: number;
      readonly width: number;
    };
  };
  expect(viewport.width).toBeLessThan(1280);
  expect(viewport.deviceScaleFactor).toBeGreaterThan(1);
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
    fireEvent.submit(address.closest("form") as HTMLFormElement);
    await Promise.resolve();
  });

  const submitted = openedEmulation();
  if (submitted === undefined) {
    throw new Error("The submission sent no request.");
  }
  const { userAgentProfile, viewport } = submitted.emulation as {
    readonly userAgentProfile: string;
    readonly viewport: { readonly width: number };
  };
  expect(viewport.width).toBe(500);
  // Editing the viewport is an override of the identity's default, not a
  // retreat from the identity itself.
  expect(userAgentProfile).toBe("chrome-android-mobile");
});

test("reapplies the identity onto the open session rather than reopening it", async () => {
  renderOpenSession();

  await chooseIdentity("Chrome — Android Mobile");

  const request = rpc.userAgent.mock.calls.at(-1)?.[0] as {
    readonly payload: { readonly data: Record<string, unknown> };
  };
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
  } as unknown as RecordingSnapshot;
  renderOpenSession(recording);

  expect(screen.getByRole("combobox", { name: "User agent" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Emulation" })).toBeDisabled();
  await Promise.resolve();
});
