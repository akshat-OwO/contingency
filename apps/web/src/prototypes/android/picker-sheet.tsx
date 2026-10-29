import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  CircleIcon,
  GlobeIcon,
  PlusIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
  UserIcon,
  BotIcon,
} from "lucide-react";
import { useState } from "react";

import { androidDeviceLabel } from "@/components/agent/android-workspace-state";
import {
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { Device } from "./device";
import {
  AGENT_TARGET,
  DETECTED_EMULATORS,
  FIXTURE_SELECTION,
  fixtureSessions,
} from "./fixtures";
import type { PrototypeState } from "./fixtures";
import { WorkspaceLayout } from "./layout";
import { ExperimentalBadge, PrototypeSummary, StateBadges } from "./parts";
import {
  androidDockPresentation,
  androidSkillsSessionView,
} from "./presentation";
import {
  decide,
  deviceInput,
  mutation,
  performGesture,
  startSession,
  usePrototypeSession,
} from "./session";

/**
 * Prototype C: one session menu for both platforms. Browser and Android
 * sessions are listed together with their platform, and the menu ends with
 * the ways to open a new one. A new Android session is set up in a side
 * sheet before anything is prepared. Every Android-only gesture is the
 * dock's primary action; the device's elements open from the dock too.
 */
const SessionMenu = ({
  onNewAndroid,
  selected,
}: {
  readonly onNewAndroid: () => void;
  readonly selected: string | undefined;
}) => (
  <Popover>
    <PopoverTrigger
      render={(props) => (
        <Button {...props} className="max-w-56" size="sm" variant="outline">
          <SmartphoneIcon aria-hidden="true" />
          <span className="truncate">{selected ?? "Sessions"}</span>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      )}
    />
    <PopoverContent align="start" className="w-80 p-1" side="top">
      <p className="text-muted-foreground px-2 py-1 text-xs">Sessions</p>
      <button
        className="hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        type="button"
      >
        <GlobeIcon className="size-4" />
        <span className="flex-1 truncate">new-flow</span>
        <span className="text-muted-foreground text-xs">Teaching</span>
      </button>
      {fixtureSessions().map((session) => (
        <button
          className="hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
          key={session.id}
          type="button"
        >
          <SmartphoneIcon className="size-4" />
          <span className="flex-1 truncate">{session.flowSkillName}</span>
          <span className="text-muted-foreground text-xs">{session.kind}</span>
        </button>
      ))}
      <div className="my-1 border-t" />
      <button
        className="hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        type="button"
      >
        <PlusIcon className="size-4" /> New browser session
      </button>
      <button
        className="hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        onClick={onNewAndroid}
        type="button"
      >
        <PlusIcon className="size-4" /> New Android session
        <ExperimentalBadge />
      </button>
    </PopoverContent>
  </Popover>
);

const SetupSheet = ({
  onOpen,
  onOpenChange,
  open,
}: {
  readonly onOpen: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) => (
  <Sheet onOpenChange={onOpenChange} open={open}>
    <SheetContent className="sm:max-w-md">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          New Android session <ExperimentalBadge />
        </SheetTitle>
        <SheetDescription>
          Nothing is prepared until you open the session.
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-5 overflow-y-auto px-4 text-sm">
        <section className="space-y-2">
          <h3 className="text-xs font-medium">Emulator</h3>
          <div className="grid grid-cols-2 gap-2">
            {DETECTED_EMULATORS.map((emulator, index) => (
              <div
                className={cn(
                  "rounded-lg border p-2",
                  index === 0 ? "border-primary" : "opacity-50"
                )}
                key={emulator.serial}
              >
                <SmartphoneIcon className="mb-1 size-4" />
                <p className="truncate text-xs font-medium">{emulator.avd}</p>
                <p className="text-muted-foreground text-xs">
                  {emulator.serial} · {emulator.ready ? "ready" : "offline"}
                </p>
              </div>
            ))}
          </div>
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-medium">Target App</h3>
          <Input defaultValue={FIXTURE_SELECTION.environment.appId} />
          <p className="text-muted-foreground text-xs">
            Build 1 · restarts at .MainActivity
          </p>
        </section>
        <section className="space-y-1">
          <h3 className="text-xs font-medium">Starts at · Done when</h3>
          <p className="text-xs">Fixture Shop sign in → Order confirmed</p>
        </section>
      </div>
      <SheetFooter>
        <Button onClick={onOpen}>Open session</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

export const PickerSheetPrototype = ({
  state,
}: {
  readonly state: PrototypeState;
}) => {
  const [session, dispatch] = usePrototypeSession(state);
  const [sheetAtom] = useState(() => Atom.make(state === "select"));
  const [sheetOpen, setSheetOpen] = useAtom(sheetAtom);
  const sheet = (
    <SetupSheet
      onOpen={() => {
        setSheetOpen(false);
        startSession(dispatch, false);
      }}
      onOpenChange={setSheetOpen}
      open={sheetOpen}
    />
  );
  if (session === null) {
    return (
      <main className="bg-muted/20 relative flex h-svh">
        {sheet}
        <DockShell
          status={
            <DockStatus badges={<Badge variant="secondary">No session</Badge>}>
              Open a browser or Android session from the session menu.
            </DockStatus>
          }
        >
          <DockWordmark />
          <SessionMenu
            onNewAndroid={() => setSheetOpen(true)}
            selected={undefined}
          />
        </DockShell>
      </main>
    );
  }
  const presentation = androidDockPresentation(session);
  const gesture = presentation.action?.gesture;
  const pending = session.preparation.pending.at(0);
  const ended = session.phase === "completed" || session.phase === "closed";
  const canAct = session.controller === "user" && session.phase === "running";
  return (
    <div className="relative flex h-svh min-h-0 flex-col">
      {sheet}
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
        <main className="bg-muted/20 relative flex min-h-0 flex-1 flex-col items-center gap-2 p-4 pb-36">
          <div className="bg-background flex items-center gap-3 rounded-full border px-3 py-1 text-xs shadow-xs">
            <span>
              {androidDeviceLabel(session.selection.device)} ·{" "}
              {session.selection.device.serial}
            </span>
            <span className="text-muted-foreground">
              {session.selection.environment.appId} · build{" "}
              {session.selection.environment.appBuild}
            </span>
            <span className="flex items-center gap-1">
              {session.controller === "agent" ? (
                <BotIcon className="size-3.5" />
              ) : (
                <UserIcon className="size-3.5" />
              )}
              {session.controller === "agent" ? "Agent" : "You"}
            </span>
          </div>
          {session.phase === "paused" ? (
            <div className="flex items-center gap-2 rounded-md bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <UnplugIcon className="size-3.5" />
              Disconnected · showing the last capture
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Device
              agentTarget={
                session.controller === "agent" && session.phase === "running"
                  ? AGENT_TARGET
                  : undefined
              }
              canAct={canAct}
              onInput={(action) => deviceInput(session, dispatch, action)}
              session={session}
              dimmed={session.phase === "paused"}
            />
          </div>
          <DockShell
            status={
              <DockStatus
                badges={<StateBadges session={session} />}
                details={
                  pending === undefined ? undefined : (
                    <p className="text-xs">
                      {session.preparation.differences
                        .map(
                          (difference) =>
                            `${difference.field}: taught ${difference.taught}, selected ${difference.selected}`
                        )
                        .join("; ")}
                    </p>
                  )
                }
              >
                {pending === undefined
                  ? presentation.nextStep
                  : `The agent wants to run on build ${session.selection.environment.appBuild}; it was taught on build 1.`}
              </DockStatus>
            }
          >
            <DockWordmark />
            <SessionMenu
              onNewAndroid={() => setSheetOpen(true)}
              selected={session.flowSkillName}
            />
            <DockSpacer />
            {pending === undefined ? null : (
              <>
                <Button
                  onClick={() => decide(session, dispatch, pending.id, false)}
                  size="sm"
                  variant="outline"
                >
                  Refuse
                </Button>
                <Button
                  onClick={() => decide(session, dispatch, pending.id, true)}
                >
                  Allow build 2
                </Button>
              </>
            )}
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
