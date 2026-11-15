import type {
  NativeEmulation,
  NativeEmulationChange,
} from "@contingency/protocol";

/** The changes that bring a device to a whole starting Emulation. */
export const emulationChanges = (
  emulation: NativeEmulation
): readonly NativeEmulationChange[] => [
  { _tag: "orientation", orientation: emulation.orientation },
  { _tag: "appearance", appearance: emulation.appearance },
  ...(emulation.location === null
    ? []
    : [{ _tag: "location" as const, ...emulation.location }]),
];

/** How a Teaching step names an Emulation change, with its exact value. */
export const emulationDescription = (change: NativeEmulationChange) => {
  // All change variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (change._tag) {
    case "orientation": {
      return `Rotate to ${change.orientation}`;
    }
    case "appearance": {
      return `Switch to ${change.appearance} appearance`;
    }
    case "location": {
      return `Set location to ${change.latitude}, ${change.longitude}`;
    }
  }
};
