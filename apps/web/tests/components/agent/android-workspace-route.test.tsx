import {
  AgentSessionId,
  FlowName,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
} from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidWorkspace } from "@/components/agent/android-workspace";
import type { RpcDependencies } from "@/lib/rpc-dependencies";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

/** Reads of these sessions answer only when the test opens the gate. */
const held = new Map<string, Deferred.Deferred<true>>();

const app = {
  label: "Permission fixture",
  launchActivity: "dev.fixture/.MainActivity",
  package: "dev.fixture",
  versionCode: "1",
  versionName: "1.0",
};
const completed: AndroidWorkspaceSnapshot = {
  assessment: null,
  captureGaps: [],
  captureState: null,
  cleanup: null,
  completedAt: "2026-10-15T00:00:00.000Z",
  controller: "user",
  error: null,
  field: null,
  flowName: FlowName.make("finished-checkout"),
  id: AgentSessionId.make("agent-completed"),
  kind: "run",
  observation: null,
  phase: "completed",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: { capabilities: [], platform: "android" },
  revision: 0,
  selection: {
    device: {
      api: 36,
      avd: "Pixel_9",
      fingerprint: "Nothing/A059",
      host: "local",
      serial: "phone",
    },
    environment: {
      androidVersion: "16",
      appBuild: "1",
      appId: "dev.fixture",
      startingState: "Fresh fixture data",
    },
    helperConsent: "none",
    outcomes: [{ name: "Done", role: "text" }],
    setup: {
      activity: app.launchActivity,
      conditions: [{ name: "Fresh fixture data", role: "text" }],
      kind: "restart-activity",
    },
  },
  startedAt: "2026-10-15T00:00:00.000Z",
  takeoverOccurred: false,
};

/** Every command answers with `completed`, under the session it named. */
const runAndroidWorkspaceCommand = (command: AndroidWorkspaceCommand) =>
  Effect.gen(function* answer() {
    const sessionId = "sessionId" in command ? command.sessionId : undefined;
    const gate = held.get(sessionId ?? "");
    if (gate !== undefined) {
      yield* Deferred.await(gate);
    }
    return {
      ...completed,
      id: AgentSessionId.make(sessionId ?? completed.id),
    };
  });

afterEach(() => {
  cleanup();
  held.clear();
});

test("a session picked before the route moved on does not take it back", async () => {
  const user = userEvent.setup();
  const gate = Effect.runSync(Deferred.make<true>());
  held.set(completed.id, gate);
  const later = AgentSessionId.make("agent-later");
  const onSessionChange = vi.fn();
  const sessions: RpcDependencies["androidSessionsAtom"] = Atom.make(
    AsyncResult.success([completed])
  );
  const view = (requested: string) => (
    <RpcDependenciesProvider
      overrides={{ androidSessionsAtom: sessions, runAndroidWorkspaceCommand }}
    >
      <RegistryProvider>
        <AndroidWorkspace
          onSessionChange={onSessionChange}
          requestedSessionId={requested}
        />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );
  const { rerender } = render(view("new"));
  // Picking a session starts a read that has not answered yet.
  await user.click(
    screen.getByRole("combobox", { name: "Android Agent Session" })
  );
  await user.click(
    await screen.findByRole("option", { name: /finished-checkout/u })
  );
  // History moves the route to another session before that read answers.
  rerender(view(later));
  await waitFor(() => expect(onSessionChange).toHaveBeenCalledWith(later));
  await act(() => Effect.runPromise(Deferred.succeed(gate, true)));
  expect(onSessionChange).not.toHaveBeenCalledWith(completed.id);
});

const routed = (
  requested: string,
  command: typeof runAndroidWorkspaceCommand
) => (
  <RpcDependenciesProvider
    overrides={{
      // The server lists only live sessions; an ended one is not among them.
      androidSessionsAtom: Atom.make(AsyncResult.success([])),
      runAndroidWorkspaceCommand: command,
    }}
  >
    <RegistryProvider>
      <AndroidWorkspace
        onSessionChange={vi.fn()}
        requestedSessionId={requested}
      />
    </RegistryProvider>
  </RpcDependenciesProvider>
);

test("a linked ended session shows its outcome but is no picker choice", async () => {
  render(routed(completed.id, runAndroidWorkspaceCommand));
  const picker = await screen.findByRole("combobox", {
    name: "Android Agent Session",
  });
  // Nothing is selected: the trigger shows its placeholder, not the session,
  // and the listed sessions it would open hold no ended one.
  await waitFor(() => expect(picker).toHaveTextContent("Android session"));
  expect(picker).not.toHaveTextContent("finished-checkout");
  expect(screen.getByRole("button", { name: "New session" })).toBeVisible();
});

test("a link to a session with no record says it is gone and selects nothing", async () => {
  const missing = AgentSessionId.make("agent-missing");
  render(
    routed(missing, () =>
      Effect.fail(
        makeBrowserRpcError(
          "agent_session_not_found",
          "No valid persisted Android summary exists for this session."
        )
      )
    )
  );
  expect(
    await screen.findByText(
      "The session this link named is no longer available."
    )
  ).toBeVisible();
  expect(screen.queryByText("The Android session did not answer")).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: "Android Agent Session" })
  ).toBeNull();
});
