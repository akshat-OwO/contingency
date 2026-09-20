import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";

/**
 * The pieces every Workspace dock is made of. Teaching, a Dry Run, an
 * Interactive Run, and the empty canvas all render the same floating card over
 * the same full-bleed browser, so the shell lives here rather than inside the
 * activity that happened to need it first (#209).
 */

export const Wordmark = () => (
  <span className="shrink-0 text-base font-semibold tracking-tight">
    Contingency
  </span>
);

/**
 * The session picker inside the dock. Every option is the Flow Skill name and
 * what the session is doing with it; a raw session id is never a label a
 * person can act on (#191).
 */
export const DockSessionSelect = ({
  onSelect,
  selectedSessionId,
  sessions,
}: {
  readonly onSelect: (sessionId: string) => void;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
}) => (
  <select
    aria-label="Agent Session"
    className="bg-background focus-visible:ring-ring h-8 max-w-[12rem] min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
    onChange={(event) => onSelect(event.target.value)}
    value={selectedSessionId ?? ""}
  >
    {sessions.map((session) => (
      <option key={session.id} value={session.id}>
        {agentSessionLabel(session)}
      </option>
    ))}
  </select>
);

/**
 * The dock shell: one floating card over a full-bleed browser, with no header
 * band and no footer. Every Workspace state that owns the whole viewport
 * renders through this, so `no session`, a live Teaching session, and a live
 * Run share one layout instead of three (#185 prototype, #209).
 *
 * It wraps rather than scrolls, so a narrow viewport stacks the sentence under
 * the controls and the primary action stays on screen at 390px.
 */
export const DockShell = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
    <section
      aria-label="Workspace dock"
      className="bg-background pointer-events-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 shadow-lg"
    >
      {children}
    </section>
  </div>
);

/**
 * What the dock has to say above the browser rather than inside the card: a
 * refused gesture, a capture failure, a paused Execution Boundary. The dock is
 * one line of controls, and none of these fit in it without pushing the
 * primary action off a narrow screen.
 */
export const DockNotices = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
    <div className="pointer-events-auto max-h-[60svh] w-full max-w-5xl space-y-2 overflow-y-auto">
      {children}
    </div>
  </div>
);

/**
 * The dock's own status sentence. One polite region, changed only when the
 * state changes. Below `lg` it takes its own line, and below `sm` it is
 * hidden: the badge and the buttons already carry the state and the next step,
 * so it is never ellipsized.
 */
export const DockStatus = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <output
    aria-live="polite"
    className="text-muted-foreground order-last hidden w-full text-xs sm:block lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
  >
    {children}
  </output>
);
