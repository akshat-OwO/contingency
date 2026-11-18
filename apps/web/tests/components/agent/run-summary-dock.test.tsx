import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

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

const Workspace = ({
  ended,
  run = "run-1",
}: {
  readonly ended: boolean;
  readonly run?: string;
}) => (
  <RegistryProvider>
    <WorkspaceWithRunSummary
      label="Run Summary"
      summary={ended ? <Summary /> : null}
      summaryKey={run}
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

test("fills its container even when the parent is not a flex column", () => {
  // jsdom computes no layout, so this pins the structure that gives the stage
  // a height under a block parent (the iOS Workspace, #740): the wrapper is
  // as tall as its container, and the stage flexes inside it. Real geometry
  // is proven by the iOS Workspace device proof.
  const { container } = render(
    <div className="h-svh">
      <Workspace ended={false} />
    </div>
  );
  const stage = container.querySelector('[data-vt="stage"]');
  const wrapper = stage?.parentElement;
  expect(wrapper).toHaveClass("h-full", "flex", "flex-col");
  expect(wrapper?.parentElement).toBe(container.firstElementChild);
});

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
    within(status).queryByRole("button", { name: /^Expand Run Summary/u })
  ).toBeNull();

  await user.click(
    within(dock).getByRole("button", { name: "Collapse Run Summary" })
  );
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(container.querySelector('[data-run-summary="open"]')).toBeNull();
  // Collapsed, nothing floats over the canvas: the summary is a tool in the
  // status island that keeps its verdict in view.
  // Its name keeps the visible verdict, and focus moves to it.
  const pill = within(status).getByRole("button", {
    name: "Expand Run Summary: Summary Not working",
  });
  expect(pill).toHaveAttribute("aria-expanded", "false");
  expect(pill).toHaveTextContent("Not working");
  expect(pill).toHaveFocus();

  await user.click(pill);
  const reopened = screen.getByRole("complementary", { name: "Run Summary" });
  expect(reopened).toBeVisible();
  expect(
    within(reopened).getByRole("button", { name: "Collapse Run Summary" })
  ).toHaveFocus();
  expect(
    within(status).queryByRole("button", { name: /^Expand Run Summary/u })
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
    screen.queryByRole("button", { name: /^Expand Run Summary/u })
  ).toBeNull();
  rerender(<Workspace ended />);
  expect(
    screen.getByRole("complementary", { name: "Run Summary" })
  ).toBeVisible();
});

test("opens the next session's summary when one ended session follows another", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Workspace ended run="run-1" />);
  await user.click(
    screen.getByRole("button", { name: "Collapse Run Summary" })
  );
  rerender(<Workspace ended run="run-2" />);
  expect(
    screen.getByRole("complementary", { name: "Run Summary" })
  ).toBeVisible();
});

test("takes the covered stage out of reach while the dock covers a phone", async () => {
  const user = userEvent.setup();
  // A phone-width viewport: the dock's narrow query matches.
  vi.stubGlobal("matchMedia", (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query === "(width < 48rem)",
      media: query,
    })
  );
  try {
    render(<Workspace ended />);
    const status = screen.getByRole("region", { name: "Session status" });
    expect(status.closest("[inert]")).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Collapse Run Summary" })
    );
    expect(status.closest("[inert]")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
