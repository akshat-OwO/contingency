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
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  await user.click(screen.getByRole("combobox", { name: "Agent Session" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Agent Sessions" })
    ).getByRole("button", { name: /finished-checkout/u })
  );
  // History moves the route to another session before that read answers.
  rerender(view(later));
  await waitFor(() => expect(onSessionChange).toHaveBeenCalledWith(later));
  await act(() => Effect.runPromise(Deferred.succeed(gate, true)));
  expect(onSessionChange).not.toHaveBeenCalledWith(completed.id);
});

const routed = (
  requested: string,
  command: RpcDependencies["runAndroidWorkspaceCommand"]
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

test("a linked ended Run names itself in the picker but is no choice, and offers Task details and Done", async () => {
  const user = userEvent.setup();
  render(routed(completed.id, runAndroidWorkspaceCommand));
  const picker = await screen.findByRole("combobox", { name: "Agent Session" });
  // The trigger names the ended session, as iOS does.
  await waitFor(() =>
    expect(picker).toHaveTextContent("finished-checkout · Run")
  );
  const status = screen.getByRole("region", { name: "Session status" });
  expect(within(status).getByText("Ended")).toBeVisible();
  expect(
    within(status).getByRole("button", {
      name: "The Run ended. Its summary is beside it.",
    })
  ).toBeVisible();
  expect(
    within(status).getByRole("button", { name: "Task details" })
  ).toBeVisible();
  expect(within(status).getByRole("button", { name: "Done" })).toBeVisible();
  expect(
    within(status).queryByRole("button", { name: "New session" })
  ).toBeNull();
  // The listed sessions it would open hold no ended one, and nothing closes.
  await user.click(picker);
  const sessions = await screen.findByRole("dialog", {
    name: "Agent Sessions",
  });
  expect(
    within(sessions).queryByRole("button", { name: /finished-checkout/u })
  ).toBeNull();
  expect(
    within(sessions).queryByRole("button", { name: "Close session" })
  ).toBeNull();
});

test("an observe that fails because the Run ended leaves no alert", async () => {
  const live = AgentSessionId.make("agent-live");
  const running: AndroidWorkspaceSnapshot = {
    ...completed,
    completedAt: null,
    controller: "agent",
    id: live,
    kind: "dry-run",
    phase: "running",
  };
  const reads: string[] = [];
  render(
    routed(live, (command) => {
      if (command._tag === "observe") {
        return Effect.fail(
          makeBrowserRpcError(
            "agent_session_invalid",
            "This Android session has ended, so there is nothing to observe."
          )
        );
      }
      reads.push(command._tag);
      // The route's read finds it running; the follow-up read, ended.
      return Effect.succeed(
        reads.length === 1
          ? running
          : { ...completed, id: live, kind: "dry-run" as const, revision: 1 }
      );
    })
  );
  const status = await screen.findByRole("region", { name: "Session status" });
  await waitFor(() => expect(within(status).getByText("Ended")).toBeVisible());
  expect(reads).toEqual(["read", "read"]);
  expect(screen.queryByText("The Android session did not answer")).toBeNull();
});

test("an observe that fails while the session still runs says it did not answer", async () => {
  const live = AgentSessionId.make("agent-live");
  const running: AndroidWorkspaceSnapshot = {
    ...completed,
    completedAt: null,
    controller: "agent",
    id: live,
    kind: "dry-run",
    phase: "running",
  };
  render(
    routed(live, (command) =>
      command._tag === "observe"
        ? Effect.fail(
            makeBrowserRpcError("agent_session_invalid", "adb went away.")
          )
        : Effect.succeed(running)
    )
  );
  expect(
    await screen.findByText("The Android session did not answer")
  ).toBeVisible();
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
  expect(screen.queryByRole("combobox", { name: "Agent Session" })).toBeNull();
});
