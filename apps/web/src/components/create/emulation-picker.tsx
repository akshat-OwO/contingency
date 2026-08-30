import type {
  PermissionDecision,
  PermissionState,
  SessionEmulation,
} from "@contingency/protocol";
import { MapPinIcon } from "lucide-react";
import { useState } from "react";

import type { EmulationPatch } from "@/components/create/emulation-draft";
import { Button } from "@/components/ui/button";
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
 * The website permissions Create View can decide by name. Geolocation leads
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

/**
 * What the interface knows about a session's Emulation. "Unknown" is a state of
 * its own rather than an empty Emulation: a patch replaces the whole permission
 * list, so a client that has not read the session's own list must not send one.
 */
/** How a decision reads back, so an origin-scoped one is not read as global. */
const decisionLabel = (decision: PermissionDecision): string =>
  decision.origin === undefined
    ? decision.permission
    : `${decision.permission} (${decision.origin})`;

/** The decisions as they read back, split by the answer each one records. */
const decisionLabels = (
  decisions: readonly PermissionDecision[]
): {
  readonly denied: readonly string[];
  readonly granted: readonly string[];
} => {
  const denied: string[] = [];
  const granted: string[] = [];
  for (const decision of decisions) {
    (decision.state === "granted" ? granted : denied).push(
      decisionLabel(decision)
    );
  }
  return { denied, granted };
};

export type SessionEmulationState =
  | { readonly status: "unknown" }
  | { readonly status: "known"; readonly emulation: SessionEmulation };

interface EmulationPickerProps {
  /** The Emulation the session applies, once the interface has read it. */
  readonly applied: SessionEmulationState;
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
const PermissionDecisions = ({
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
   */
  const decide = (state: PermissionState) => {
    if (unknown) {
      return;
    }
    const kept = decisions.filter(
      (decision) =>
        decision.origin !== undefined || decision.permission !== choice
    );
    onPatch({ permissions: [...kept, { permission: choice, state }] });
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
        A decision applies to every site in this session. Denying makes a site
        observe refusal rather than a prompt.
      </p>
    </section>
  );
};

const EmulationPicker = ({
  applied,
  disabled,
  onPatch,
}: EmulationPickerProps) => {
  const [colorScheme, setColorScheme] = useState("");
  const [latitude, setLatitude] = useState("");
  const [locale, setLocale] = useState("");
  const [longitude, setLongitude] = useState("");
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
    setValidationError(undefined);
    // Both values travel in one request, so the browser never observes only
    // one coordinate from an edit.
    onPatch({
      geolocation: {
        latitude: parsedLatitude,
        longitude: parsedLongitude,
      },
    });
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
              inputMode="decimal"
              onChange={(event) => setLatitude(event.target.value)}
              placeholder="Latitude"
              value={latitude}
            />
            <span aria-hidden="true" className="text-muted-foreground text-sm">
              ,
            </span>
            <Input
              aria-label="Longitude"
              className="h-7 flex-1 text-center tabular-nums"
              inputMode="decimal"
              onChange={(event) => setLongitude(event.target.value)}
              placeholder="Longitude"
              value={longitude}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              onClick={applyLocation}
              size="sm"
              type="button"
              variant="secondary"
            >
              Apply
            </Button>
            <Button
              onClick={useCurrentLocation}
              size="sm"
              type="button"
              variant="ghost"
            >
              Use my location
            </Button>
            {appliedLocation === undefined ? null : (
              <Button
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

        <PermissionDecisions
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
  );
};

export { EmulationPicker };
