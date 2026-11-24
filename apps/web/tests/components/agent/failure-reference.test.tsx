import {
  makeBrowserRpcError,
  withFailureReference,
} from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Atom } from "effect/reactivity";
import { afterEach, expect, test } from "vitest";

import { FailureReferenceNote } from "@/components/agent/failure-reference";
import { DockNotice } from "@/components/agent/workspace-dock";
import { failureMessage } from "@/lib/failure-message";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

const answering = (detail: string | null) => ({
  failureDetailAtom: () =>
    Atom.make(() => ({
      _tag: "Success" as const,
      value: { detail },
      waiting: false,
    })),
});

test("shows only the reference when the server keeps the cause to itself", () => {
  render(
    <RpcDependenciesProvider overrides={answering(null)}>
      <FailureReferenceNote failureReference="7KQ2MZ" />
    </RpcDependenciesProvider>
  );
  expect(screen.getByText("7KQ2MZ")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cause" })).toBeNull();
});

test("shows the cause collapsed under debug", async () => {
  render(
    <RpcDependenciesProvider overrides={answering("Error: adb exited 1")}>
      <FailureReferenceNote failureReference="7KQ2MZ" />
    </RpcDependenciesProvider>
  );
  const trigger = screen.getByRole("button", { name: "Cause" });
  expect(screen.queryByText("Error: adb exited 1")).toBeNull();
  await userEvent.click(trigger);
  expect(screen.getByText("Error: adb exited 1")).toBeTruthy();
});

/** A browser Workspace RPC defect, as the refused gesture's notice reads it. */
const defect = failureMessage(
  withFailureReference(
    makeBrowserRpcError("internal_failure", "Contingency failed unexpectedly."),
    "7KQ2MZ"
  ),
  "The gesture did not go through."
);

test.each([
  [null, false],
  ["Error: the page crashed", true],
] as const)(
  "a non-native RPC failure's notice offers the cause only under debug (%s)",
  async (detail, offered) => {
    render(
      <RpcDependenciesProvider overrides={answering(detail)}>
        <DockNotice>{defect}</DockNotice>
      </RpcDependenciesProvider>
    );
    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain("Contingency failed unexpectedly.");
    expect(screen.getByText("7KQ2MZ")).toBeTruthy();
    const trigger = screen.queryByRole("button", { name: "Cause" });
    expect(trigger !== null).toBe(offered);
    if (trigger !== null) {
      await userEvent.click(trigger);
      expect(screen.getByText("Error: the page crashed")).toBeTruthy();
    }
  }
);
