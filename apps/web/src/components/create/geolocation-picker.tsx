import { isBrowserRpcError } from "@contingency/protocol";
import type { Geolocation } from "@contingency/protocol";
import { Effect } from "effect";
import { LocateFixedIcon, LoaderCircleIcon, MapPinIcon } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

interface GeolocationPickerProps {
  readonly appliedGeolocation: Geolocation | null;
  readonly disabled: boolean;
  readonly onApply: (geolocation: Geolocation) => Promise<void>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Unable to apply the location.";

const parseCoordinate = (
  value: string,
  minimum: number,
  maximum: number
): number | undefined => {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    return undefined;
  }
  const coordinate = Number(trimmed);
  return Number.isFinite(coordinate) &&
    coordinate >= minimum &&
    coordinate <= maximum
    ? coordinate
    : undefined;
};

const getCurrentPosition = Effect.callback<GeolocationPosition, Error>(
  (resume) => {
    if (globalThis.navigator.geolocation === undefined) {
      resume(
        Effect.fail(
          new Error("Current location is unavailable in this browser.")
        )
      );
      return;
    }
    globalThis.navigator.geolocation.getCurrentPosition(
      (position) => resume(Effect.succeed(position)),
      (geolocationError) =>
        resume(
          Effect.fail(
            new Error(
              geolocationError.message ||
                "Unable to obtain the current location."
            )
          )
        ),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10_000,
      }
    );
  }
);

const GeolocationPicker = ({
  appliedGeolocation,
  disabled,
  onApply,
}: GeolocationPickerProps) => {
  const latitudeId = useId();
  const longitudeId = useId();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  const apply = async (geolocation: Geolocation) => {
    setError(undefined);
    setApplying(true);
    try {
      await onApply(geolocation);
    } catch (applyError) {
      setError(errorMessage(applyError));
    } finally {
      setApplying(false);
    }
  };

  const submitCoordinates = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedLatitude = parseCoordinate(latitude, -90, 90);
    const parsedLongitude = parseCoordinate(longitude, -180, 180);
    if (parsedLatitude === undefined || parsedLongitude === undefined) {
      setError(
        "Enter a latitude from -90 to 90 and a longitude from -180 to 180."
      );
      return;
    }
    void apply({ latitude: parsedLatitude, longitude: parsedLongitude });
  };

  const useCurrentLocation = async () => {
    setError(undefined);
    setApplying(true);
    try {
      const position = await Effect.runPromise(getCurrentPosition);
      const geolocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      await onApply(geolocation);
      setLatitude(String(geolocation.latitude));
      setLongitude(String(geolocation.longitude));
    } catch (currentLocationError) {
      setError(errorMessage(currentLocationError));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label="Geolocation emulation"
            disabled={disabled}
            size="sm"
            variant={appliedGeolocation === null ? "outline" : "secondary"}
          />
        }
      >
        <MapPinIcon />
        <span className="hidden xl:inline">Location</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Emulate geolocation</PopoverTitle>
          <PopoverDescription>
            Set coordinates for every tab and site in this browser session.
          </PopoverDescription>
        </PopoverHeader>

        <form className="space-y-3" onSubmit={submitCoordinates}>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor={latitudeId}>Latitude</Label>
              <Input
                autoComplete="off"
                id={latitudeId}
                inputMode="decimal"
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="-90 to 90"
                value={latitude}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={longitudeId}>Longitude</Label>
              <Input
                autoComplete="off"
                id={longitudeId}
                inputMode="decimal"
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="-180 to 180"
                value={longitude}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" disabled={applying} type="submit">
              {applying ? <LoaderCircleIcon className="animate-spin" /> : null}
              Apply
            </Button>
            <Button
              aria-label="Use current location"
              disabled={applying}
              onClick={() => {
                void useCurrentLocation();
              }}
              type="button"
              variant="outline"
            >
              <LocateFixedIcon />
              Current
            </Button>
          </div>
        </form>

        {error === undefined ? null : (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}

        <output aria-live="polite" className="text-muted-foreground text-xs">
          {appliedGeolocation === null
            ? "No location has been applied in this session."
            : `Active: ${appliedGeolocation.latitude}, ${appliedGeolocation.longitude}`}
        </output>

        <p className="text-muted-foreground border-t pt-2 text-xs">
          This changes reported coordinates but does not grant website
          permission. Once applied, close the browser session to clear the
          override.
        </p>
      </PopoverContent>
    </Popover>
  );
};

export { GeolocationPicker };
