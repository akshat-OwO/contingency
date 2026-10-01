import { AgentElementRef } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  completeInspectComment,
  emptyInspectState,
} from "@/components/agent/teaching-inspect-state";

const frozen = {
  description: "button: Continue",
  height: 40,
  ref: AgentElementRef.make("e1"),
  width: 120,
  x: 20,
  y: 60,
};

test("a save completed after navigation consumes its recorded number without restoring a pin", () => {
  const navigated = { ...emptyInspectState, pending: true };
  const completed = completeInspectComment(navigated, frozen, 4, false);
  expect(completed).toEqual({
    ...emptyInspectState,
    nextCommentIndex: 5,
  });
  const next = completeInspectComment(
    { ...completed, frozen, open: true, pending: true },
    frozen,
    5,
    true
  );
  expect(next.comments.map((comment) => comment.index)).toEqual([5]);
  expect(next.pending).toBe(false);
  expect(next.open).toBe(false);
  expect(next.frozen).toBeUndefined();
});

test("a save completed after cancellation clears pending and keeps the current editor", () => {
  const replacement = { ...frozen, description: "button: Back" };
  const current = {
    ...emptyInspectState,
    draft: "A different comment",
    frozen: replacement,
    open: true,
    pending: true,
  };
  expect(completeInspectComment(current, frozen, 2, true)).toEqual({
    ...current,
    nextCommentIndex: 3,
    pending: false,
  });
});

test("an older save response cannot roll marker numbering backward", () => {
  const current = { ...emptyInspectState, nextCommentIndex: 8, pending: true };
  expect(completeInspectComment(current, frozen, 3, false)).toEqual({
    ...current,
    pending: false,
  });
});
