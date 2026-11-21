import { useState } from "react";

import { devtoolsFieldClassName } from "@/components/browser/devtools-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LATITUDE_BOUND = 90;
const LONGITUDE_BOUND = 180;

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
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
 * Latitude and longitude, applied together, with the host's own location as
 * a shortcut. The browser's Emulation and a native device's settings share
 * it; each decides what applying a location means.
 */
export const LocationFields = ({
  applied,
  disabled,
  onApply,
  onClear,
  onError,
}: {
  /** The location in effect, if any. */
  readonly applied: Coordinates | null | undefined;
  readonly disabled: boolean;
  readonly onApply: (location: Coordinates) => void;
  /** Offered only while a location is applied. */
  readonly onClear?: (() => void) | undefined;
  /** A validation or lookup error to show, or undefined to clear it. */
  readonly onError: (message?: string) => void;
}) => {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  const apply = () => {
    const parsedLatitude = parseCoordinate(latitude, LATITUDE_BOUND);
    const parsedLongitude = parseCoordinate(longitude, LONGITUDE_BOUND);
    if (parsedLatitude === undefined || parsedLongitude === undefined) {
      onError(
        `Latitude must be between -${LATITUDE_BOUND} and ${LATITUDE_BOUND}, longitude between -${LONGITUDE_BOUND} and ${LONGITUDE_BOUND}.`
      );
      return;
    }
    onError();
    onApply({ latitude: parsedLatitude, longitude: parsedLongitude });
  };

  const useCurrentLocation = () => {
    onError();
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The host browser asked for consent; filling the fields changes
        // nothing until they are applied.
        setLatitude(String(position.coords.latitude));
        setLongitude(String(position.coords.longitude));
      },
      (error) => {
        onError(`Could not read your location: ${error.message}`);
      },
      { timeout: 10_000 }
    );
  };

  const clear = () => {
    onError();
    setLatitude("");
    setLongitude("");
    onClear?.();
  };

  return (
    <>
      {applied === null || applied === undefined ? null : (
        <p className="text-muted-foreground text-xs tabular-nums">
          Applied: {applied.latitude}, {applied.longitude}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0 space-y-1 text-xs">
          <span>Latitude</span>
          <Input
            variant="compact"
            aria-label="Latitude"
            className={cn(devtoolsFieldClassName, "font-mono tabular-nums")}
            disabled={disabled}
            inputMode="decimal"
            onChange={(event) => setLatitude(event.target.value)}
            placeholder="52.52"
            value={latitude}
          />
        </label>
        <label className="block min-w-0 space-y-1 text-xs">
          <span>Longitude</span>
          <Input
            variant="compact"
            aria-label="Longitude"
            className={cn(devtoolsFieldClassName, "font-mono tabular-nums")}
            disabled={disabled}
            inputMode="decimal"
            onChange={(event) => setLongitude(event.target.value)}
            placeholder="13.405"
            value={longitude}
          />
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={disabled}
          onClick={apply}
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
        {onClear === undefined ||
        applied === null ||
        applied === undefined ? null : (
          <Button
            disabled={disabled}
            onClick={clear}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
        )}
      </div>
    </>
  );
};
