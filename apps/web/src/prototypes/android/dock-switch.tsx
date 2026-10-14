import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  BotIcon,
  CheckIcon,
  CircleIcon,
  GlobeIcon,
  ShieldAlertIcon,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { Device } from "./device";
import {
  AGENT_TARGET,
  DETECTED_EMULATORS,
  FIXTURE_SELECTION,
} from "./fixtures";
import type { PrototypeState } from "./fixtures";
import { ExperimentalBadge, PrototypeSummary, StateBadges } from "./parts";
import { androidDockPresentation } from "./presentation";
import {
  decide,
  deviceInput,
  mutation,
  performGesture,
  startSession,
  usePrototypeSession,
} from "./session";

/**
 * Prototype B: the platform is a switch in the dock. Choosing Android with no
 * session opens a three-step setup inside the dock itself, read from the
 * device where it can be. The device's elements, the agent's steps, and the
 * Run Summary share one rail beside the mirror, where the browser docks its
 * inspector. Android-only interruptions are drawn on the device they block.
 */
const PlatformSwitch = () => (
  <div
    aria-label="Platform"
    className="bg-muted flex shrink-0 rounded-lg p-0.5"
    role="radiogroup"
  >
    <button
      aria-checked={false}
      className="text-muted-foreground flex items-center gap-1 rounded-md px-2 py-1 text-xs"
      role="radio"
      type="button"
    >
      <GlobeIcon aria-hidden="true" className="size-3.5" />
      Browser
    </button>
    <button
      aria-checked
      className="bg-background flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium shadow-xs"
      role="radio"
      type="button"
    >
      <SmartphoneIcon aria-hidden="true" className="size-3.5" />
      Android
      <sup className="text-muted-foreground text-xs">exp</sup>
    </button>
  </div>
);

const Step = ({
  children,
  index,
  title,
}: {
  readonly children: React.ReactNode;
  readonly index: number;
  readonly title: string;
}) => (
  <li className="min-w-0 flex-1 space-y-1.5">
    <p className="flex items-center gap-1.5 text-xs font-medium">
      <span className="bg-primary text-primary-foreground grid size-4 place-items-center rounded-full text-xs">
        {index}
      </span>
      {title}
    </p>
    {children}
  </li>
);

/** The setup steps, inside the dock's request tier. */
const InlineSetup = ({ onOpen }: { readonly onOpen: () => void }) => {
  const [deviceAtom] = useState(() => Atom.make("emulator-5554"));
  const [device, setDevice] = useAtom(deviceAtom);
  return (
    <div className="bg-muted/50 space-y-3 border-b px-3 py-3">
      <ol className="flex gap-4">
        <Step index={1} title="Emulator">
          {DETECTED_EMULATORS.map((emulator) => (
            <button
              className={cn(
                "flex w-full items-center justify-between rounded-md border px-2 py-1 text-left text-xs",
                device === emulator.serial && "border-primary bg-background",
                !emulator.ready && "opacity-50"
              )}
              disabled={!emulator.ready}
              key={emulator.serial}
              onClick={() => setDevice(emulator.serial)}
              type="button"
            >
              <span className="truncate">{emulator.avd}</span>
              <span className="text-muted-foreground">
                {emulator.ready ? `API ${emulator.api}` : "offline"}
              </span>
            </button>
          ))}
        </Step>
        <Step index={2} title="Target App">
          <Input
            className="h-7 text-xs"
            defaultValue={FIXTURE_SELECTION.environment.appId}
          />
          <p className="text-muted-foreground flex items-center gap-1 text-xs">
            <CheckIcon className="size-3" /> build 1 read from the device
          </p>
        </Step>
        <Step index={3} title="Starting screen">
          <div className="rounded-md border px-2 py-1 text-xs">
            group · Fixture Shop sign in
          </div>
          <p className="text-muted-foreground text-xs">
            Picked from the current screen
          </p>
        </Step>
      </ol>
      <div className="flex justify-end">
        <Button onClick={onOpen} size="sm">
          Open Android session
        </Button>
      </div>
    </div>
  );
};

const RAIL_TABS = ["Agent steps", "Summary"] as const;

