import type { AgentSessionId } from "@contingency/protocol";
import { Atom } from "effect/reactivity";

export type BrowserStreamTransport = "json" | "binary";

/** Local streams favor lower codec CPU; constrained connections can favor fewer bytes. */
export const browserStreamTransportAtom = Atom.family(
  (_sessionId: AgentSessionId | undefined) =>
    Atom.make<BrowserStreamTransport>("json")
);
