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

/** Scroll position of the frame on which the user selected the element. */
export interface InspectSelection extends AgentInspectedElement {
  readonly scrollOffsetX: number;
  readonly scrollOffsetY: number;
}

/**
 * How the streamed frame maps the Page viewport onto the canvas bitmap. Both
 * come from the screencast frame's own metadata, so the overlay draws over the
 * frame the Page actually sent rather than over an assumed 1:1 viewport.
 */
export interface FrameProjection {
  /** How far below the top of the Page viewport the frame's top pixel sits. */
  readonly offsetTop: number;
  /** The Page's visual zoom: 1 unless a device emulates a pinch. */
  readonly pageScaleFactor: number;
  readonly scrollOffsetX: number;
  readonly scrollOffsetY: number;
}

export const flatFrameProjection: FrameProjection = {
  offsetTop: 0,
  pageScaleFactor: 1,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

export interface InspectState {
  /** The element the pointer is over, in Page viewport coordinates. */
  readonly hovered: AgentInspectedElement | undefined;
  /** The element a click froze, and the comment being written about it. */
  readonly frozen: InspectSelection | undefined;
  readonly comments: readonly InspectComment[];
  /** Numbering continues when navigation removes the previous Page's pins. */
  readonly nextCommentIndex: number;
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
  nextCommentIndex: 1,
  open: false,
  pending: false,
};

/** A committed instruction consumes its number even if its Page was left. */
export const completeInspectComment = (
  state: InspectState,
  frozen: InspectSelection,
  index: number,
  samePage: boolean
): InspectState => {
  const nextCommentIndex = Math.max(state.nextCommentIndex, index + 1);
  if (!samePage || state.frozen !== frozen) {
    return { ...state, nextCommentIndex, pending: false };
  }
  return {
    ...emptyInspectState,
    comments: [
      ...state.comments,
      {
        description: frozen.description,
        height: frozen.height,
        index,
        width: frozen.width,
        x: frozen.x + frozen.scrollOffsetX,
        y: frozen.y + frozen.scrollOffsetY,
      },
    ],
    nextCommentIndex,
  };
};
