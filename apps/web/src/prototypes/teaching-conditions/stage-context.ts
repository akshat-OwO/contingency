import { createContext, useContext } from "react";
import type { RefObject } from "react";

/**
 * The gallery's stage element. Modal surfaces portal into it so every
 * approach is measured against the same frame, not the whole window.
 */
export const StageContext = createContext<RefObject<HTMLElement | null>>({
  current: null,
});

export const useStage = () => useContext(StageContext);
