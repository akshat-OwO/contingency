import {
  BrowserNetworkRequest,
  TeachingBrowserAttachment,
} from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import {
  attachmentMime,
  requestAttachment,
} from "@/components/agent/browser-check-attachments";
import { BrowserResponseFields } from "@/components/browser/browser-response-fields";

const request = Schema.decodeUnknownSync(BrowserNetworkRequest)({
  headers: {},
  method: "POST",
  requestId: "scalar-request",
  resourceType: "Fetch",
  tabId: "tab-1",
  timestamp: 1,
  url: "https://example.com/result",
});
const decode = Schema.decodeUnknownSync(TeachingBrowserAttachment);
afterEach(cleanup);

const renderFields = (value: Schema.Json) => {
  const attach = vi.fn();
  render(
    <RegistryProvider>
      <BrowserResponseFields
        attach={attach}
        body={JSON.stringify(value)}
        request={request}
      />
    </RegistryProvider>
  );
  return attach;
};

const assertRequirement = (
  attachment: TeachingBrowserAttachment,
  value: Schema.Json,
  itemPath: readonly (string | number)[] = [],
  path: readonly (string | number)[] = []
) => {
  expect(attachment.requirement).toEqual(attachment.candidate);
  expect(attachment.candidate.demonstrated).toBe(true);
  expect(attachment.candidate.expectation).toEqual({
    itemPath,
    predicates: [
      { expected: value, id: expect.any(String), operator: "equals", path },
    ],
  });
};

test.each(["ready", true, 42, null])(
  "click and drag require the typed root scalar %j",
  async (value) => {
    const attach = renderFields(value);
    const button = screen.getByRole("button", { name: "Require Response" });
    await userEvent.setup().click(button);
    const clicked = decode(attach.mock.calls[0]?.[0]);
    assertRequirement(clicked, value);
    const setData = vi.fn();
    const row = button.parentElement;
    if (row === null) {
      throw new Error("Response field row is missing");
    }
    fireEvent.dragStart(row, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(attachmentMime, expect.any(String));
    const dragged = decode(JSON.parse(setData.mock.calls[0]?.[1]));
    expect(dragged).toEqual(clicked);
  }
);

test("nested field selection retains its path", async () => {
  const attach = renderFields({ status: "ready" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Require status" }));
  assertRequirement(decode(attach.mock.calls[0]?.[0]), "ready", [], ["status"]);
});

test("array field selection retains wildcard item grouping", async () => {
  const attach = renderFields([{ status: "ready" }]);
  const user = userEvent.setup();
  await user.click(screen.getByText("0 · object"));
  await user.click(screen.getByRole("button", { name: "Require 0.status" }));
  assertRequirement(
    decode(attach.mock.calls[0]?.[0]),
    "ready",
    ["*"],
    ["status"]
  );
});

test("request paperclip and drag candidate remains undemonstrated context", () => {
  const attachment = decode(requestAttachment(request, { purpose: "context" }));
  expect(attachment.requirement).toBeUndefined();
  expect(attachment.candidate.demonstrated).toBe(false);
  expect(attachment.candidate.expectation).toEqual({
    itemPath: [],
    predicates: [{ id: expect.any(String), operator: "exists", path: [] }],
  });
});
