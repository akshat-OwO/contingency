import { expect, it } from "@effect/vitest";

import { recordingViewUrl } from "../../src/services/recording-view.ts";

it("formats a recording selector without a session selector", () => {
  expect(recordingViewUrl("http://127.0.0.1:7777/", "recording-closed")).toBe(
    "http://127.0.0.1:7777/?recording=recording-closed"
  );
});
it("uses the supplied Workspace origin and port", () => {
  expect(recordingViewUrl("http://127.0.0.1:8888/", "recording-resumed")).toBe(
    "http://127.0.0.1:8888/?recording=recording-resumed"
  );
});
