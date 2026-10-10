import { Clock, Effect } from "effect";
import { createContext, useContext } from "react";

/**
 * How often the Workspace re-reads what it cannot be pushed: the session list,
 * the browser's tabs, and the network requests they have made.
 */
export const WORKSPACE_REFRESH_INTERVAL = "2 seconds";

/** The Clock that paces Workspace refreshes; tests provide a TestClock. */
export const WorkspaceRefreshClockContext = createContext<Clock.Clock>(
  Effect.runSync(Clock.Clock)
);

export const useWorkspaceRefreshClock = () =>
  useContext(WorkspaceRefreshClockContext);
