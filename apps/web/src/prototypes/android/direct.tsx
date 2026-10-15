import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CircleIcon,
  MessageSquareTextIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import {
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { SkillsDockButton } from "@/components/catalog/skills-dock-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { Device } from "./device";
import { AGENT_TARGET } from "./fixtures";
import type { PrototypeState } from "./fixtures";
import { WorkspaceLayout } from "./layout";
import { Permission, PrototypeSummary, StateBadges } from "./parts";
import {
  androidDockPresentation,
  androidSkillsSessionView,
  isLiveAndroidSession,
} from "./presentation";
import {
  decide,
  deviceInput,
  mutation,
  performGesture,
  startWithSelection,
  usePrototypeSession,
} from "./session";
import { SetupSheet } from "./setup-sheet";

/**
 * Prototype D: the shipped design with the device done properly. The dock,
 * session picker, requests, and Run Summary are the shipped ones; the mirror
 * is a real device frame with its keys beside it, and the screen itself is
 * what the person taps. Setup stays where it ships today.
 */
export const DirectPrototype = ({
  state,
}: {
  readonly state: PrototypeState;
}) => {
  const [session, dispatch] = usePrototypeSession(state);
  const [sheetAtom] = useState(() => Atom.make(state === "select"));
  const [sheetOpen, setSheetOpen] = useAtom(sheetAtom);
  if (session === null) {
    return (
      <main className="bg-muted/20 relative grid h-svh place-items-center">
        <section className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            No browser session
          </h1>
          <p className="text-muted-foreground text-sm">
            Open a session to set the browser or a device up, then start
            recording when the journey begins.
          </p>
          <div className="flex justify-center gap-2">
            <Button>Open browser session</Button>
            <Button onClick={() => setSheetOpen(true)} variant="outline">
              <SmartphoneIcon />
              Open Android session
              <Badge variant="secondary">Experimental</Badge>
            </Button>
          </div>
        </section>
        <SetupSheet
          onOpen={(selection) => {
            setSheetOpen(false);
            startWithSelection(dispatch, selection);
          }}
          onOpenChange={setSheetOpen}
          open={sheetOpen}
        />
      </main>
    );
  }
  const presentation = androidDockPresentation(session);
  const gesture = presentation.action?.gesture;
  const canAct = session.controller === "user" && session.phase === "running";
  const live = isLiveAndroidSession(session);
  return (
    <div className="relative flex h-svh min-h-0 flex-col">
      <WorkspaceLayout
        sessionId={session.id}
        skillsSession={androidSkillsSessionView(session)}
        summary={
          live
            ? null
            : {
                label: "Run Summary",
                summary: <PrototypeSummary session={session} />,
              }
        }
      >
        <main className="bg-muted/30 relative flex min-h-0 flex-1 justify-center px-6 pt-6 pb-32">
          <Device
            agentTarget={
              session.controller === "agent" && session.phase === "running"
                ? AGENT_TARGET
                : undefined
            }
            canAct={canAct}
            dimmed={session.phase === "paused"}
            onInput={(action) => deviceInput(session, dispatch, action)}
            overlay={
              session.phase === "paused" ? (
                <div className="absolute inset-0 grid place-items-center p-6 text-center">
                  <div className="bg-background/95 space-y-1 rounded-2xl border p-4 shadow-lg">
                    <UnplugIcon className="mx-auto size-6 text-amber-600" />
                    <p className="text-sm font-medium">Emulator disconnected</p>
                    <p className="text-muted-foreground text-xs">
                      Recover the same emulator from the dock.
                    </p>
                  </div>
                </div>
              ) : null
            }
            session={session}
          />
          <DockShell
            requests={
              <Permission
                onDecide={(decisionId, allow) =>
                  decide(session, dispatch, decisionId, allow)
                }
                session={session}
              />
            }
            status={
              <DockStatus badges={<StateBadges session={session} />}>
                {presentation.nextStep}
              </DockStatus>
            }
          >
            <DockWordmark />
            <Button className="max-w-56" size="sm" variant="outline">
              <span className="truncate">{session.flowSkillName}</span>
            </Button>
            <SkillsDockButton />
            <DockSpacer />
            {presentation.showsComment ? (
              <Button aria-label="Comment" size="sm" variant="ghost">
                <MessageSquareTextIcon />
                Comment
              </Button>
            ) : null}
            {presentation.rejectable ? (
              <Button
                onClick={() =>
                  dispatch({
                    _tag: "flow-decision",
                    ...mutation(session),
                    decision: "reject",
                  })
                }
                size="sm"
                variant="outline"
              >
                Reject flow
              </Button>
            ) : null}
            {live ? (
              <Button
                onClick={() =>
                  dispatch({ _tag: "close", ...mutation(session) })
                }
                size="sm"
                variant="outline"
              >
                Close session
              </Button>
            ) : null}
            {presentation.action === null || gesture === undefined ? null : (
              <Button
                onClick={() => performGesture(gesture, session, dispatch)}
                variant={
                  gesture === "stop-recording" ? "destructive" : "default"
                }
              >
                {gesture === "start-recording" ? (
                  <CircleIcon className="fill-current" />
                ) : null}
                {gesture === "stop-recording" ? (
                  <SquareIcon className="fill-current" />
                ) : null}
                {presentation.action.label}
              </Button>
            )}
          </DockShell>
        </main>
      </WorkspaceLayout>
    </div>
  );
};
