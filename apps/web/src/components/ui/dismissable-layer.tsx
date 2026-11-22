"use client";

import { createParts } from "@ui-sdk/react/primitive";

import { dismissableLayer } from "./dismissable-layer-primitive";

const { Root: DismissableLayer } = createParts(dismissableLayer, {
  root: "div",
});

export { DismissableLayer };
export { dismissableLayer } from "./dismissable-layer-primitive";
export type {
  DismissableLayerCloseReason,
  DismissableLayerDetails,
  DismissableLayerDismissReason,
  DismissableLayerOpenChangeDetails,
  DismissableLayerOptions,
  DismissableLayerRootState,
} from "./dismissable-layer-primitive";
