import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { UserAgentPicker } from "@/components/browser/user-agent-picker";

afterEach(cleanup);

/**
 * The offered identities by label. Read off the options themselves rather than
 * their accessible names, which Radix composes from the item's own markup.
 */
const offeredLabels = () =>
  screen.getAllByRole("option").map((option) => option.textContent);

const option = (label: string) => {
  const found = screen
    .getAllByRole("option")
    .find((element) => element.textContent === label);
  if (found === undefined) {
    throw new Error(`No identity labelled ${label} is offered.`);
  }
  return found;
};

const openPicker = async () => {
  const onValueChange = vi.fn();
  render(
    <UserAgentPicker
      disabled={false}
      onValueChange={onValueChange}
      value="default"
    />
  );
  await userEvent.click(screen.getByRole("combobox", { name: "User agent" }));
  // The list is portalled and mounts a tick after the click, so the options
  // are awaited rather than assumed present.
  await screen.findAllByRole("option");
  return onValueChange;
};

/**
 * Chromium can wear a Safari or Firefox string but never reproduce those
 * engines, so offering them promises behaviour a Run cannot deliver ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
test("offers no identity Chromium cannot reproduce", async () => {
  await openPicker();

  const labels = offeredLabels();
  expect(labels).not.toContain("Safari — iPhone iOS 13.2");
  expect(labels).not.toContain("Firefox — Windows");
  // Their groups go with them: an empty Safari heading is still an offer.
  expect(screen.queryByText("Safari")).not.toBeInTheDocument();
  expect(screen.queryByText("Firefox")).not.toBeInTheDocument();
});

test("offers the Chromium-family and crawler identities", async () => {
  await openPicker();

  const labels = offeredLabels();
  expect(labels).toContain("Chrome — Android Mobile");
  expect(labels).toContain("Googlebot Smartphone");
  expect(labels).toContain("Microsoft Edge (Chromium) — Windows");
});

test("reports the identity an author chose", async () => {
  const onValueChange = await openPicker();

  await userEvent.click(option("Chrome — Android Mobile"));

  expect(onValueChange).toHaveBeenCalledWith("chrome-android-mobile");
});

test("exposes a compatibility warning for an existing legacy identity", async () => {
  render(
    <UserAgentPicker
      compatibilityWarning="Runs still use Chromium."
      disabled={false}
      onValueChange={vi.fn()}
      value="default"
    />
  );

  await userEvent.hover(
    screen.getByRole("button", {
      name: "Legacy browser identity compatibility warning",
    })
  );

  expect(await screen.findByText("Runs still use Chromium.")).toBeVisible();
});
