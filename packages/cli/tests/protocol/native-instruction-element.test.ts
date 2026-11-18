import {
  AndroidWorkspaceCommand,
  IosWorkspaceCommand,
  TeachingEvent,
} from "@contingency/protocol";
import { Result, Schema } from "effect";
import { expect, test } from "vitest";

const comment = {
  _tag: "instruction",
  operationId: "op-comment",
  sessionId: "agent-android-comment",
  text: "Edit opens the profile.",
};
const element = { observationId: "observation-3", target: "@e2" };

test("a native comment may name one element of an observation", () => {
  for (const schema of [AndroidWorkspaceCommand, IosWorkspaceCommand]) {
    const decode = Schema.decodeUnknownResult(schema);
    expect(Result.isSuccess(decode(comment))).toBe(true);
    expect(decode({ ...comment, element })).toMatchObject({
      success: { element },
    });
    expect(
      Result.isFailure(
        decode({ ...comment, element: { observationId: "", target: "@e2" } })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({ ...comment, element: { observationId: "observation-3" } })
      )
    ).toBe(true);
  }
});

test("a recorded native comment keeps its element beside the target", () => {
  const decode = Schema.decodeUnknownResult(TeachingEvent);
  const event = {
    _tag: "instruction",
    at: "2026-11-18T00:00:00.000Z",
    element: {
      bounds: { height: 96, width: 320, x: 40, y: 600 },
      context: ["dev.fixture"],
      editable: false,
      name: "Edit",
      observationId: "observation-3",
      platform: "android",
      role: "button",
    },
    seq: 4,
    target: 'button "Edit"',
    text: "Edit opens the profile.",
  };
  expect(decode(event)).toMatchObject({ success: event });
  // Older recordings, and web comments, carry no element.
  const { element: _element, ...web } = event;
  expect(Result.isSuccess(decode(web))).toBe(true);
  expect(
    Result.isFailure(
      decode({ ...event, element: { ...event.element, platform: "web" } })
    )
  ).toBe(true);
});
