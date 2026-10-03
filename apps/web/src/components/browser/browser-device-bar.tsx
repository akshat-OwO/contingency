import type { Viewport } from "@contingency/protocol";
import {
  LockKeyholeIcon,
  MonitorIcon,
  RotateCcwSquareIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";

import {
  devicePresets,
  RESPONSIVE_PRESET_ID,
} from "@/components/browser/browser-device-presets";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type DeviceKind = "desktop" | "phone" | "tablet";

/** The widest CSS viewport still drawn as a phone, and then as a tablet. */
const PHONE_MAX_WIDTH = 480;
const TABLET_MAX_WIDTH = 1100;

const deviceKind = (width: number): DeviceKind => {
  if (width <= PHONE_MAX_WIDTH) {
    return "phone";
  }
  if (width <= TABLET_MAX_WIDTH) {
    return "tablet";
  }
  return "desktop";
};

const DeviceIcon = ({ kind }: { readonly kind: DeviceKind }) => {
  if (kind === "phone") {
    return <SmartphoneIcon aria-hidden="true" />;
  }
  if (kind === "tablet") {
    return <TabletIcon aria-hidden="true" />;
  }
  return <MonitorIcon aria-hidden="true" />;
};

const groupLabels: Readonly<Record<DeviceKind, string>> = {
  desktop: "Displays",
  phone: "Phones",
  tablet: "Tablets",
};

type DevicePreset = (typeof devicePresets)[number];

/** The presets by the kind of device they draw as, in menu order. */
const presetGroups: readonly {
  readonly kind: DeviceKind;
  readonly label: string;
  readonly presets: DevicePreset[];
}[] = (["phone", "tablet", "desktop"] as const).map((kind) => ({
  kind,
  label: groupLabels[kind],
  presets: [],
}));

for (const preset of devicePresets) {
  presetGroups
    .find(({ kind }) => kind === deviceKind(preset.width))
    ?.presets.push(preset);
}

const DEVICE_SCALE_FACTORS = ["1", "2", "3"] as const;

/**
 * The viewport controls of the device stage: the device preset, the applied
 * size, orientation, and pixel ratio. It floats over the stage it sizes, so
 * the browser below keeps the whole column.
 */
export const BrowserDeviceBar = ({
  applied,
  disabled,
  lockedReason,
  onPresetChange,
  onViewportChange,
  presetId,
}: {
  /** The viewport the session applies, once the interface has read it. */
  readonly applied: Viewport | undefined;
  readonly disabled: boolean;
  /** Why the controls are locked, when it is the agent holding the browser. */
  readonly lockedReason: string | undefined;
  readonly onPresetChange: (presetId: string) => void;
  readonly onViewportChange: (viewport: Viewport) => void;
  readonly presetId: string;
}) => {
  const selectedPreset = devicePresets.find(({ id }) => id === presetId);
  const kind =
    applied === undefined || selectedPreset === undefined
      ? "desktop"
      : deviceKind(applied.width);
  const scaleFactor =
    applied === undefined ? undefined : String(applied.deviceScaleFactor);

  return (
    <div
      aria-label="Device controls"
      className="bg-background/90 ring-foreground/10 pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl p-1 text-xs shadow-lg ring-1 backdrop-blur-xl"
      role="toolbar"
    >
      <Select
        disabled={disabled}
        onValueChange={(value) => {
          if (value !== null) {
            onPresetChange(value);
          }
        }}
        value={presetId}
      >
        <SelectTrigger
          aria-label="Device"
          className="h-7 gap-1.5 border-transparent bg-transparent shadow-none dark:bg-transparent [&_svg:not([class*='size-'])]:size-3.5"
          size="sm"
        >
          <DeviceIcon kind={kind} />
          <SelectValue>{selectedPreset?.name ?? "Responsive"}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-64">
          <SelectItem value={RESPONSIVE_PRESET_ID}>Responsive</SelectItem>
          {presetGroups.map((group) => (
            <SelectGroup key={group.kind}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex w-full items-center justify-between gap-3">
                    {preset.name}
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground tabular-nums"
                    >
                      {preset.width}×{preset.height}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {applied === undefined ? null : (
        <>
          <span className="text-muted-foreground px-1.5 whitespace-nowrap tabular-nums">
            {applied.width} × {applied.height}
          </span>
          <Button
            aria-label="Rotate viewport"
            disabled={disabled}
            onClick={() =>
              onViewportChange({
                deviceScaleFactor: applied.deviceScaleFactor,
                height: applied.width,
                width: applied.height,
              })
            }
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <RotateCcwSquareIcon />
          </Button>
          <SegmentedControl
            disabled={disabled}
            label="Device pixel ratio"
            onChange={(value) =>
              onViewportChange({
                deviceScaleFactor: Number(value),
                height: applied.height,
                width: applied.width,
              })
            }
            options={DEVICE_SCALE_FACTORS.map((value) => ({
              label: `${value}×`,
              value,
            }))}
            size="xs"
            value={scaleFactor}
          />
        </>
      )}
      {lockedReason === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            aria-label={lockedReason}
            className="text-muted-foreground grid size-7 place-items-center"
          >
            <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{lockedReason}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
