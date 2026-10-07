import type {
  TeachingBrowserAttachment,
  TeachingScan,
  AgentInspectedElement,
} from "@contingency/protocol";

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

/**
 * Commenting while recording. The composer is the one place a comment is
 * written; inspect only picks the element it attaches to. A comment with no
 * element is a page comment, which the protocol records with a `null` target.
 */
export interface InspectState {
  /** The element the pointer is over, in Page viewport coordinates. */
  readonly hovered: AgentInspectedElement | undefined;
  /** The element attached to the comment being written, if any. */
  readonly frozen: InspectSelection | undefined;
  readonly comments: readonly InspectComment[];
  /** Numbering continues when navigation removes the previous Page's pins. */
  readonly nextCommentIndex: number;
  readonly editingInstructionId?: string | undefined;
  readonly attachments?: readonly TeachingBrowserAttachment[] | undefined;
  readonly scan?: TeachingScan | undefined;
  readonly scanMenu?: boolean | undefined;
  readonly draft: string;
  readonly error: string | undefined;
  /** Whether the composer is open. */
  readonly composing: boolean;
  /** The pin whose comment the user is pointing at in the composer's list. */
  readonly highlighted: number | undefined;
  /** Whether inspect is picking an element. */
  readonly open: boolean;
  /** Whether cancelling a pick goes back to the composer it was started from. */
  readonly returnsToComposer: boolean;
}

export const emptyInspectState: InspectState = {
  comments: [],
  composing: false,
  draft: "",
  error: undefined,
  frozen: undefined,
  highlighted: undefined,
  hovered: undefined,
  nextCommentIndex: 1,
  open: false,
  returnsToComposer: false,
  scan: undefined,
  scanMenu: false,
};

export const openComposer = (state: InspectState): InspectState => ({
  ...state,
  composing: true,
  hovered: undefined,
  open: false,
  returnsToComposer: false,
});

/** The draft and the attached element survive closing, so nothing is lost. */
export const closeComposer = (state: InspectState): InspectState => ({
  ...state,
  composing: false,
  error: undefined,
  highlighted: undefined,
});

export const startPicking = (state: InspectState): InspectState => ({
  ...state,
  composing: false,
  error: undefined,
  highlighted: undefined,
  hovered: undefined,
  open: true,
  returnsToComposer: state.composing,
});

export const stopPicking = (state: InspectState): InspectState =>
  state.open
    ? {
        ...state,
        composing: state.returnsToComposer,
        error: undefined,
        hovered: undefined,
        open: false,
        returnsToComposer: false,
      }
    : state;

/** A picked element lands in the composer, which opens to write about it. */
export const attachSelection = (
  state: InspectState,
  selection: InspectSelection
): InspectState => ({
  ...state,
  composing: true,
  error: undefined,
  frozen: selection,
  hovered: undefined,
  open: false,
  returnsToComposer: false,
});

/**
 * A new Page invalidates every element reference and pin taken on the old one.
 * The draft is still the user's words, so it stays.
 */
export const leavePage = (state: InspectState): InspectState => ({
  ...emptyInspectState,
  attachments: state.attachments,
  composing: state.composing,
  draft: state.draft,
  nextCommentIndex: state.nextCommentIndex,
  scan: state.scan,
});

/**
 * A committed instruction consumes its number even if its Page was left. The
 * composer is read-only while the save is in flight, so a draft that still
 * reads as the sent text is the comment that was sent, and it is cleared. Its
 * pin lands only on the Page it was taken on.
 */
export const completeInspectComment = (
  state: InspectState,
  sent: {
    readonly frozen: InspectSelection | undefined;
    readonly text: string;
  },
  index: number,
  samePage: boolean
): InspectState => {
  const nextCommentIndex = Math.max(state.nextCommentIndex, index + 1);
  const { frozen, text } = sent;
  if (state.draft.trim() !== text) {
    return { ...state, nextCommentIndex };
  }
  return {
    ...state,
    attachments: [],
    comments:
      frozen === undefined || !samePage || state.frozen !== frozen
        ? state.comments
        : [
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
    composing: false,
    draft: "",
    editingInstructionId: undefined,
    error: undefined,
    frozen: undefined,
    highlighted: undefined,
    nextCommentIndex,
    scan: undefined,
    scanMenu: false,
  };
};
