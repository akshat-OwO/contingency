import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { UserAgentList } from "@/components/browser/user-agent-list";

afterEach(cleanup);

const offeredLabels = () =>
  screen.getAllByRole("option").map((option) => option.textContent);

const renderList = () => {
  const onValueChange = vi.fn();
  render(
    <UserAgentList
      disabled={false}
      onValueChange={onValueChange}
      value="default"
    />
  );
  return onValueChange;
};

/**
 * Chromium can wear a Safari or Firefox string but never reproduce those
 * engines, so offering them promises behaviour a Run cannot deliver ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
test("offers no identity Chromium cannot reproduce", () => {
  renderList();

  const labels = offeredLabels();
  expect(labels).not.toContain("Safari — iPhone iOS 13.2");
  expect(labels).not.toContain("Firefox — Windows");
  // Their groups go with them: an empty Safari heading is still an offer.
  expect(screen.queryByText("Safari")).not.toBeInTheDocument();
  expect(screen.queryByText("Firefox")).not.toBeInTheDocument();
});

test("offers the Chromium-family and crawler identities", () => {
  renderList();

  const labels = offeredLabels();
  expect(labels).toContain("Chrome — Android Mobile");
  expect(labels).toContain("Googlebot Smartphone");
  expect(labels).toContain("Microsoft Edge (Chromium) — Windows");
});

test("reports the identity an author chose", async () => {
  const onValueChange = renderList();

  await userEvent.click(
    screen.getByRole("option", { name: "Chrome — Android Mobile" })
  );

  expect(onValueChange).toHaveBeenCalledWith("chrome-android-mobile");
});

test("marks the identity the browser presents", () => {
  renderList();

  expect(
    screen.getByRole("option", { name: "Browser default" })
  ).toHaveAttribute("aria-selected", "true");
});

test("moves focus with the arrows and applies an identity only on Enter", async () => {
  const onValueChange = renderList();
  const user = userEvent.setup();

  await user.tab();
  expect(screen.getByRole("option", { name: "Browser default" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(onValueChange).not.toHaveBeenCalled();
  const focused = globalThis.document.activeElement;
  expect(focused).toHaveAttribute("role", "option");
  await user.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});
