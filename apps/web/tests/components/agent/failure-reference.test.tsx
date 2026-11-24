import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Atom } from "effect/reactivity";
import { afterEach, expect, test } from "vitest";

import { FailureReferenceNote } from "@/components/agent/failure-reference";
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
