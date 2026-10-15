/**
 * The prototype reads sessions through the shipped dock presentation (#487);
 * only the declared-tap filter below is prototype-only.
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
 * never offered, and a non-editable node is offered only when the session
 * declared it reversible.
 */
export const actionableNodes = (
  session: AndroidWorkspaceSnapshot
): NonNullable<AndroidWorkspaceSnapshot["observation"]>["nodes"] => {
  const declared =
    session.requirements.platform === "android"
      ? (session.requirements.reversibleActions ?? [])
      : [];
  return (session.observation?.nodes ?? []).filter(
    (node) =>
      !node.password &&
      !node.covered &&
      (node.editable ||
        declared.some(
          (allowed) => allowed.role === node.role && allowed.name === node.name
        ))
  );
};
