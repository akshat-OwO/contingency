import type { AndroidWorkspaceSelection } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  FlagIcon,
  HandIcon,
  SearchIcon,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { DeviceFrame } from "./device";
import {
  BOUNDS,
  DETECTED_EMULATORS,
  FIXTURE_SELECTION,
  INSTALLED_APPS,
  SCREENS,
} from "./fixtures";
import { ExperimentalBadge } from "./parts";

type Condition = AndroidWorkspaceSelection["reversibleActions"][number];
type Mark = "start" | "allow";

interface SetupForm {
  readonly allowed: readonly Condition[];
  readonly app: string | null;
  readonly device: string | null;
  readonly helper: boolean;
  readonly mark: Mark;
  readonly outcome: string;
  readonly query: string;
  readonly start: Condition | null;
}

/** Prefilled from the checkout fixture, as a detected device would be. */
const INITIAL_FORM: SetupForm = {
  allowed: [{ name: "Sign in", role: "button" }],
  app: "dev.contingency.checkout",
  device: "emulator-5554",
  helper: false,
  mark: "start",
  outcome: "Order confirmed",
  query: "",
  start: { name: "Fixture Shop sign in", role: "group" },
};

const Step = ({
  children,
  done,
  index,
  title,
}: {
  readonly children: React.ReactNode;
  readonly done: boolean;
  readonly index: number;
  readonly title: string;
}) => (
  <section className="space-y-2">
    <h3 className="flex items-center gap-2 text-sm font-medium">
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full border text-xs",
          done && "bg-primary text-primary-foreground border-primary"
        )}
      >
        {done ? <CheckIcon className="size-3" /> : index}
      </span>
      {title}
    </h3>
    <div className="pl-7">{children}</div>
  </section>
);

/**
 * The starting screen, live. In `start` mode a tap names the element that
 * proves the app is where the journey begins; in `allow` mode a tap adds or
 * removes a button the journey may press. Nothing here is typed.
 */
const StartingScreen = ({
  allowed,
  mark,
  onToggle,
  start,
}: {
  readonly allowed: readonly Condition[];
  readonly mark: Mark;
  readonly onToggle: (condition: Condition) => void;
  readonly start: Condition | null;
}) => {
  const screen = SCREENS.signin;
  return (
    <DeviceFrame className="h-[min(30rem,60svh)]" image={screen.image}>
      {screen.nodes.map((node) => {
        const bounds = BOUNDS.get(node.target);
        const markable =
          mark === "start"
            ? node.role !== "text-field"
            : node.role === "button";
        if (bounds === undefined || !markable) {
          return null;
        }
        const isStart = start?.name === node.name && start.role === node.role;
        const isAllowed = allowed.some(
          (entry) => entry.name === node.name && entry.role === node.role
        );
        return (
          <button
            aria-label={
              mark === "start"
                ? `Starts at ${node.role} ${node.name}`
                : `Allow ${node.role} ${node.name}`
            }
            aria-pressed={mark === "start" ? isStart : isAllowed}
            className={cn(
              "absolute cursor-pointer rounded-lg outline-2 outline-transparent transition hover:outline-sky-500",
              isStart && "outline-emerald-500 outline-dashed",
              isAllowed && "bg-sky-500/10 outline-sky-500"
            )}
            key={node.target}
            onClick={() => onToggle({ name: node.name, role: node.role })}
            style={{
              height: `${(bounds.height / 900) * 100}%`,
              left: `${(bounds.x / 401) * 100}%`,
              top: `${(bounds.y / 900) * 100}%`,
              width: `${(bounds.width / 401) * 100}%`,
            }}
            type="button"
          />
        );
      })}
    </DeviceFrame>
  );
};

/**
 * Prototype D's setup: emulator and Target App are picked from what the
 * host and the device report, and the starting screen and the allowed taps
 * are marked on a live preview of the app. An agent that opens the session
 * supplies the same selection and skips this sheet.
 */
