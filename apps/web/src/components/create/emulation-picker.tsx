import type { PermissionGrant, SessionEmulation } from "@contingency/protocol";
import { MapPinIcon } from "lucide-react";
import { useState } from "react";

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
 * The website permissions Create View offers by name, mapped to what Chromium
 * grants. Geolocation leads because an emulated location only reaches a site
 * that asks when its permission is genuinely granted ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
const GRANTABLE_PERMISSIONS = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "clipboard-read",
] as const;

const LATITUDE_BOUND = 90;
const LONGITUDE_BOUND = 180;
/** The permission the grant Select opens on; choosing any option grants it. */
const DEFAULT_PERMISSION_CHOICE = "geolocation";

export interface EmulationPatch {
  readonly colorScheme?: "light" | "dark" | null;
  readonly geolocation?: {
    readonly accuracy?: number;
    readonly latitude: number;
    readonly longitude: number;
  } | null;
  readonly locale?: string | null;
  readonly permissions?: readonly PermissionGrant[] | null;
  readonly timezoneId?: string | null;
}

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
  const appliedPermissions = appliedEmulation?.permissions ?? [];
  // Granting sends the whole list, so it waits for the list the session has.
  const permissionsUnknown = appliedEmulation === undefined;

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

  const grantPermission = (name: string) => {
    if (permissionsUnknown) {
      return;
    }
    if (
      appliedPermissions.some(
        (grant) => grant.origin === undefined && grant.permission === name
      )
    ) {
      return;
    }
    onPatch({
      permissions: [...appliedPermissions, { permission: name }],
    });
  };

  const clearPermissions = () => {
    onPatch({ permissions: null });
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

        <section className="space-y-1.5">
          <h2 className="text-sm font-medium">Permissions</h2>
          {permissionsUnknown ? (
            <p className="text-muted-foreground text-xs">
              Granted permissions are unavailable for this session.
            </p>
          ) : null}
          {appliedPermissions.length === 0 ? null : (
            <p className="text-muted-foreground text-xs">
              Granted:{" "}
              {appliedPermissions.map((grant) => grant.permission).join(", ")}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <Select
              disabled={disabled || permissionsUnknown}
              onValueChange={(name) => {
                if (name !== null) {
                  grantPermission(name);
                }
              }}
              value={DEFAULT_PERMISSION_CHOICE}
            >
              <SelectTrigger
                aria-label="Permission to grant"
                className="flex-1"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {GRANTABLE_PERMISSIONS.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {appliedPermissions.length === 0 ? null : (
              <Button
                onClick={clearPermissions}
                size="sm"
                type="button"
                variant="ghost"
              >
                Clear all
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Choosing a permission grants it to every site in this session.
          </p>
        </section>

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
