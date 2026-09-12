import type {
  PermissionDecision,
  PermissionState,
  SessionEmulation,
} from "@contingency/protocol";
import { make as makeScopedAtom, useAtom } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { MapPinIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { EmulationPatch } from "@/components/browser/emulation-patch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The website permissions the Workspace can decide by name. Geolocation leads
 * because an emulated location only reaches a site that asks when its
 * permission is genuinely granted, and only a deliberate denial makes that
 * site observe refusal ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
const DECIDABLE_PERMISSIONS = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "clipboard-read",
] as const;

const LATITUDE_BOUND = 90;
const LONGITUDE_BOUND = 180;
/** The permission the decision Select opens on. */
const DEFAULT_PERMISSION_CHOICE = "geolocation";

/** How a decision reads back, so an origin-scoped one is not read as global. */
const decisionLabel = (decision: PermissionDecision): string =>
  decision.origin === undefined
    ? `${decision.permission} (every website)`
    : `${decision.permission} (${decision.origin})`;

/** The decisions as they read back, split by the answer each one records. */
interface DecisionLabels {
  readonly denied: readonly string[];
  readonly granted: readonly string[];
}

const decisionLabels = (
  decisions: readonly PermissionDecision[]
): DecisionLabels => {
  const denied: string[] = [];
  const granted: string[] = [];
  for (const decision of decisions) {
    (decision.state === "granted" ? granted : denied).push(
      decisionLabel(decision)
    );
  }
  return { denied, granted };
};

type LocationScope = "context" | "origin";

interface PendingLocation {
  readonly geolocation: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly origin: string | undefined;
}

/** Pending location choices belong to one picker, never to the module. */
const PendingLocationAtom = makeScopedAtom(() =>
  Atom.make<PendingLocation | null>(null)
);

/** The scope choice belongs to one mounted confirmation dialog. */
const LocationPermissionScopeAtom = makeScopedAtom(
  (origin: string | undefined) =>
    Atom.make<LocationScope>(origin === undefined ? "context" : "origin")
);

/** A permission decision applies to every origin or one exact HTTP origin. */
const permissionDecisionMatches = (
  permission: string,
  decision: PermissionDecision,
  origin: string | undefined
): boolean =>
  decision.permission === permission &&
  (decision.origin === undefined ||
    (origin !== undefined && decision.origin === origin));

/**
 * Replace one permission answer while preserving unrelated permissions and
 * scopes. Chromium cannot represent a context-wide grant beside an origin
 * denial, so that impossible denial is removed when granting everywhere.
 */
const permissionsAfterDecision = (
  decisions: readonly PermissionDecision[],
  permission: string,
  state: PermissionState,
  origin?: string
): PermissionDecision[] => {
  const kept = decisions.filter((decision) => {
    if (decision.permission !== permission) {
      return true;
    }
    if (decision.origin === origin) {
      return false;
    }
    if (origin === undefined) {
      return !(state === "granted" && decision.state === "denied");
    }
    return !(state === "denied" && decision.origin === undefined);
  });
  const decision: PermissionDecision =
    origin === undefined
      ? { permission, state }
      : { origin, permission, state };
  return [...kept, decision];
};

