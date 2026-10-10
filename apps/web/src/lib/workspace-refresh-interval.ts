import { Clock, Effect } from "effect";
import type { Duration } from "effect";
import { createContext, useContext } from "react";

export const WorkspaceRefreshIntervalContext =
  createContext<Duration.Input>("2 seconds");

export const useWorkspaceRefreshInterval = () =>
  useContext(WorkspaceRefreshIntervalContext);

export const WorkspaceRefreshClockContext = createContext<Clock.Clock>(
  Effect.runSync(Clock.Clock)
);

export const useWorkspaceRefreshClock = () =>
  useContext(WorkspaceRefreshClockContext);
