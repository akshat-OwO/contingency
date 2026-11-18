import type { AgentSessionId } from "@contingency/protocol";
import { Atom } from "effect/reactivity";

import { emptyNativeStreamStats } from "./native-stream-status";
import type {
  NativeStreamState,
  NativeStreamStats,
} from "./native-stream-status";

/** Each Android session's stream state, which Stream diagnostics reads. */
export const androidStreamStateAtom = Atom.family(
  (_sessionId: AgentSessionId) => Atom.make<NativeStreamState>("connecting")
);
/** Bumped to start a fresh connection, as Reconnect device stream does. */
export const androidStreamRetryAtom = Atom.family(
  (_sessionId: AgentSessionId) => Atom.make(0)
);

// The counts change every frame, so they live outside React and the open
// diagnostics card samples them.
const streamStats = new Map<AgentSessionId, NativeStreamStats>();
export const androidStreamStats = (sessionId: AgentSessionId) =>
  streamStats.get(sessionId) ?? emptyNativeStreamStats;
export const countAndroidStream = (
  sessionId: AgentSessionId,
  change: (current: NativeStreamStats) => NativeStreamStats
) => streamStats.set(sessionId, change(androidStreamStats(sessionId)));