const LocationPermissionDialogContent = ({
  location,
  onApply,
  onCancel,
}: {
  readonly location: PendingLocation;
  readonly onApply: (state: PermissionState, scope: LocationScope) => void;
  readonly onCancel: () => void;
}) => {
  const { origin } = location;
  const [scope, setScope] = useAtom(LocationPermissionScopeAtom.use());

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    globalThis.document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      globalThis.document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onCancel]);

  // A new confirmation mounts a fresh dialog, so this default is deliberately
  // local: changing the active Page later must not silently retarget an
  // already pending author decision.
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      onCancel();
    }
  };

  return (
    <Dialog onOpenChange={handleDialogOpenChange} open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Apply the emulated location?</DialogTitle>
          <DialogDescription>
            Choose whether the Flow grants or denies geolocation access. The
            decision is saved separately from the coordinates and is applied
            without showing a browser permission prompt in the canvas.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Permission scope</legend>
          {origin === undefined ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                checked
                className="mt-0.5"
                name="location-permission-scope"
                onChange={() => setScope("context")}
                type="radio"
                value="context"
              />
              <span>
                Every website (context-wide)
                <span className="text-muted-foreground block text-xs">
                  No website is open, so this decision applies to every website.
                </span>
              </span>
            </label>
          ) : (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  checked={scope === "origin"}
                  className="mt-0.5"
                  name="location-permission-scope"
                  onChange={() => setScope("origin")}
                  type="radio"
                  value="origin"
                />
                <span>
                  Current website only ({origin})
                  <span className="text-muted-foreground block text-xs">
                    Only this exact website origin receives this answer.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  checked={scope === "context"}
                  className="mt-0.5"
                  name="location-permission-scope"
                  onChange={() => setScope("context")}
                  type="radio"
                  value="context"
                />
                <span>
                  Every website (context-wide)
                  <span className="text-muted-foreground block text-xs">
                    This answer applies to every website in the Flow.
                  </span>
                </span>
              </label>
            </>
          )}
        </fieldset>

        <DialogFooter className="mt-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            onClick={() => onApply("denied", scope)}
            type="button"
            variant="secondary"
          >
            Apply without permission
          </Button>
          <Button onClick={() => onApply("granted", scope)} type="button">
            Apply and grant location
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const LocationPermissionDialog = ({
  location,
  onApply,
  onCancel,
}: {
  readonly location: PendingLocation;
  readonly onApply: (state: PermissionState, scope: LocationScope) => void;
  readonly onCancel: () => void;
}) => (
  <LocationPermissionScopeAtom.Provider value={location.origin}>
    <LocationPermissionDialogContent
      location={location}
      onApply={onApply}
      onCancel={onCancel}
    />
  </LocationPermissionScopeAtom.Provider>
);

/**
 * What the interface knows about a session's Emulation. "Unknown" is a state of
 * its own rather than an empty Emulation: a patch replaces the whole permission
 * list, so a client that has not read the session's own list must not send one.
 */
export type SessionEmulationState =
  | { readonly status: "unknown" }
  | { readonly status: "known"; readonly emulation: SessionEmulation };

interface EmulationPickerProps {
  /** The Emulation the session applies, once the interface has read it. */
  readonly applied: SessionEmulationState;
  /** The active Page's HTTP origin, when the Workspace has one. */
  readonly currentOrigin?: string | undefined;
  readonly disabled: boolean;
  readonly onPatch: (patch: EmulationPatch) => void;
}

/** One decimal coordinate, validated before it reaches the session. */
const parseCoordinate = (value: string, bound: number): number | undefined => {
  if (value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > bound) {
    return undefined;
  }
  return parsed;
};

