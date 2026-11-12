import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** Native conditions can be supplied now or authored from the Teaching Recording. */
export const NativeOptionalSteps = ({
  children,
}: {
  readonly children: ReactNode;
}) => (
  <Collapsible className="space-y-4">
    <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4">
      Optional steps
      <ChevronDownIcon aria-hidden="true" className="size-4" />
    </CollapsibleTrigger>
    <CollapsibleContent keepMounted className="space-y-4">
      <p className="text-muted-foreground text-xs">
        Leave these empty for the agent to choose conditions from the Teaching
        Recording.
      </p>
      {children}
    </CollapsibleContent>
  </Collapsible>
);
