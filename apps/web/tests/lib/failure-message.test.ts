import { makeBrowserRpcError } from "@contingency/protocol";
import { expect, test } from "vitest";

import { failureMessage, isLifecycleRefusal } from "@/lib/failure-message";

const FALLBACK = "The Workspace could not connect.";

test("reads the message off an Error", () => {
  expect(failureMessage(new Error("The socket closed."), FALLBACK)).toBe(
    "The socket closed."
  );
});

test("reads the message off a browser RPC refusal", () => {
  expect(
    failureMessage(
      makeBrowserRpcError(
        "agent_session_conflict",
        "Teaching Recording r-1 cannot be verified from verified."
      ),
      FALLBACK
    )
  ).toBe("Teaching Recording r-1 cannot be verified from verified.");
});

test("falls back rather than coercing a non-string message", () => {
  expect(failureMessage({ message: { code: 17 } }, FALLBACK)).toBe(FALLBACK);
  expect(failureMessage({ message: "" }, FALLBACK)).toBe(FALLBACK);
});

test("falls back for a failure with nothing to say", () => {
  for (const failure of [undefined, null, 17, {}, [], "   "]) {
    expect(failureMessage(failure, FALLBACK)).toBe(FALLBACK);
  }
});

test("takes a bare string failure as its own message", () => {
  expect(failureMessage("The stream ended.", FALLBACK)).toBe(
    "The stream ended."
  );
});

test("tells a lifecycle refusal apart from a transport failure", () => {
  expect(
    isLifecycleRefusal(makeBrowserRpcError("agent_session_not_found", "gone"))
  ).toBe(true);
  expect(
    isLifecycleRefusal(makeBrowserRpcError("agent_browser_failed", "crashed"))
  ).toBe(false);
  expect(isLifecycleRefusal(new Error("offline"))).toBe(false);
});
