import {
  Tree as TreePrimitive,
  TreeGroup as TreeGroupPrimitive,
  TreeItem as TreeItemPrimitive,
  TreeItemIndicator as TreeItemIndicatorPrimitive,
  TreeItemLabel as TreeItemLabelPrimitive,
} from "@ui-sdk/react/tree";
import { Children, isValidElement } from "react";
import type * as React from "react";

import { cn } from "@/lib/utils";

const classOf = (className: unknown): string | undefined =>
  typeof className === "string" ? className : undefined;

function Tree({
  className,
  ...props
}: React.ComponentProps<typeof TreePrimitive>) {
  return (
    <TreePrimitive
      data-slot="tree"
      className={cn("grid gap-px", classOf(className))}
      {...props}
    />
  );
}

/**
 * UI SDK makes an item a branch when a `TreeGroup` is among its children, by
 * component identity. This facade wraps that group, so the item tells it.
 */
const holdsGroup = (children: React.ReactNode): boolean =>
  Children.toArray(children).some(
    (child) => isValidElement(child) && child.type === TreeGroup
  );

function TreeItem({
  branch,
  children,
  className,
  ...props
}: React.ComponentProps<typeof TreeItemPrimitive>) {
  const isBranch =
    branch ?? (typeof children !== "function" && holdsGroup(children));
  return (
    <TreeItemPrimitive
      {...(isBranch ? { branch: true } : {})}
      data-slot="tree-item"
      className={cn("outline-none", classOf(className))}
      {...props}
    >
      {children}
    </TreeItemPrimitive>
  );
}

/**
 * One row. It indents by `--tree-level`, and shows the selection and focus
 * ring of the item it labels. UI SDK puts `data-selected=""` on the item, so
 * the row reads it from its parent.
 */
function TreeItemLabel({
  className,
  ...props
}: React.ComponentProps<typeof TreeItemLabelPrimitive>) {
  return (
    <TreeItemLabelPrimitive
      data-slot="tree-item-label"
      className={cn(
        "hover:bg-island-hover flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[10px] pr-2 pl-[calc(0.5rem+(var(--tree-level,1)-1)*18px)] text-left text-[13.5px]",
        // Selection and focus belong to the item around the row; a nested
        // item's row must not light up with its ancestor's.
        "[[data-selected]>&]:bg-brand/14 [[data-selected]>&]:ring-brand/30 [[data-selected]>&]:ring-1 [[data-selected]>&]:ring-inset",
        "[:focus-visible>&]:outline-brand [:focus-visible>&]:outline-2 [:focus-visible>&]:-outline-offset-2",
        classOf(className)
      )}
      {...props}
    />
  );
}

function TreeItemIndicator({
  className,
  ...props
}: React.ComponentProps<typeof TreeItemIndicatorPrimitive>) {
  return (
    <TreeItemIndicatorPrimitive
      data-slot="tree-item-indicator"
      className={cn(
        "text-muted-foreground inline-grid w-3.5 [&_svg]:size-[13px] [&_svg]:transition-[rotate] [&_svg]:duration-200 [[aria-expanded=true]>*>&_svg]:rotate-90",
        classOf(className)
      )}
      {...props}
    />
  );
}

function TreeGroup({
  className,
  ...props
}: React.ComponentProps<typeof TreeGroupPrimitive>) {
  return (
    <TreeGroupPrimitive
      data-slot="tree-group"
      className={cn("grid gap-px", classOf(className))}
      {...props}
    />
  );
}

export { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel };
