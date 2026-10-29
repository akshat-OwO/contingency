/**
 * The prototype reads sessions through the shipped dock presentation (#487);
 * the semantic-control list below is prototype-only.
 */
import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";

export {
  androidDockPresentation,
  androidSessionLabel,
  androidSkillsSessionView,
  isLiveAndroidSession,
} from "@/components/agent/android-dock-state";
export type {
  AndroidDockAction,
  AndroidDockGesture,
  AndroidDockPresentation,
} from "@/components/agent/android-dock-state";

/**
 * The semantic elements a user can act on. Password and covered nodes are
 * never offered. Untaught controls are allowed.
 */
export const actionableNodes = (
  session: AndroidWorkspaceSnapshot
): NonNullable<AndroidWorkspaceSnapshot["observation"]>["nodes"] =>
  (session.observation?.nodes ?? []).filter(
    (node) => !node.password && !node.covered
  );