const Rail = ({ session }: { readonly session: AndroidWorkspaceSnapshot }) => {
  const ended = session.phase === "completed" || session.phase === "closed";
  const initial = ended ? "Summary" : "Agent steps";
  const [tabAtom] = useState(() => Atom.make<string>(initial));
  const [tab, setTab] = useAtom(tabAtom);
  return (
    <aside className="bg-background flex w-80 shrink-0 flex-col border-r">
      <div className="flex gap-1 border-b px-2 py-1.5">
        {RAIL_TABS.map((name) => (
          <Button
            key={name}
            onClick={() => setTab(name)}
            size="xs"
            variant={tab === name ? "secondary" : "ghost"}
          >
            {name}
          </Button>
        ))}
      </div>
      {tab === "Agent steps" && session.observation === null ? (
        <p className="text-muted-foreground p-3 text-xs">
          No steps yet. The agent starts once the emulator is prepared.
        </p>
      ) : null}
      {tab === "Agent steps" && session.observation !== null ? (
        <ol className="space-y-2 p-3 text-xs">
          {[
            "Enter public text in text-field Shopper name",
            "Activate button Sign in",
            "Activate button Add Anvil to cart",
            "Activate button Open cart",
          ].map((step) => (
            <li className="flex gap-2" key={step}>
              <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
              {step}
            </li>
          ))}
          <li className="flex gap-2 font-medium">
            <BotIcon className="size-3.5 shrink-0" />
            Activate button Place mock order
          </li>
        </ol>
      ) : null}
      {tab === "Summary" ? <PrototypeSummary session={session} /> : null}
    </aside>
  );
};

export const DockSwitchPrototype = ({
  state,
}: {
  readonly state: PrototypeState;
}) => {
  const [session, dispatch] = usePrototypeSession(state);
  if (session === null) {
    return (
      <main className="bg-muted/20 relative flex h-svh">
        <div className="grid flex-1 place-items-center p-6 pb-72">
          <p className="text-muted-foreground text-sm">
            Pick an emulator to mirror it here.
          </p>
        </div>
        <DockShell
          requests={
            <InlineSetup onOpen={() => startSession(dispatch, false)} />
          }
          status={
            <DockStatus
              badges={
                <>
                  <Badge variant="secondary">No session</Badge>
                  <ExperimentalBadge />
                </>
              }
            >
              Choose the emulator and Target App. Nothing is prepared until you
              open the session.
            </DockStatus>
          }
        >
          <DockWordmark />
          <PlatformSwitch />
        </DockShell>
      </main>
    );
  }
  const presentation = androidDockPresentation(session);
  const gesture = presentation.action?.gesture;
  const pending = session.preparation.pending.at(0);
  return (
    <main className="relative flex h-svh min-h-0">
      <Rail key={session.revision === 0 ? "first" : "next"} session={session} />
      <div className="bg-muted/20 relative flex min-h-0 flex-1 justify-center p-6 pb-32">
        <Device
          agentTarget={
            session.controller === "agent" && session.phase === "running"
              ? AGENT_TARGET
              : undefined
          }
          canAct={session.controller === "user" && session.phase === "running"}
          onInput={(action) => deviceInput(session, dispatch, action)}
          session={session}
          dimmed={session.phase === "paused" || pending !== undefined}
          overlay={
            <>
              {pending === undefined ? null : (
                <div className="absolute inset-0 grid place-items-center p-4">
                  <section
                    aria-label="Run Environment Permission"
                    className="bg-background space-y-2 rounded-xl border p-4 shadow-xl"
                  >
                    <ShieldAlertIcon className="size-5 text-amber-600" />
                    <p className="text-sm font-medium">
                      Run on a different build?
                    </p>
                    <table className="w-full text-xs">
                      <tbody>
                        {session.preparation.differences.map((difference) => (
                          <tr key={difference.field}>
                            <td className="text-muted-foreground pr-2">
                              {difference.field}
                            </td>
                            <td>taught {difference.taught}</td>
                            <td className="font-medium">
                              now {difference.selected}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="flex gap-2">
                      <Button
                        onClick={() =>
                          decide(session, dispatch, pending.id, false)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Refuse
                      </Button>
                      <Button
                        onClick={() =>
                          decide(session, dispatch, pending.id, true)
                        }
                        size="sm"
                      >
                        Allow
                      </Button>
                    </div>
                  </section>
                </div>
              )}
              {session.phase === "paused" ? (
                <div className="absolute inset-0 grid place-items-center p-4">
                  <div className="bg-background space-y-2 rounded-xl border p-4 text-center shadow-xl">
                    <UnplugIcon className="mx-auto size-6 text-amber-600" />
                    <p className="text-sm font-medium">Disconnected</p>
                    <p className="text-muted-foreground text-xs">
                      {session.selection.device.serial} left the host.
                    </p>
                    <Button
                      onClick={() =>
                        performGesture("recover", session, dispatch)
                      }
                      size="sm"
                    >
                      Recover same emulator
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          }
        />
        <DockShell
          status={
            <DockStatus badges={<StateBadges session={session} />}>
              {presentation.nextStep}
            </DockStatus>
          }
        >
          <DockWordmark />
          <PlatformSwitch />
          <span className="truncate px-1 text-sm">{session.flowSkillName}</span>
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
          {presentation.action === null || gesture === "recover" ? null : (
            <Button
              onClick={() =>
                gesture === undefined
                  ? undefined
                  : performGesture(gesture, session, dispatch)
              }
              variant={gesture === "stop-recording" ? "destructive" : "default"}
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
      </div>
    </main>
  );
};
