"use client";

import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import type { PartProps } from "@ui-sdk/react/primitive";
import { Predicate } from "effect";
import { cloneElement, isValidElement } from "react";
import type { ReactNode } from "react";

import { dismissableLayer } from "./dismissable-layer-primitive";
import type {
  DismissableLayerOptions,
  DismissableLayerRootState,
} from "./dismissable-layer-primitive";

export type DismissableLayerProps = DismissableLayerOptions &
  Omit<
    PartProps<"div", DismissableLayerRootState>,
    keyof DismissableLayerOptions
  >;

const DismissableLayerAnchor = () =>
  usePart(dismissableLayer, "anchor", {}, undefined, "span");

const prependAnchor = (
  children: DismissableLayerProps["children"]
): DismissableLayerProps["children"] =>
  Predicate.isFunction(children) ? (
    (state: DismissableLayerRootState) => (
      <>
        <DismissableLayerAnchor />
        {children(state)}
      </>
    )
  ) : (
    <>
      <DismissableLayerAnchor />
      {children}
    </>
  );

const DismissableLayer = ({
  children,
  closeOnBlur,
  contains,
  debug,
  defaultOpen,
  dismissOnOutsidePress,
  modal,
  onDismiss,
  onOpenChange,
  open,
  render,
  restoreFocus,
  scope,
  topLayer,
  ...props
}: DismissableLayerProps) => {
  const baseOptions = {
    closeOnBlur,
    contains,
    defaultOpen,
    dismissOnOutsidePress,
    modal,
    onDismiss,
    onOpenChange,
    open,
    restoreFocus,
    scope,
    topLayer,
  };
  const handle = usePrimitive(
    dismissableLayer,
    debug === undefined ? baseOptions : { ...baseOptions, debug }
  );

  let resolvedRender = render;
  let resolvedChildren = children;
  if (
    resolvedChildren === undefined &&
    isValidElement<{ children?: ReactNode }>(render) &&
    render.props.children !== undefined
  ) {
    resolvedChildren = render.props.children;
    resolvedRender = cloneElement(render, { children: undefined });
  }

  const partProps: PartProps<"div", DismissableLayerRootState> = {
    ...props,
    children: prependAnchor(resolvedChildren),
  };
  if (resolvedRender !== undefined) {
    partProps.render = resolvedRender;
  }

  return usePart(handle, "root", {}, partProps, "div");
};

export { DismissableLayer };
export { dismissableLayer } from "./dismissable-layer-primitive";
export type {
  DismissableLayerCloseReason,
  DismissableLayerDetails,
  DismissableLayerDismissReason,
  DismissableLayerOpenChangeDetails,
  DismissableLayerOptions,
  DismissableLayerRootState,
  DismissableLayerScope,
} from "./dismissable-layer-primitive";
