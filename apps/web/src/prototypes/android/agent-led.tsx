import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  BotIcon,
  CircleIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import {
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import {
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { Device, DeviceFrame } from "./device";
import { AGENT_TARGET, FIXTURE_SELECTION } from "./fixtures";
import type { PrototypeState } from "./fixtures";
import { WorkspaceLayout } from "./layout";
import {
  ExperimentalBadge,
  Permission,
  PrototypeSummary,
  StateBadges,
} from "./parts";
import {
  androidDockPresentation,
  androidSkillsSessionView,
} from "./presentation";
import {
  decide,
  mutation,
  deviceInput,
  performGesture,
  startSession,
  usePrototypeSession,
} from "./session";

/**
 * Prototype A: the agent leads. An agent opens the Android session with its
 * own selection, and the Workspace asks the person to confirm it in the
 * dock's request tier, where an Execution Boundary would ask. The device is
 * acted on through chips laid over the mirror, so the person never looks
 * away from the screen they are teaching on.
 */
const Proposal = ({
  onConfirm,
}: {
  readonly onConfirm: (helper: boolean) => void;
}) => {
  const [helperAtom] = useState(() => Atom.make(false));
  const [helper, setHelper] = useAtom(helperAtom);
  const { device, environment, setup } = FIXTURE_SELECTION;
  return (
    <div className="bg-muted/50 space-y-2 border-b px-3 py-2.5">
      <RequestHeader
        action={
          <>
            <Button size="xs" type="button" variant="outline">
              Not this device
            </Button>
            <Button onClick={() => onConfirm(helper)} size="xs" type="button">
              Confirm
            </Button>
          </>
        }
        icon={<BotIcon aria-hidden="true" className={requestIconClassName} />}
        title="The agent wants to teach on Android"
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Emulator</dt>
        <dd>
          {device.avd} · {device.serial} · API {device.api}
        </dd>
        <dt className="text-muted-foreground">Target App</dt>
        <dd>
          {environment.appId} · build {environment.appBuild}
        </dd>
        <dt className="text-muted-foreground">Starts at</dt>
        <dd>
          {setup.conditions.map((condition) => condition.name).join(", ")}
        </dd>
      </dl>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={helper}
          onCheckedChange={(checked) => setHelper(checked === true)}
        />
        Install the pinned helper if the emulator lacks it
      </label>
    </div>
  );
};

export const AgentLedPrototype = ({
  state,
}: {
  readonly state: PrototypeState;
}) => {
  const [session, dispatch] = usePrototypeSession(state);
  if (session === null) {
    return (
      <main className="bg-muted/20 relative flex h-svh flex-col">
        <div className="grid flex-1 place-items-center p-6 pb-56">
          <DeviceFrame className="h-[70svh]" image={null} />
        </div>
        <DockShell
          requests={
            <Proposal onConfirm={(helper) => startSession(dispatch, helper)} />
          }
          status={
            <DockStatus
              badges={
                <>
                  <Badge variant="secondary">Waiting for you</Badge>
                  <ExperimentalBadge />
                </>
              }
            >
              Confirm the agent's device before anything is prepared.
            </DockStatus>
          }
        >
          <DockWordmark />
          <span className="flex items-center gap-1.5 px-2 text-sm">
            <SmartphoneIcon aria-hidden="true" className="size-4" />
            checkout
          </span>
        </DockShell>
      </main>
    );
  }
  const presentation = androidDockPresentation(session);
  const canAct = session.controller === "user" && session.phase === "running";
  const ended = session.phase === "completed" || session.phase === "closed";
  const gesture = presentation.action?.gesture;
  const perform = () => {
    if (gesture !== undefined) {
      performGesture(gesture, session, dispatch);
    }
  };
  const input = (action: Parameters<typeof deviceInput>[2]) =>
    deviceInput(session, dispatch, action);
  return (
    <div className="relative flex h-svh min-h-0 flex-col">
      <WorkspaceLayout
        sessionId={session.id}
        skillsSession={androidSkillsSessionView(session)}
        summary={
          ended
            ? {
                label: "Run Summary",
                summary: <PrototypeSummary session={session} />,
              }
            : null
        }
      >
        <main className="bg-muted/20 relative flex min-h-0 flex-1 justify-center p-6 pb-32">
          <Device
            agentTarget={
              session.controller === "agent" && session.phase === "running"
                ? AGENT_TARGET
                : undefined
            }
            canAct={canAct}
            dimmed={session.phase === "paused"}
            onInput={input}
            overlay={
              <>
                {session.phase === "paused" ? (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center">
                    <div className="bg-background space-y-1 rounded-xl border p-4 shadow-lg">
                      <UnplugIcon className="mx-auto size-6 text-amber-600" />
                      <p className="text-sm font-medium">
                        Emulator disconnected
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Showing the last capture. Recover the same emulator to
                        carry on.
                      </p>
                    </div>
                  </div>
                ) : null}
                {session.controller === "agent" &&
                session.phase === "running" ? (
                  <div className="absolute inset-x-3 top-[5%] flex items-center gap-1.5 rounded-full bg-neutral-900/90 px-3 py-1.5 text-xs text-white shadow">
                    <BotIcon aria-hidden="true" className="size-3.5" />
                    Agent: Activate button Place mock order
                  </div>
                ) : null}
              </>
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
            <span className="flex items-center gap-1.5 px-2 text-sm">
              <SmartphoneIcon aria-hidden="true" className="size-4" />
              {session.flowSkillName}
            </span>
            <DockSpacer />
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
            {presentation.action === null ? null : (
              <Button
                onClick={perform}
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
