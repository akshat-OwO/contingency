import { DatabaseIcon, GlobeIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";

import { TeachingRecordingDock } from "@/components/agent/teaching-recording-dock";
import { BrowserDevtools } from "@/components/browser/browser-devtools";
import { RailBadge, RailButton } from "@/components/browser/inspector-rail";

import {
  mockNetworkRequests,
  mockSession,
  mockTabId,
  mockTabUrl,
  mockTooling,
} from "./fixtures";
import type { DevtoolsPanelId, PrototypeState } from "./model";
import { MockBadge } from "./parts";
import { StageContext } from "./stage-context";

/** The dock's clock starts 1:42 into the recording when the page loads. */
const recordingState = {
  _tag: "recording",
  startedAt: new Date(Date.now() - 102_000).toISOString(),
} as const;

const noop = () => {
  // The prototype has no live session to drive.
};

/**
 * The Teaching Workspace around each prototype: the real dock, the real
 * inspector rail, and the real devtools panel, fed with mocked data. Only the
 * page in the stage is a stand-in.
 */
export const PrototypeWorkspace = ({
  children,
  devtools,
  rail,
  state,
  update,
}: {
  readonly children: ReactNode;
  /** Replaces the production devtools with a prototype panel. */
  readonly devtools?: ReactNode;
  /** Extra rail buttons a direction adds below the devtools. */
  readonly rail?: ReactNode;
  readonly state: PrototypeState;
  readonly update: (
    change: (current: PrototypeState) => PrototypeState
  ) => void;
}) => {
  const stage = useRef<HTMLElement>(null);
  const togglePanel = (panel: DevtoolsPanelId) =>
    update((current) => ({
      ...current,
      devtools: current.devtools === panel ? undefined : panel,
    }));
  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1">
        <section
          aria-label="Browser stage"
          className="bg-muted/40 relative flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
          ref={stage}
        >
          <div className="grid min-h-0 flex-1 place-items-center p-6 pb-24">
            <div
              aria-label="Mock page"
              className="bg-background flex w-full max-w-md flex-col gap-4 rounded-xl p-6 shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              role="img"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {mockTabUrl}
                </span>
                <MockBadge />
              </span>
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Order received
              </span>
              <span className="text-xl font-semibold tracking-tight">
                Thanks, your order is on its way.
              </span>
              <span className="bg-muted h-3 w-3/4 rounded" />
              <span className="bg-muted h-3 w-1/2 rounded" />
            </div>
          </div>
          <StageContext value={stage}>{children}</StageContext>
          <TeachingRecordingDock
            browserFocused={false}
            captureState={recordingState}
            cleanup={undefined}
            controller="user"
            flowSkillName="checkout"
            instructions={state.conditions.map((condition) => ({
              at: "2026-10-04T11:01:38.000Z",
              id: condition.id,
              target: null,
              text: condition.note === "" ? "Check" : condition.note,
            }))}
            onComment={() =>
              update((current) => ({ ...current, composing: true }))
            }
            onGesture={noop}
            onSecondary={noop}
            onSelectSession={noop}
            pending={false}
            phase="running"
            platform="mac"
            selectedSessionId={mockSession.id}
            sessions={[mockSession]}
          />
        </section>
        {state.devtools !== undefined && devtools !== undefined ? (
          <div className="flex w-[24rem] min-w-0 shrink-0 flex-col border-l">
            {devtools}
          </div>
        ) : null}
        {state.devtools === undefined ||
        state.devtools === "checks" ||
        devtools !== undefined ? null : (
          <div className="flex w-[22rem] min-w-0 shrink-0 flex-col border-l">
            <BrowserDevtools
              consoleEntries={[]}
              dockSide="right"
              mutationsLocked
              networkRequests={mockNetworkRequests}
              onClearConsole={noop}
              onClearNetwork={noop}
              onClose={() =>
                update((current) => ({ ...current, devtools: undefined }))
              }
              onError={noop}
              onRefreshNetwork={noop}
              onToggleDockSide={noop}
              panel={state.devtools}
              refreshingNetwork={false}
              tabId={mockTabId}
              tabTitle="Order received (mock)"
              tabUrl={mockTabUrl}
              tooling={mockTooling}
            />
          </div>
        )}
      </div>
      <nav
        aria-label="Browser tools"
        className="bg-background flex w-12 shrink-0 flex-col items-center gap-1 border-l py-2"
      >
        <RailButton
          active={state.devtools === "console"}
          icon={<TerminalIcon />}
          label="Console"
          onClick={() => togglePanel("console")}
        />
        <RailButton
          active={state.devtools === "network"}
          badge={
            <RailBadge tone="neutral">{mockNetworkRequests.length}</RailBadge>
          }
          description={`${mockNetworkRequests.length} requests`}
          icon={<GlobeIcon />}
          label="Network"
          onClick={() => togglePanel("network")}
        />
        <RailButton
          active={state.devtools === "storage"}
          icon={<DatabaseIcon />}
          label="Storage"
          onClick={() => togglePanel("storage")}
        />
        {rail}
      </nav>
    </div>
  );
};
