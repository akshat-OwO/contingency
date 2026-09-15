import type { AgentInspectedElement } from "@contingency/protocol";

/** One attached comment, pinned where the user put it on the live Page. */
export interface InspectComment {
  readonly description: string;
  readonly height: number;
  readonly index: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InspectState {
  /** The element the pointer is over, in Page viewport coordinates. */
  readonly hovered: AgentInspectedElement | undefined;
  /** The element a click froze, and the comment being written about it. */
  readonly frozen: AgentInspectedElement | undefined;
  readonly comments: readonly InspectComment[];
  readonly draft: string;
  readonly error: string | undefined;
  readonly open: boolean;
  readonly pending: boolean;
}

export const emptyInspectState: InspectState = {
  comments: [],
  draft: "",
  error: undefined,
  frozen: undefined,
  hovered: undefined,
  open: false,
  pending: false,
};