export const SetupSheet = ({
  onOpen,
  onOpenChange,
  open,
}: {
  readonly onOpen: (selection: AndroidWorkspaceSelection) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) => {
  const [formAtom] = useState(() => Atom.make<SetupForm>(INITIAL_FORM));
  const [form, setForm] = useAtom(formAtom);
  const app = INSTALLED_APPS.find((entry) => entry.appId === form.app);
  const apps = INSTALLED_APPS.filter((entry) =>
    `${entry.label} ${entry.appId}`
      .toLowerCase()
      .includes(form.query.toLowerCase())
  );
  const ready =
    form.device !== null &&
    app !== undefined &&
    form.start !== null &&
    form.outcome.trim() !== "";
  const toggle = (condition: Condition) =>
    setForm((current) => {
      if (current.mark === "start") {
        return { ...current, start: condition };
      }
      const has = current.allowed.some(
        (entry) =>
          entry.name === condition.name && entry.role === condition.role
      );
      return {
        ...current,
        allowed: has
          ? current.allowed.filter(
              (entry) =>
                entry.name !== condition.name || entry.role !== condition.role
            )
          : [...current.allowed, condition],
      };
    });
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-4xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            New Android session <ExperimentalBadge />
          </SheetTitle>
          <SheetDescription>
            Pick what to teach on. Nothing is prepared or recorded until you
            open the session.
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto] gap-8 overflow-y-auto px-4">
          <div className="space-y-6">
            <Step done={form.device !== null} index={1} title="Emulator">
              <div className="grid grid-cols-2 gap-2">
                {DETECTED_EMULATORS.map((emulator) => (
                  <button
                    aria-pressed={form.device === emulator.serial}
                    className={cn(
                      "rounded-lg border p-2.5 text-left transition",
                      form.device === emulator.serial &&
                        "border-primary ring-primary/20 ring-2",
                      !emulator.ready && "cursor-not-allowed opacity-50"
                    )}
                    disabled={!emulator.ready}
                    key={emulator.serial}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        device: emulator.serial,
                      }))
                    }
                    type="button"
                  >
                    <SmartphoneIcon className="mb-1 size-4" />
                    <p className="truncate text-sm font-medium">
                      {emulator.avd}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {emulator.serial} · API {emulator.api} ·{" "}
                      {emulator.ready ? "running" : "not running"}
                    </p>
                  </button>
                ))}
              </div>
            </Step>
            <Step done={app !== undefined} index={2} title="Target App">
              <div className="space-y-1.5">
                <div className="relative">
                  <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                  <Input
                    aria-label="Search installed apps"
                    className="pl-8"
                    onChange={(event) => {
                      const query = event.target.value;
                      setForm((current) => ({ ...current, query }));
                    }}
                    placeholder="Apps installed on this emulator"
                    value={form.query}
                  />
                </div>
                <ul className="max-h-36 overflow-y-auto rounded-lg border">
                  {apps.map((entry) => (
                    <li key={entry.appId}>
                      <button
                        aria-pressed={form.app === entry.appId}
                        className={cn(
                          "hover:bg-muted flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                          form.app === entry.appId && "bg-muted"
                        )}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            app: entry.appId,
                          }))
                        }
                        type="button"
                      >
                        <span className="flex-1 truncate">
                          {entry.label}
                          <span className="text-muted-foreground ml-2 text-xs">
                            {entry.appId}
                          </span>
                        </span>
                        <Badge variant="outline">build {entry.appBuild}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
                {app === undefined ? null : (
                  <p className="text-muted-foreground text-xs">
                    Restarts {app.activity} before every Run.
                  </p>
                )}
              </div>
            </Step>
            <Step
              done={form.start !== null}
              index={3}
              title="Starting screen and allowed taps"
            >
              <div className="space-y-2 text-xs">
                <div className="bg-muted inline-flex rounded-lg p-0.5">
                  {(
                    [
                      ["start", "Mark the starting screen", FlagIcon],
                      ["allow", "Mark allowed taps", HandIcon],
                    ] as const
                  ).map(([mode, label, Icon]) => (
                    <button
                      aria-pressed={form.mark === mode}
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-1",
                        form.mark === mode && "bg-background shadow-xs"
                      )}
                      key={mode}
                      onClick={() =>
                        setForm((current) => ({ ...current, mark: mode }))
                      }
                      type="button"
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground">
                  Tap on the preview. The journey may press only the buttons you
                  allow.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {form.start === null ? null : (
                    <Badge variant="secondary">
                      <FlagIcon /> Starts at {form.start.name}
                    </Badge>
                  )}
                  {form.allowed.map((entry) => (
                    <Badge key={entry.name} variant="outline">
                      <HandIcon /> {entry.name}
                      <button
                        aria-label={`Remove ${entry.name}`}
                        onClick={() => toggle(entry)}
                        type="button"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            </Step>
            <Step done={form.outcome.trim() !== ""} index={4} title="Done when">
              <Input
                aria-label="Done when"
                onChange={(event) => {
                  const outcome = event.target.value;
                  setForm((current) => ({ ...current, outcome }));
                }}
                placeholder="What is on screen when the journey worked"
                value={form.outcome}
              />
            </Step>
            <label className="flex items-center gap-2 pl-7 text-xs">
              <Checkbox
                checked={form.helper}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    helper: checked === true,
                  }))
                }
              />
              Install the pinned helper if this emulator lacks it
            </label>
          </div>
          <StartingScreen
            allowed={form.allowed}
            mark={form.mark}
            onToggle={toggle}
            start={form.start}
          />
        </div>
        <SheetFooter className="flex-row justify-end">
          <Button
            disabled={!ready}
            onClick={() =>
              onOpen({
                ...FIXTURE_SELECTION,
                helperConsent: form.helper ? "install" : "none",
                outcomes: [{ name: form.outcome.trim(), role: "group" }],
                reversibleActions: form.allowed,
                setup: {
                  ...FIXTURE_SELECTION.setup,
                  conditions:
                    form.start === null
                      ? FIXTURE_SELECTION.setup.conditions
                      : [form.start],
                },
              })
            }
          >
            Open session
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
