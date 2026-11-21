import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from "@ui-sdk/react/collapsible";
import type * as React from "react";

const Collapsible = (
  props: React.ComponentProps<typeof CollapsiblePrimitive>
) => <CollapsiblePrimitive data-slot="collapsible" {...props} />;

const CollapsibleTrigger = (
  props: React.ComponentProps<typeof CollapsibleTriggerPrimitive>
) => <CollapsibleTriggerPrimitive data-slot="collapsible-trigger" {...props} />;

const CollapsibleContent = (
  props: React.ComponentProps<typeof CollapsiblePanel>
) => (
  // The panel writes its own data-slot over a passed one, so the facade sets
  // it on the rendered element to keep the Base UI name.
  <CollapsiblePanel
    render={(panelProps) => (
      <div {...panelProps} data-slot="collapsible-content" />
    )}
    {...props}
  />
);

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
