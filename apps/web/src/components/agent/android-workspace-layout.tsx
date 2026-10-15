import { useAtom } from "@effect/atom-react";
import { useEffect } from "react";

import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-sidebar";
import { SkillDetails } from "@/components/catalog/skill-details";
import { SkillsDrawer } from "@/components/catalog/skills-drawer";
import {
  showsSkillsEntry,
  skillsDrawerOpenAtom,
  skillsSelectionAtom,
} from "@/components/catalog/skills-drawer-state";
import type { SkillsSessionView } from "@/components/catalog/skills-drawer-state";

/**
 * The Workspace between the Skills drawer on its left and, on its right,
 * either what the drawer picked or an ended Run's Summary. Details the user
 * opened take the right panel while they are open; closing them brings the
 * Run Summary back. Browser and Android sessions share it, so the drawer and
 * the summary sit in the same places on both platforms.
 */
export const WorkspaceLayout = ({
  children,
  sessionId,
  skillsSession,
  summary,
}: {
  readonly children: React.ReactNode;
  readonly sessionId: string | undefined;
  readonly skillsSession: SkillsSessionView | undefined;
  readonly summary:
    | { readonly label: string; readonly summary: React.ReactNode }
    | null
    | undefined;
}) => {
  const [open, setOpen] = useAtom(skillsDrawerOpenAtom);
  const [selection, setSelection] = useAtom(skillsSelectionAtom);
  // Details belong to what the user was looking at; another session starts
  // with the drawer open on its own skill instead.
  useEffect(() => {
    setSelection(null);
  }, [sessionId, setSelection]);
  const allowed = showsSkillsEntry(skillsSession);
  // Capture closes the drawer rather than hiding it, so Stop does not bring
  // it back over the page the user just proved.
  useEffect(() => {
    if (!allowed) {
      setOpen(false);
      setSelection(null);
    }
  }, [allowed, setOpen, setSelection]);
  const drawerOpen = open && allowed;
  const details = drawerOpen && selection !== null ? selection : null;
  return (
    <WorkspaceWithRunSummary
      label={details === null ? (summary?.label ?? "Run Summary") : "Details"}
      leading={
        drawerOpen
          ? {
              content: (
                <SkillsDrawer
                  key={sessionId ?? "none"}
                  session={skillsSession}
                />
              ),
              label: "Skills",
              onClose: () => {
                setOpen(false);
                setSelection(null);
              },
            }
          : null
      }
      onCloseSummary={
        details === null
          ? undefined
          : () => {
              setSelection(null);
            }
      }
      summary={
        details === null ? (
          (summary?.summary ?? null)
        ) : (
          <SkillDetails selection={details} />
        )
      }
    >
      {children}
    </WorkspaceWithRunSummary>
  );
};
