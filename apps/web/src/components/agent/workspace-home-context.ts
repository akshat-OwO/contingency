import { createContext, useContext } from "react";

/**
 * The way back to the Workspace home from any view. The route provides it;
 * the browser Workspace refines it so the session it leaves morphs back into
 * its card. Without a provider the links fall back to a plain `/`.
 */
export interface WorkspaceHome {
  readonly goHome: () => void;
}

export const WorkspaceHomeContext = createContext<WorkspaceHome | null>(null);

export const useWorkspaceHome = (): WorkspaceHome | null =>
  useContext(WorkspaceHomeContext);
