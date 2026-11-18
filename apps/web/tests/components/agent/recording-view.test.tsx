import { TeachingRecordingId } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { afterEach, expect, test, vi } from "vitest";

import { RecordingViewer } from "@/components/agent/recording-view";
import type { RpcDependencies } from "@/lib/rpc-dependencies";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

type Cleanup =
  | { readonly _tag: "pending" }
  | {
      readonly _tag: "purge-pending";
      readonly failure: string | null;
      readonly retainedFiles: readonly string[];
    }
  | { readonly _tag: "purged"; readonly completedAt: string };

const PENDING_CLEANUP: Cleanup = { _tag: "pending" };

interface ReviewFixture {
  cleanup: Cleanup;
  decision: string;
  result: { readonly outcome: string };
  summary: null;
}

const setup = (
  outcome: string,
  decision = "pending",
  refusal?: string,
  initialCleanup = PENDING_CLEANUP
) => {
  const calls = vi.fn();
  const view: ReviewFixture = {
    cleanup: initialCleanup,
    decision,
    result: { outcome },
    summary: null,
  };
  const recordingViewAtom = Atom.family(() =>
    Atom.family(() =>
      Atom.make(() => ({
        _tag: "Success",
        value: { ...view },
        waiting: false,
      }))
    )
  );
  const mutation = (next: string, nextCleanup?: Cleanup) =>
    Atom.fn(
      (payload: {
        readonly payload: {
          readonly recordingId: TeachingRecordingId;
          readonly operationId: string;
        };
      }) =>
        Effect.sync(() => {
          calls(payload);
          if (refusal !== undefined) {
            throw new Error(refusal);
          }
          view.decision = next;
          if (nextCleanup !== undefined) {
            view.cleanup = nextCleanup;
          }
          return {};
        })
    );
  // Omit evidence to isolate the decision boundary from Summary rendering.
  // SAFETY: These fixtures implement the read and mutation atoms used by this component; Summary evidence is deliberately absent.
  const overrides = {
    agentTeachingCleanupRetryMutation: mutation("verified", {
      _tag: "purged",
      completedAt: "2026-11-18T00:00:00.000Z",
    }),
    agentTeachingFlowRejectMutation: mutation("rejected"),
    agentTeachingFlowVerifyMutation: mutation("verified"),
    recordingViewAtom,
  } as Partial<RpcDependencies>;
  render(
    <RegistryProvider>
      <RpcDependenciesProvider overrides={overrides}>
        <RecordingViewer
          recordingId={TeachingRecordingId.make("recording-review")}
        />
      </RpcDependenciesProvider>
    </RegistryProvider>
  );
  return calls;
};

test.each([
  ["Verify flow", "verified"],
  ["Reject flow", "rejected"],
])(
  "%s saves the user decision and removes both controls",
  async (name, decision) => {
    const calls = setup("passed");
    expect(calls).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name }));
    const bar = screen.getByRole("region", { name: "Flow decision" });
    await within(bar).findByText(new RegExp(`You ${decision} `, "u"));
    expect(calls).toHaveBeenCalledWith({
      payload: {
        operationId: expect.any(String),
        recordingId: "recording-review",
      },
    });
    expect(screen.queryByRole("button", { name: "Verify flow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject flow" })).toBeNull();
  }
);

test.each([
  ["failed", "pending"],
  ["passed", "verified"],
  ["passed", "rejected"],
])("hides decisions for %s/%s", (outcome, decision) => {
  setup(outcome, decision);
  expect(screen.queryByRole("button")).toBeNull();
});

test.each(["Verify flow", "Reject flow"])(
  "preserves the server refusal for %s",
  async (name) => {
    setup(
      "passed",
      "pending",
      "The Flow changed. Run another Dry Run before verifying."
    );
    await userEvent.click(screen.getByRole("button", { name }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Flow changed. Run another Dry Run before verifying."
    );
    expect(screen.getByRole("button", { name })).toBeEnabled();
  }
);

test("offers Retry cleanup when Cleanup kept files after verifying", async () => {
  const calls = setup("passed", "verified", undefined, {
    _tag: "purge-pending",
    failure: "The video was in use.",
    retainedFiles: ["video.webm"],
  });
  const bar = screen.getByRole("region", { name: "Flow decision" });
  expect(within(bar).getByRole("status")).toHaveTextContent(
    "Cleanup could not remove all of its Teaching evidence. The video was in use. It kept video.webm."
  );
  await userEvent.click(
    within(bar).getByRole("button", { name: "Retry cleanup" })
  );
  expect(calls).toHaveBeenCalledWith({
    payload: {
      operationId: expect.any(String),
      recordingId: "recording-review",
    },
  });
  await within(bar).findByText(/You verified /u);
  expect(screen.queryByRole("button", { name: "Retry cleanup" })).toBeNull();
});
