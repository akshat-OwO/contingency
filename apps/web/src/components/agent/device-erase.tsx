import type {
  DeviceErasePlatform,
  DeviceEraseState,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { EraserIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  dismissDeviceErase,
  eraseDevice,
  readDeviceEraseState,
} from "@/lib/rpc";

import type { DeviceChoice } from "./device-choice-state";
import { erasable } from "./device-erase-state";
import type { DeviceEraseControls, DeviceErasing } from "./device-erase-state";

const failure = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "The host did not answer.")
  );

/**
 * Device Erase for one platform's setup sheet (ADR 0081). It reads the
 * process's erase state with the device list, and refreshes the list once
 * an erase has booted the device again.
 */
export const useDeviceErase = (
  platform: DeviceErasePlatform,
  open: boolean,
  refreshKey: string,
  onErased: () => void
) => {
  const [stateAtom] = useState(() =>
    Atom.make<DeviceEraseState>({
      owned: { android: [], ios: [] },
      requests: [],
    })
  );
  const [state, setState] = useAtom(stateAtom);
  const [erasingAtom] = useState(() =>
    Atom.make<Readonly<Record<string, DeviceErasing>>>({})
  );
  const [erasing, setErasing] = useAtom(erasingAtom);
  const [pendingAtom] = useState(() =>
    Atom.make<{
      readonly eraseId: string;
      readonly name: string;
      readonly requestId?: string;
    } | null>(null)
  );
  const [pending, setPending] = useAtom(pendingAtom);
  const [revisionAtom] = useState(() => Atom.make(0));
  const [revision, setRevision] = useAtom(revisionAtom);
  const fibers = useRef(new Set<Fiber.Fiber<unknown, unknown>>());
  useEffect(() => {
    const owned = fibers.current;
    return () => {
      for (const fiber of owned) {
        Effect.runFork(Fiber.interrupt(fiber));
      }
      owned.clear();
    };
  }, []);
  useEffect(() => {
    if (!open) {
      return;
    }
    const fiber = Effect.runFork(
      readDeviceEraseState.pipe(
        Effect.tap((next) => Effect.sync(() => setState(next))),
        Effect.ignore
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [open, refreshKey, revision, setState]);
  const run = (effect: Effect.Effect<unknown, unknown>) => {
    const fiber = Effect.runFork(effect);
    fibers.current.add(fiber);
    fiber.addObserver(() => fibers.current.delete(fiber));
  };
  const erase = (eraseId: string, requestId?: string) => {
    if (erasing[eraseId]?._tag === "erasing") {
      return;
    }
    setErasing((current) => ({ ...current, [eraseId]: { _tag: "erasing" } }));
    run(
      eraseDevice(
        requestId === undefined
          ? { device: eraseId, platform }
          : { device: eraseId, platform, requestId }
      ).pipe(
        Effect.match({
          onFailure: (cause) => ({
            _tag: "failed" as const,
            reason: failure(cause),
          }),
          onSuccess: () => null,
        }),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setErasing((current) =>
              outcome === null
                ? Object.fromEntries(
                    Object.entries(current).filter(([key]) => key !== eraseId)
                  )
                : { ...current, [eraseId]: outcome }
            );
            setRevision((value) => value + 1);
            if (outcome === null) {
              onErased();
            }
          })
        )
      )
    );
  };
  const controls: DeviceEraseControls = {
    confirm: (eraseId, name, requestId) =>
      setPending(
        requestId === undefined
          ? { eraseId, name }
          : { eraseId, name, requestId }
      ),
    dismiss: (requestId) =>
      run(
        dismissDeviceErase(requestId).pipe(
          Effect.ignore,
          Effect.tap(() => Effect.sync(() => setRevision((value) => value + 1)))
        )
      ),
    erasing,
    owned: state.owned[platform],
    platform,
    requests: state.requests.filter(
      (request) => request.platform === platform && request.status === "pending"
    ),
  };
  const dialog = (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          setPending(null);
        }
      }}
      open={pending !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Erase {pending?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes every app, device account, and piece of data on{" "}
            {pending?.name}, including the Contingency device helper, which the
            next session installs again.{" "}
            {platform === "android"
              ? "The emulator starts again with its data wiped."
              : "The simulator is erased, then starts again."}{" "}
            It cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pending !== null) {
                erase(pending.eraseId, pending.requestId);
              }
              setPending(null);
            }}
            variant="destructive"
          >
            Erase device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { controls, dialog };
};

/** The Erase control on one device card, with its progress or failure. */
export const DeviceEraseButton = ({
  controls,
  device,
}: {
  readonly controls: DeviceEraseControls;
  readonly device: DeviceChoice;
}) => {
  const { eraseId } = device;
  if (eraseId === undefined) {
    return null;
  }
  const progress = controls.erasing[eraseId];
  if (progress?._tag === "erasing") {
    return (
      <span
        aria-live="polite"
        className="text-muted-foreground mt-2 flex items-center gap-1 text-xs"
      >
        <LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin" />
        Erasing…
      </span>
    );
  }
  if (!erasable(device, controls)) {
    return device.status._tag === "ready" ? (
      <span className="text-muted-foreground mt-2 block text-xs">
        Stop this device to erase it.
      </span>
    ) : null;
  }
  return (
    <>
      {progress?._tag === "failed" ? (
        <span
          aria-live="polite"
          className="text-destructive mt-2 block text-xs"
        >
          {progress.reason}
        </span>
      ) : null}
      <Button
        aria-label={`Erase ${device.name}`}
        className="mt-2"
        onClick={() => controls.confirm(eraseId, device.name)}
        size="xs"
        type="button"
        variant="ghost"
      >
        <EraserIcon aria-hidden="true" />
        Erase device
      </Button>
    </>
  );
};

/** Agent erase requests, each waiting on the user's click. */
export const DeviceEraseRequests = ({
  controls,
  devices,
}: {
  readonly controls: DeviceEraseControls;
  readonly devices: readonly DeviceChoice[];
}) =>
  controls.requests.length === 0 ? null : (
    <div className="space-y-2">
      {controls.requests.map((request) => {
        const device = devices.find(
          (candidate) => candidate.eraseId === request.device
        );
        const name = device?.name ?? request.device;
        const allowed = device !== undefined && erasable(device, controls);
        return (
          <section
            aria-label="Device Erase request"
            className="bg-muted-surface rounded-lg border p-2.5 text-xs"
            key={request.id}
          >
            <p className="font-medium">The agent asks to erase {name}.</p>
            <p className="text-muted-foreground mt-0.5 text-pretty">
              {allowed
                ? "Every app, account, and piece of data on it would be removed."
                : "Stop this device to erase it, or dismiss the request."}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                disabled={!allowed}
                onClick={() =>
                  controls.confirm(request.device, name, request.id)
                }
                size="xs"
                type="button"
                variant="destructive"
              >
                Erase device
              </Button>
              <Button
                onClick={() => controls.dismiss(request.id)}
                size="xs"
                type="button"
                variant="outline"
              >
                Dismiss
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
