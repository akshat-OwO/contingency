import { useAtom, useAtomValue } from "@effect/atom-react";
import { BookOpenIcon } from "lucide-react";

import {
  flowCount,
  flowsDrawerOpenAtom,
} from "@/components/catalog/flows-drawer-state";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

/**
 * The dock's way into the Flows drawer. It sits beside the session picker,
 * because it is navigation, and leaves the right of the row to the state's
 * own actions. Its label gives way before anything else as the stage narrows.
 */
export const FlowsDockButton = () => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const [open, setOpen] = useAtom(flowsDrawerOpenAtom);
  const result = useAtomValue(catalogBrowseAtom);
  const count =
    result._tag === "Success" ? flowCount(result.value.roots) : undefined;
  return (
    <Button
      aria-expanded={open}
      aria-label={count === undefined ? "Flows" : `Flows, ${count}`}
      className={cn(open && "bg-muted")}
      title={
        count === undefined
          ? undefined
          : `${count} saved ${count === 1 ? "Flow" : "Flows"}`
      }
      onClick={() => {
        setOpen(!open);
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      <BookOpenIcon aria-hidden="true" />
      {/*
        On a narrow stage the word gives way to the session's Flow name and
        the count rides the icon's corner, as on the inspector rail.
      */}
      <span>Flows</span>
      {count === undefined ? null : (
        <span className="bg-muted text-muted-foreground ring-background grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] leading-none font-medium tabular-nums @max-sm:absolute @max-sm:-top-0.5 @max-sm:-right-0.5 @max-sm:ring-2">
          {count}
        </span>
      )}
    </Button>
  );
};
