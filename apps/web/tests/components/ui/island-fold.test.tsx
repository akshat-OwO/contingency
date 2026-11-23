import { AgentSessionSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  checkServer,
  mount,
  partAttrs,
  partPresent,
  partState,
} from "@ui-sdk/core/testing";
import { Schema } from "effect";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { DockRequests } from "@/components/agent/dock-requests";
import {
  IslandFold,
  IslandFoldCollapseTrigger,
  IslandFoldContent,
  IslandFoldExpandTrigger,
  islandFold,
} from "@/components/ui/island-fold";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

const decodeSnapshot = Schema.decodeUnknownSync(AgentSessionSnapshot);

let previousStrict: boolean | undefined;

beforeAll(() => {
  previousStrict = globalThis.__UI_SDK_STRICT__;
  globalThis.__UI_SDK_STRICT__ = true;
});

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrict;
});

afterEach(cleanup);

const ControlledCancelable = ({
  cancel = false,
}: {
  readonly cancel?: boolean;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button onClick={() => setOpen((value) => !value)} type="button">
        External toggle
      </button>
      <IslandFold
        onOpenChange={(next, details) => {
          if (cancel) {
            details.cancel();
            return;
          }
          setOpen(next);
        }}
        open={open}
      >
        <IslandFoldExpandTrigger>Expand</IslandFoldExpandTrigger>
        <IslandFoldCollapseTrigger>Collapse</IslandFoldCollapseTrigger>
        <IslandFoldContent>Panel body</IslandFoldContent>
      </IslandFold>
    </div>
  );
};

const ControlledProgrammatic = ({ open }: { readonly open: boolean }) => (
  <IslandFold open={open}>
    <IslandFoldExpandTrigger>Expand</IslandFoldExpandTrigger>
    <IslandFoldCollapseTrigger>Collapse</IslandFoldCollapseTrigger>
    <IslandFoldContent>Panel body</IslandFoldContent>
  </IslandFold>
);

test("renders pure attributes and state on the server", () => {
  const openHtml = checkServer(
    islandFold,
    {},
    '<root><expand-trigger as="button">Expand</expand-trigger><collapse-trigger as="button">Collapse</collapse-trigger><content>Body</content></root>'
  );
  expect(openHtml).toContain('data-slot="island-fold"');
  expect(openHtml).toContain("data-open");
  expect(openHtml).toContain('data-slot="island-fold-collapse-trigger"');
  expect(openHtml).toContain('aria-expanded="true"');
  expect(openHtml).toContain("aria-controls=");
  expect(openHtml).toContain('data-slot="island-fold-content"');
  expect(openHtml).not.toContain('data-slot="island-fold-expand-trigger"');

  const foldedHtml = checkServer(
    islandFold,
    { defaultOpen: false },
    '<root><expand-trigger as="button">Expand</expand-trigger><collapse-trigger as="button">Collapse</collapse-trigger><content>Body</content></root>'
  );
  expect(foldedHtml).toContain('data-slot="island-fold-expand-trigger"');
  expect(foldedHtml).toContain('aria-expanded="false"');
  expect(foldedHtml).not.toContain('data-slot="island-fold-collapse-trigger"');
  expect(foldedHtml).not.toContain("aria-controls=");

  const instance = islandFold({});
  try {
    const root = instance.part("root", {});
    expect(partAttrs(root)).toMatchObject({ "data-open": "" });
    expect(partState(root)).toEqual({ open: true });

    const collapseTrigger = instance.part("collapse-trigger", {});
    const content = instance.part("content", {});
    expect(partPresent(collapseTrigger)).toBe(true);
    expect(partAttrs(collapseTrigger)).toMatchObject({
      "aria-controls": partAttrs(content).id,
      "aria-expanded": "true",
      "data-open": "",
      type: "button",
    });

    const expandTrigger = instance.part("expand-trigger", {});
    expect(partPresent(expandTrigger)).toBe(false);
    expect(partAttrs(expandTrigger)).not.toHaveProperty("aria-controls");
  } finally {
    instance.destroy();
  }
});

