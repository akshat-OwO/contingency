import type { RecordingSnapshot, SessionId } from "@contingency/protocol";
import { recordingMakesBrowserInputReadOnly } from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

export interface CreateWorkspaceState {
  readonly activeTabId: string | undefined;
  readonly address: string;
  readonly recording: RecordingSnapshot | null;
  readonly selectedSessionId: SessionId | undefined;
}

export const createWorkspaceAtom = Atom.make<CreateWorkspaceState>({
  activeTabId: undefined,
  address: "",
  recording: null,
  selectedSessionId: undefined,
});

export interface RecordingAuthoringUiState {
  /**
   * The condition the armed element pick will produce, so the capture prompt
   * can say which one. Meaningful only while a condition pick is armed.
   */
  readonly conditionKind: "selectorHidden" | "selectorVisible" | undefined;
  readonly busy: boolean;
  readonly confirmDiscard: boolean;
  readonly error: string | undefined;
  readonly titleDraft: string | undefined;
}

export const recordingAuthoringUiAtom = Atom.make<RecordingAuthoringUiState>({
  busy: false,
  conditionKind: undefined,
  confirmDiscard: false,
  error: undefined,
  titleDraft: undefined,
});

export const recordingStreamErrorAtom = Atom.make<string | null>(null);

export const recordingLocksBrowser = (
  recording: RecordingSnapshot | null
): boolean => recording !== null && recording.phase !== "finished";

export const recordingMakesCanvasReadOnly = (
  recording: RecordingSnapshot | null
): boolean => recordingMakesBrowserInputReadOnly(recording);