/**
 * The session's website permission decisions, and the control that records
 * another. Decisions are their own concern: they are the one part of the
 * Emulation the author answers rather than measures, and a denial is as much
 * an answer as a grant ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
const PermissionControls = ({
  applied,
  disabled,
  onPatch,
}: {
  /** Undefined until the interface has read the session's own decisions. */
  readonly applied: readonly PermissionDecision[] | undefined;
  readonly disabled: boolean;
  readonly onPatch: (patch: EmulationPatch) => void;
}) => {
  const [choice, setChoice] = useState<string>(DEFAULT_PERMISSION_CHOICE);
  // A decision sends the whole list, so it waits for the list the session has.
  const unknown = applied === undefined;
  const decisions = applied ?? [];
  const { denied, granted } = decisionLabels(decisions);

  /**
   * Decide the chosen permission for every site in this session. One scope
   * holds one answer, so an earlier context-wide decision about the same
   * permission is replaced rather than joined by a contradicting one.
   *
   * Granting context-wide also drops that permission's origin denials, because
   * Chromium cannot narrow a context-wide grant back down for one site: kept,
   * they would be a decision no Run could reproduce, and the Flow would refuse
   * to save what the session had already applied.
   */
  const decide = (state: PermissionState) => {
    if (unknown) {
      return;
    }
    onPatch({
      permissions: permissionsAfterDecision(decisions, choice, state),
    });
  };

  return (
    <section className="space-y-1.5">
      <h2 className="text-sm font-medium">Permissions</h2>
      {unknown ? (
        <p className="text-muted-foreground text-xs">
          Permission decisions are unavailable for this session.
        </p>
      ) : null}
      {granted.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Granted: {granted.join(", ")}
        </p>
      )}
      {denied.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Denied: {denied.join(", ")}
        </p>
      )}
      {decisions.length === 0 ? null : (
        <ul className="space-y-1" aria-label="Saved permission decisions">
          {decisions.map((decision, index) => (
            <li
              className="flex items-center justify-between gap-2 text-xs"
              key={`${decision.permission}-${decision.origin ?? "everywhere"}`}
            >
              <span>
                {decisionLabel(decision)} — {decision.state}
              </span>
              <Button
                aria-label={`Remove ${decisionLabel(decision)} permission decision`}
                disabled={disabled || unknown}
                onClick={() => {
                  onPatch({
                    permissions: decisions.filter(
                      (_decision, decisionIndex) => decisionIndex !== index
                    ),
                  });
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Select
          disabled={disabled || unknown}
          onValueChange={(name) => {
            if (name !== null) {
              setChoice(name);
            }
          }}
          value={choice}
        >
          <SelectTrigger aria-label="Permission" className="flex-1" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {DECIDABLE_PERMISSIONS.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={disabled || unknown}
          onClick={() => decide("granted")}
          size="sm"
          type="button"
          variant="secondary"
        >
          Grant
        </Button>
        <Button
          disabled={disabled || unknown}
          onClick={() => decide("denied")}
          size="sm"
          type="button"
          variant="secondary"
        >
          Deny
        </Button>
        {decisions.length === 0 ? null : (
          <Button
            disabled={disabled || unknown}
            onClick={() => onPatch({ permissions: null })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear all
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Context-wide decisions apply to every site; origin-scoped decisions
        apply only to their named site. Denying makes a site observe refusal
        rather than a prompt.
      </p>
    </section>
  );
};

const EmulationPickerContent = ({
  applied,
  currentOrigin,
  disabled,
  onPatch,
}: EmulationPickerProps) => {
  const [colorScheme, setColorScheme] = useState("");
  const [latitude, setLatitude] = useState("");
  const [locale, setLocale] = useState("");
  const [longitude, setLongitude] = useState("");
  const [pendingLocation, setPendingLocation] = useAtom(
    PendingLocationAtom.use()
  );
  const [timezoneId, setTimezoneId] = useState("");
  const [validationError, setValidationError] = useState<string | undefined>();

  const appliedEmulation =
    applied.status === "known" ? applied.emulation : undefined;
  const appliedLocation = appliedEmulation?.geolocation;

  const applyLocation = () => {
    const parsedLatitude = parseCoordinate(latitude, LATITUDE_BOUND);
    const parsedLongitude = parseCoordinate(longitude, LONGITUDE_BOUND);
    if (parsedLatitude === undefined || parsedLongitude === undefined) {
      setValidationError(
        `Latitude must be between -${LATITUDE_BOUND} and ${LATITUDE_BOUND}, longitude between -${LONGITUDE_BOUND} and ${LONGITUDE_BOUND}.`
      );
      return;
    }
    if (appliedEmulation?.permissions === undefined) {
      setValidationError(
        "Permission decisions are still loading. Try applying the location again."
      );
      return;
    }
    setValidationError(undefined);
    const geolocation = {
      latitude: parsedLatitude,
      longitude: parsedLongitude,
    };
    const hasMatchingDecision = appliedEmulation.permissions.some((decision) =>
      permissionDecisionMatches("geolocation", decision, currentOrigin)
    );
    if (hasMatchingDecision) {
      // Both values travel in one request, so the browser never observes only
      // one coordinate from an edit. Existing matching decisions are retained.
      onPatch({ geolocation });
      return;
    }
    setPendingLocation({ geolocation, origin: currentOrigin });
  };

  const applyPendingLocation = (
    state: PermissionState,
    scope: LocationScope
  ) => {
    if (
      pendingLocation === null ||
      appliedEmulation?.permissions === undefined
    ) {
      return;
    }
    const origin = scope === "origin" ? pendingLocation.origin : undefined;
    onPatch({
      geolocation: pendingLocation.geolocation,
      permissions: permissionsAfterDecision(
        appliedEmulation.permissions,
        "geolocation",
        state,
        origin
      ),
    });
    setPendingLocation(null);
  };

  const clearLocation = () => {
    setValidationError(undefined);
    setLatitude("");
    setLongitude("");
    onPatch({ geolocation: null });
  };

  const useCurrentLocation = () => {
    setValidationError(undefined);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The host browser asked for consent; filling the fields changes
        // nothing about the session until they are applied.
        setLatitude(String(position.coords.latitude));
        setLongitude(String(position.coords.longitude));
      },
      (error) => {
        setValidationError(`Could not read your location: ${error.message}`);
      },
      { timeout: 10_000 }
    );
  };

  const applyLocale = () => {
    const trimmed = locale.trim();
    onPatch({ locale: trimmed.length === 0 ? null : trimmed });
  };

  const applyTimezone = () => {
    const trimmed = timezoneId.trim();
    onPatch({ timezoneId: trimmed.length === 0 ? null : trimmed });
  };

  const applyColorScheme = (value: string) => {
    setColorScheme(value);
    if (value === "light" || value === "dark") {
      onPatch({ colorScheme: value });
    } else {
      onPatch({ colorScheme: null });
    }
  };

  return (
    <>
      <Popover>
        <PopoverTrigger
          render={(props) => (
            <Button
              {...props}
              aria-label="Emulation"
              disabled={disabled}
              size="sm"
              variant="outline"
            >
              <MapPinIcon />
              <span className="hidden xl:inline">Emulation</span>
            </Button>
          )}
        />
        <PopoverContent align="start" className="w-80 gap-3">
          <section className="space-y-1.5">
            <h2 className="text-sm font-medium">Location</h2>
            {appliedLocation === undefined ? null : (
              <p className="text-muted-foreground text-xs tabular-nums">
                Applied: {appliedLocation.latitude}, {appliedLocation.longitude}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Input
                aria-label="Latitude"
                className="h-7 flex-1 text-center tabular-nums"
                disabled={disabled}
                inputMode="decimal"
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="Latitude"
                value={latitude}
              />
              <span
                aria-hidden="true"
                className="text-muted-foreground text-sm"
              >
                ,
              </span>
              <Input
                aria-label="Longitude"
                className="h-7 flex-1 text-center tabular-nums"
                disabled={disabled}
                inputMode="decimal"
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="Longitude"
                value={longitude}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                disabled={disabled}
                onClick={applyLocation}
                size="sm"
                type="button"
                variant="secondary"
              >
                Apply
              </Button>
              <Button
                disabled={disabled}
                onClick={useCurrentLocation}
                size="sm"
                type="button"
                variant="ghost"
              >
                Use my location
              </Button>
              {appliedLocation === undefined ? null : (
                <Button
                  disabled={disabled}
                  onClick={clearLocation}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </Button>
              )}
            </div>
          </section>

          <PermissionControls
            applied={appliedEmulation?.permissions}
            disabled={disabled}
            onPatch={onPatch}
          />

          <section className="space-y-1.5">
            <h2 className="text-sm font-medium">Environment</h2>
            <div className="flex items-center gap-1.5">
              <Input
                aria-label="Locale"
                className="h-7 flex-1"
                disabled={disabled}
                onBlur={applyLocale}
                onChange={(event) => setLocale(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Locale (de-DE)"
                value={locale}
              />
              <Input
                aria-label="Time zone"
                className="h-7 flex-1"
                disabled={disabled}
                onBlur={applyTimezone}
                onChange={(event) => setTimezoneId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Time zone (Europe/Berlin)"
                value={timezoneId}
              />
            </div>
            <Select
              disabled={disabled}
              onValueChange={(value) => {
                if (value !== null) {
                  applyColorScheme(value);
                }
              }}
              value={colorScheme}
            >
              <SelectTrigger
                aria-label="Colour scheme"
                className="w-full"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="">No preference</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {validationError === undefined ? null : (
            <p className="text-destructive text-xs" role="alert">
              {validationError}
            </p>
          )}
        </PopoverContent>
      </Popover>
      {pendingLocation === null ? null : (
        <LocationPermissionDialog
          key={`${pendingLocation.origin ?? "context"}-${pendingLocation.geolocation.latitude}-${pendingLocation.geolocation.longitude}`}
          location={pendingLocation}
          onApply={applyPendingLocation}
          onCancel={() => setPendingLocation(null)}
        />
      )}
    </>
  );
};

const EmulationPicker = (props: EmulationPickerProps) => (
  <PendingLocationAtom.Provider>
    <EmulationPickerContent {...props} />
  </PendingLocationAtom.Provider>
);

export { EmulationPicker };
