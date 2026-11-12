import { useContext } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { useIosEntryEnabled } from "./ios-workspace-entry";
import { WorkspacePlatformContext } from "./workspace-platform-state";
import type { WorkspacePlatformTag } from "./workspace-platform-state";

const OPTIONS: readonly {
  readonly tag: WorkspacePlatformTag;
  readonly label: string;
}[] = [
  { label: "Web", tag: "web" },
  { label: "Android", tag: "android" },
  { label: "iOS", tag: "ios" },
];

/**
 * The one switcher between the Workspace's platforms. Every platform renders
 * it in the same place with the same options, so the way back to Web never
 * depends on whether a native session exists yet. iOS is offered only where
 * this process enables it.
 */
export const WorkspacePlatformSwitcher = ({
  className,
}: {
  readonly className?: string;
}) => {
  const context = useContext(WorkspacePlatformContext);
  const ios = useIosEntryEnabled();
  if (context === null) {
    return null;
  }
  const selected = context.platform._tag;
  return (
    <ToggleGroup
      aria-label="Workspace platform"
      className={cn(
        "bg-background/90 rounded-lg border p-0.5 shadow-sm backdrop-blur",
        className
      )}
      onValueChange={(value) => {
        const [next] = value;
        if (next === "web" || next === "android" || next === "ios") {
          context.onSwitch(next);
        }
      }}
      size="sm"
      spacing={0}
      value={[selected]}
    >
      {OPTIONS.filter(
        ({ tag }) => tag !== "ios" || ios || selected === "ios"
      ).map(({ label, tag }) => (
        <ToggleGroupItem
          className="aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground/90 aria-pressed:hover:text-background rounded-md! px-2.5"
          key={tag}
          value={tag}
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

/**
 * The switcher floating at the top centre of a Workspace with no toolbar of
 * its own: the empty canvas and both native platforms.
 */
export const WorkspacePlatformBar = () => (
  <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
    <WorkspacePlatformSwitcher className="pointer-events-auto" />
  </div>
);
