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
  usePart(dismissableLayer, "anchor", { open: true }, undefined, "span");

const prependAnchor =
  (
    children: DismissableLayerProps["children"]
  ): ((state: DismissableLayerRootState) => ReactNode) =>
  (state) => (
    <>
      {state.open ? <DismissableLayerAnchor /> : null}
      {Predicate.isFunction(children) ? children(state) : children}
    </>
  );

const DismissableLayer = ({
  children,
  contains,
  debug,
  dismissOnOutsidePress,
  onDismiss,
  open,
  render,
  restoreFocus,
  scope,
  ...props
}: DismissableLayerProps) => {
  const baseOptions = {
    contains,
    dismissOnOutsidePress,
    onDismiss,
    open,
    restoreFocus,
    scope,
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
  DismissableLayerDetails,
  DismissableLayerDismissReason,
  DismissableLayerOptions,
  DismissableLayerRootState,
  DismissableLayerScope,
} from "./dismissable-layer-primitive";
