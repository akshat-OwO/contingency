import type { TeachingBrowserAttachment } from "@contingency/protocol";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
      onClose={() => {}}
      onRemove={() => {}}
    />
  );
};

/** Picks an option from one of the card's Selects, as a pointer would. */
const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string
) => {
  const trigger = screen.getByRole("combobox", { name });
  await user.click(trigger);
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
  await user.click(screen.getByRole("option", { name: option }));
  await waitFor(() =>
    expect(trigger).toHaveAttribute("aria-expanded", "false")
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
  expect(screen.getByRole("region", { name: "local · order" })).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Storage format" })
  ).toHaveTextContent("Raw string");
  expect(screen.queryByRole("textbox", { name: "Array item path" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Comparison 1" }));
  const comparisons = await screen.findAllByRole("option");
  expect(comparisons.map((option) => option.textContent)).toEqual([
    "exists",
    "equals",
    "contains",
  ]);
  await user.keyboard("{Escape}");

  await choose(user, "Storage format", "JSON");
  expect(changes.at(-1)?.requirement).toMatchObject({ format: "json" });
  const path = screen.getByRole("textbox", { name: "Field path 1" });
  await user.clear(path);
  await user.type(path, '[["order","status"]');
  await user.tab();
  expect(changes.at(-1)?.requirement?.expectation.predicates[0]?.path).toEqual([
    "order",
    "status",
  ]);

  await choose(user, "Storage format", "Raw string");
  const raw = changes.at(-1)?.requirement;
  expect(raw).toMatchObject({ format: "raw" });
  expect(raw?.expectation.itemPath).toEqual([]);
  expect(raw?.expectation.predicates[0]?.path).toEqual([]);
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
});

test("switching JSON to raw keeps typed expectations visible as strings", async () => {
  const user = userEvent.setup();
  const changes: TeachingBrowserAttachment[] = [];
  render(
    <Editor
      initial={required(
        storageAttachment("http://example.test", "order", "session")
      )}
      changes={changes}
    />
  );
  await choose(user, "Storage format", "JSON");
  await choose(user, "Comparison 1", "gt");
  const expected = screen.getByRole("textbox", { name: "Expected value 1" });
  await user.clear(expected);
  await user.type(expected, "42");
  await user.tab();
  expect(changes.at(-1)?.requirement?.expectation.predicates[0]?.expected).toBe(
    42
  );

  await choose(user, "Storage format", "Raw string");
  const raw = changes.at(-1)?.requirement?.expectation.predicates[0];
  expect(raw).toMatchObject({ expected: "42", operator: "equals" });
  expect(
    screen.getByRole("textbox", { name: "Expected value 1" })
  ).toHaveProperty("value", '"42"');
  expect(
    screen.getByRole("combobox", { name: "Comparison 1" })
  ).toHaveTextContent("equals");
});

test("cookies have no storage format control", () => {
  const initial = required(
    storageAttachment("http://example.test", "checkout", "cookie", "/")
  );
  expect(initial.candidate).not.toHaveProperty("format", "raw");
  render(<Editor initial={initial} changes={[]} />);
  expect(screen.queryByRole("combobox", { name: "Storage format" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Field path 1" })).toBeNull();
});

test("Purpose switches between context and a check that must happen", async () => {
  const user = userEvent.setup();
  const changes: TeachingBrowserAttachment[] = [];
  render(
    <Editor
      initial={storageAttachment("http://example.test", "order", "local")}
      changes={changes}
    />
  );
  const purpose = screen.getByRole("radiogroup", {
    name: "Purpose for local · order",
  });
  expect(screen.queryByRole("textbox", { name: "Check timing" })).toBeNull();
  await user.click(within(purpose).getByRole("radio", { name: "Must happen" }));
  expect(changes.at(-1)?.requirement).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Check timing" })).toBeVisible();
  await user.click(
    within(purpose).getByRole("radio", { name: "Context for the agent" })
  );
  expect(changes.at(-1)).not.toHaveProperty("requirement");
});
