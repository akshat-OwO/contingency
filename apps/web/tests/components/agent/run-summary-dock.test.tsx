import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import {
  WorkspaceWithRunSummary,
  usePublishRunSummaryVerdict,
} from "@/components/agent/run-summary-dock";
import {
  DockShell,
  DockState,
  DockStatus,
} from "@/components/agent/workspace-dock";

afterEach(cleanup);

const Summary = () => {
  usePublishRunSummaryVerdict({ label: "Not working", tone: "failed" });
  return <p>The cart shows no total.</p>;
};

const Workspace = ({ ended }: { readonly ended: boolean }) => (
  <RegistryProvider>
    <WorkspaceWithRunSummary
      label="Run Summary"
      summary={ended ? <Summary /> : null}
    >
      <main data-vt="stage">
        <DockShell
          status={
            <DockStatus badges={<DockState>Closed</DockState>}>
              The Run has ended.
            </DockStatus>
          }
        >
          <button type="button">Done</button>
        </DockShell>
      </main>
    </WorkspaceWithRunSummary>
  </RegistryProvider>
);

test("docks an ended Run's summary and folds it into the status island", async () => {
  const user = userEvent.setup();
  const { container, rerender } = render(<Workspace ended={false} />);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(container.querySelector("[data-run-summary]")).toBeNull();

  rerender(<Workspace ended />);
  const dock = screen.getByRole("complementary", { name: "Run Summary" });
  expect(
    within(dock).getByRole("heading", { level: 2, name: "Run Summary" })
  ).toBeVisible();
  expect(within(dock).getByText("The cart shows no total.")).toBeVisible();
  // The stage gives up the dock's width rather than sitting under it.
  expect(container.querySelector("[data-run-summary]")).toHaveAttribute(
    "data-run-summary",
    "open"
  );
  const status = screen.getByRole("region", { name: "Session status" });
  expect(
    within(status).queryByRole("button", { name: "Expand Run Summary" })
  ).toBeNull();

  await user.click(
    within(dock).getByRole("button", { name: "Collapse Run Summary" })
  );
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(container.querySelector('[data-run-summary="open"]')).toBeNull();
  // Collapsed, nothing floats over the canvas: the summary is a tool in the
  // status island that keeps its verdict in view.
  const pill = within(status).getByRole("button", {
    name: "Expand Run Summary",
  });
  expect(pill).toHaveAttribute("aria-expanded", "false");
  expect(pill).toHaveTextContent("Not working");

  await user.click(pill);
  expect(
    screen.getByRole("complementary", { name: "Run Summary" })
  ).toBeVisible();
  expect(
    within(status).queryByRole("button", { name: "Expand Run Summary" })
  ).toBeNull();
});

test("opens the next summary even when the last one was folded away", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Workspace ended />);
  await user.click(
    screen.getByRole("button", { name: "Collapse Run Summary" })
  );
  rerender(<Workspace ended={false} />);
  expect(
    screen.queryByRole("button", { name: "Expand Run Summary" })
  ).toBeNull();
  rerender(<Workspace ended />);
  expect(
    screen.getByRole("complementary", { name: "Run Summary" })
  ).toBeVisible();
});
