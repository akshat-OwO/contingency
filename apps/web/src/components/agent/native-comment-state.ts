import type {
  AndroidWorkspaceObservation,
  NativeTeachingInstruction,
  TeachingCaptureState,
} from "@contingency/protocol";

import type { NativeCommentPins, NativeElementPick } from "./android-device";
import { commentPins } from "./screen-elements";
import type { AttachedElement } from "./screen-elements";

/** A native Teaching comment while it is written. */
export interface NativeComment {
  readonly attached: AttachedElement | null;
  /** The earlier comment the card's list points at, outlined on the screen. */
  readonly highlighted: number | null;
  readonly open: boolean;
  readonly picking: boolean;
  /** It was sent and has not answered; it closes once it saves. */
  readonly submitting: boolean;
}
export const closedComment: NativeComment = {
  attached: null,
  highlighted: null,
  open: false,
  picking: false,
  submitting: false,
};

/** The open comment's pick on the device stage. */
export const commentPick = (
  comment: NativeComment,
  setComment: (update: (current: NativeComment) => NativeComment) => void
): NativeElementPick | undefined =>
  comment.open
    ? {
        attached: comment.attached ?? undefined,
        onCancel: () =>
          setComment((current) => ({ ...current, picking: false })),
        onPick: (element) =>
          setComment((current) => ({
            ...current,
            attached: element,
            picking: false,
          })),
        picking: comment.picking,
      }
    : undefined;

/** The recording's comment pins on the current screen, while Teaching records. */
export const recordingPins = (
  session: {
    readonly captureState: TeachingCaptureState | null;
    readonly instructions?: readonly NativeTeachingInstruction[];
    readonly observation: AndroidWorkspaceObservation | null;
  },
  highlighted: number | null
): NativeCommentPins | undefined =>
  session.captureState?._tag === "recording"
    ? {
        highlighted: highlighted ?? undefined,
        pins: commentPins(session.observation, session.instructions ?? []),
      }
    : undefined;
