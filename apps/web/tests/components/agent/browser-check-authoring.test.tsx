import type { TeachingBrowserAttachment } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";

import { storageAttachment } from "@/components/agent/browser-check-attachments";
import { BrowserAttachmentEditor } from "@/components/agent/browser-check-authoring";

afterEach(cleanup);

const Editor = ({
  initial,
  changes,
}: {
  readonly initial: TeachingBrowserAttachment;
  readonly changes: TeachingBrowserAttachment[];
}) => {
  const [attachment, setAttachment] = useState(initial);
  return (
    <BrowserAttachmentEditor
      attachment={attachment}
      onChange={(next) => {
        changes.push(next);
        setAttachment(next);
      }}
      onRemove={() => {}}
    />
  );
};

const required = (attachment: TeachingBrowserAttachment) => ({
  ...attachment,
  requirement: attachment.candidate,
});

test("storage format defaults to raw and only JSON exposes field paths", async () => {
  const user = userEvent.setup();
  const changes: TeachingBrowserAttachment[] = [];
  const initial = required(
    storageAttachment("http://example.test", "order", "local")
  );
  expect(initial.candidate).toMatchObject({ format: "raw" });
  render(<Editor initial={initial} changes={changes} />);
  await user.click(screen.getByText(/local · order/u));
  const format = screen.getByRole("combobox", { name: "Storage format" });
  expect(format).toHaveProperty("value", "raw");
  expect(screen.queryByRole("textbox", { name: "Array item path" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
  expect(
    screen
      .getAllByRole("option")
      .map((option) => option.textContent)
      .filter((label) => label === "gt")
  ).toEqual([]);

  await user.selectOptions(format, "json");
  expect(changes.at(-1)?.requirement).toMatchObject({ format: "json" });
  const path = screen.getByRole("textbox", { name: "Field path 1" });
  await user.clear(path);
  await user.type(path, '[["order","status"]');
  await user.tab();
  expect(changes.at(-1)?.requirement?.expectation.predicates[0]?.path).toEqual([
    "order",
    "status",
  ]);

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Storage format" }),
    "raw"
  );
  const raw = changes.at(-1)?.requirement;
  expect(raw).toMatchObject({ format: "raw" });
  expect(raw?.expectation.itemPath).toEqual([]);
  expect(raw?.expectation.predicates[0]?.path).toEqual([]);
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
});

test("cookies have no storage format control", async () => {
  const user = userEvent.setup();
  const initial = required(
    storageAttachment("http://example.test", "checkout", "cookie", "/")
  );
  expect(initial.candidate).not.toHaveProperty("format", "raw");
  render(<Editor initial={initial} changes={[]} />);
  await user.click(screen.getByText(/cookie · checkout/u));
  expect(screen.queryByRole("combobox", { name: "Storage format" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
});