test("folds and opens by click, Enter, and Space and moves focus to the replacing trigger", async () => {
  const onOpenChange = vi.fn();
  const view = mount(
    islandFold,
    { onOpenChange },
    '<root><expand-trigger as="button">Expand island</expand-trigger><collapse-trigger as="button">Collapse island</collapse-trigger><content>Body</content></root>'
  );
  try {
    const content = view.part("content");
    const collapse0 = view.part("collapse-trigger");
    expect(collapse0).toHaveAttribute("aria-expanded", "true");
    expect(collapse0).toHaveAttribute("aria-controls", content.id);
    expect(
      view.root.querySelector('[data-slot="island-fold-expand-trigger"]')
    ).toBeNull();

    await view.click(collapse0);
    expect(view.state.open).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "collapse-trigger" })
    );
    const expand0 = view.part("expand-trigger");
    expect(expand0).toHaveAttribute("aria-expanded", "false");
    expect(expand0).not.toHaveAttribute("aria-controls");
    expect(
      view.root.querySelector('[data-slot="island-fold-collapse-trigger"]')
    ).toBeNull();
    expect(document.activeElement).toBe(expand0);

    await view.click(expand0);
    expect(view.state.open).toBe(true);
    expect(onOpenChange).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ reason: "expand-trigger" })
    );
    const collapse1 = view.part("collapse-trigger");
    expect(collapse1).toHaveAttribute("aria-expanded", "true");
    expect(collapse1).toHaveAttribute("aria-controls", content.id);
    expect(document.activeElement).toBe(collapse1);

    await view.keys("Enter");
    expect(view.state.open).toBe(false);
    const expand1 = view.part("expand-trigger");
    expect(expand1).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(expand1);

    await view.keys("Enter");
    expect(view.state.open).toBe(true);
    const collapse2 = view.part("collapse-trigger");
    expect(collapse2).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(collapse2);

    await view.keys(" ");
    expect(view.state.open).toBe(false);
    const expand2 = view.part("expand-trigger");
    expect(expand2).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(expand2);

    await view.keys(" ");
    expect(view.state.open).toBe(true);
    const collapse3 = view.part("collapse-trigger");
    expect(collapse3).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(collapse3);
  } finally {
    view.unmount();
  }
});

test("supports controlled open state and canceling a change", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<ControlledCancelable cancel />);

  const collapseBtn = screen.getByRole("button", { name: "Collapse" });
  const content = screen.getByText("Panel body");
  expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
  expect(collapseBtn).toHaveAttribute("aria-controls", content.id);

  await user.click(collapseBtn);
  expect(screen.getByRole("button", { name: "Collapse" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();

  rerender(<ControlledCancelable cancel={false} />);

  const external = screen.getByRole("button", { name: "External toggle" });
  await user.click(external);
  expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(external).toHaveFocus();

  const expandBtn = screen.getByRole("button", { name: "Expand" });
  expandBtn.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Collapse" })).toHaveFocus();

  await user.keyboard(" ");
  expect(screen.getByRole("button", { name: "Expand" })).toHaveFocus();
});

test("moves focus when a programmatic open change hides a focused trigger", () => {
  const { rerender } = render(<ControlledProgrammatic open={false} />);
  const expandBtn = screen.getByRole("button", { name: "Expand" });
  expandBtn.focus();
  expect(expandBtn).toHaveFocus();

  rerender(<ControlledProgrammatic open />);
  expect(screen.getByRole("button", { name: "Collapse" })).toHaveFocus();
});

test("DockRequests moves focus between Collapse requests and Show request", async () => {
  const user = userEvent.setup();
  const at = "2026-11-23T00:00:00.000Z";
  const session = decodeSnapshot({
    activity: "teaching",
    boundary: {
      action: { ref: "e55", type: "click" },
      description: "Submit the return for RH-1042",
      id: "boundary-1",
      operationId: "submit-boundary-1",
      reason: "confirmation",
      requested: "Submit the return for RH-1042",
    },
    captureState: { _tag: "recording", startedAt: at },
    clientName: "Test agent",
    clientVersion: "1.0",
    controller: "agent",
    createdAt: at,
    currentUrl: "https://shop.example.com/",
    dryRun: null,
    flowName: "shop-sign-in",
    id: "agent-focus-test",
    interruptedAction: null,
    ownerProcessId: "mcp-test",
    pendingDecisions: [
      {
        boundaryId: "boundary-1",
        createdAt: at,
        kind: "boundary",
        pendingDecisionId: "pending-boundary-1",
        scopeSummary: "Submit the return for RH-1042",
        sessionId: "agent-focus-test",
        variable: null,
      },
    ],
    phase: "running",
    recordingId: "recording-shop-sign-in",
    run: null,
    takeover: null,
    teaching: { actionCount: 2, instructionCount: 0, instructions: [] },
    timeline: [],
    updatedAt: at,
    viewUrl: "http://127.0.0.1:7777/?session=agent-focus-test",
  });

  const { container } = render(
    <RegistryProvider>
      <DockRequests session={session} />
    </RegistryProvider>
  );

  const collapseBtn = screen.getByRole("button", { name: "Collapse requests" });
  expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
  const controlsId = collapseBtn.getAttribute("aria-controls");
  expect(controlsId).not.toBeNull();
  expect(container.querySelector(`[id="${controlsId ?? ""}"]`)).not.toBeNull();

  await user.click(collapseBtn);
  const expandBtn = screen.getByRole("button", {
    name: "Show request: Allow the agent to take this action? Submit the return for RH-1042",
  });
  expect(expandBtn).toHaveAttribute("aria-expanded", "false");
  expect(expandBtn).not.toHaveAttribute("aria-controls");
  expect(expandBtn).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Collapse requests" })
  ).toHaveFocus();
});
