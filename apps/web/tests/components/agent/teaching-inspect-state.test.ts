import { AgentElementRef } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  attachSelection,
  closeComposer,
  completeInspectComment,
  emptyInspectState,
  leavePage,
  openComposer,
  startPicking,
  stopPicking,
} from "@/components/agent/teaching-inspect-state";

const frozen = {
  description: "button: Continue",
  height: 40,
  ref: AgentElementRef.make("e1"),
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  width: 120,
  x: 20,
  y: 60,
};

const text = "Use the express checkout here.";

test("a save completed after navigation consumes its number and clears the sent draft without a pin", () => {
  const sent = { ...emptyInspectState, draft: text, frozen };
  const navigated = leavePage(sent);
  expect(navigated.frozen).toBeUndefined();
  expect(navigated.draft).toBe(text);
  const completed = completeInspectComment(
    navigated,
    { frozen, text },
    4,
    false
  );
  expect(completed).toEqual({ ...emptyInspectState, nextCommentIndex: 5 });
});

test("a save completed on the same Page pins the element and closes the composer", () => {
  const completed = completeInspectComment(
    {
      ...emptyInspectState,
      composing: true,
      draft: text,
      frozen,
    },
    { frozen, text },
    5,
    true
  );
  expect(completed.comments.map((comment) => comment.index)).toEqual([5]);
  expect(completed).toMatchObject({
    composing: false,
    draft: "",
    frozen: undefined,
  });
});

test("a page comment clears the composer without a pin", () => {
  const completed = completeInspectComment(
    { ...emptyInspectState, composing: true, draft: text },
    { frozen: undefined, text },
    1,
    true
  );
  expect(completed.comments).toEqual([]);
  expect(completed.draft).toBe("");
  expect(completed.nextCommentIndex).toBe(2);
});

test("a save whose draft was replaced keeps the current editor", () => {
  const current = {
    ...emptyInspectState,
    composing: true,
    draft: "A different comment",
  };
  expect(completeInspectComment(current, { frozen, text }, 2, true)).toEqual({
    ...current,
    nextCommentIndex: 3,
  });
});

test("an older save response cannot roll marker numbering backward", () => {
  const current = { ...emptyInspectState, nextCommentIndex: 8 };
  expect(
    completeInspectComment(current, { frozen, text }, 3, false).nextCommentIndex
  ).toBe(8);
});

test("the pin keeps the document position from selection even if scrolling continues before save", () => {
  const selection = { ...frozen, scrollOffsetX: 50, scrollOffsetY: 200 };
  const completed = completeInspectComment(
    { ...emptyInspectState, draft: text, frozen: selection },
    { frozen: selection, text },
    1,
    true
  );
  expect(completed.comments[0]).toMatchObject({ x: 70, y: 260 });
});

test("a pick started from the composer returns to it on cancel and on attach", () => {
  const composing = openComposer({ ...emptyInspectState, draft: "Draft" });
  const picking = startPicking(composing);
  expect(picking).toMatchObject({ composing: false, open: true });
  expect(stopPicking(picking)).toMatchObject({
    composing: true,
    draft: "Draft",
    open: false,
  });
  expect(attachSelection(picking, frozen)).toMatchObject({
    composing: true,
    draft: "Draft",
    frozen,
    open: false,
  });
});

test("a pick started from the Page closes on cancel and opens the composer on attach", () => {
  const picking = startPicking(emptyInspectState);
  expect(stopPicking(picking)).toMatchObject({ composing: false, open: false });
  expect(attachSelection(picking, frozen).composing).toBe(true);
});

test("closing the composer keeps the draft and the attached element", () => {
  const closed = closeComposer({
    ...emptyInspectState,
    composing: true,
    draft: "Draft",
    frozen,
    highlighted: 2,
  });
  expect(closed).toMatchObject({
    composing: false,
    draft: "Draft",
    frozen,
    highlighted: undefined,
  });
});
