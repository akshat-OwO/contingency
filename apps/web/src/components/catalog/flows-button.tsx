import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { BookOpenIcon } from "lucide-react";

import type { FlowsSessionView } from "@/components/catalog/flows-page-state";
import {
  flowCount,
  flowsOriginAtom,
} from "@/components/catalog/flows-page-state";
import { buttonVariants } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";
import { canViewTransition, nameForTransition } from "@/lib/view-transition";

/**
 * The way to the Flows page, in the top-right island of every view (#755). It
 * stays available while a session records: the Workspace never blocks
 * navigation, and the session keeps recording. Opening the page, the link
 * grows into the page's catalog sidebar.
 */
export const FlowsButton = ({
  className,
  session,
}: {
  readonly className?: string;
  /** The session it is pressed in, whose Flow the page opens on. */
  readonly session?: FlowsSessionView | undefined;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const result = useAtomValue(catalogBrowseAtom);
  const setOrigin = useAtomSet(flowsOriginAtom);
  // The Workspace's own component tests render it without a router; it is
  // then a plain link.
  // SAFETY: with `warn: false`, useRouter returns the context value as is,
  // which is null outside a RouterProvider.
  const router = useRouter({ warn: false }) as ReturnType<
    typeof useRouter
  > | null;
  const here = router?.state.location.pathname === "/flow";
  const count =
    result._tag === "Success" ? flowCount(result.value.roots) : undefined;
  return (
    // oxlint-disable-next-line react-doctor/no-prevent-default -- The page opens through the router inside a View Transition.
    <a
      aria-current={here ? "page" : undefined}
      aria-label={count === undefined ? "Flows" : `Flows, ${count}`}
      className={cn(
        buttonVariants({ size: "sm", variant: "ghost" }),
        className,
        here && "bg-island-hover text-foreground"
      )}
      // On the page itself the sidebar holds the name, so the link gives it
      // up while it is there.
      data-vt={here ? undefined : "flows-sidebar"}
      href="/flow"
      onClick={(event) => {
        if (
          router === null ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        if (here) {
          return;
        }
        setOrigin(session ?? null);
        if (canViewTransition()) {
          nameForTransition(event.currentTarget, "flows-sidebar");
        }
        void router.navigate({ to: "/flow", viewTransition: true });
      }}
      title={
        count === undefined
          ? undefined
          : `${count} saved ${count === 1 ? "Flow" : "Flows"}`
      }
    >
      <BookOpenIcon aria-hidden="true" />
      <span>Flows</span>
      {count === undefined ? null : (
        <span className="bg-muted text-foreground grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] leading-none font-medium tabular-nums">
          {count}
        </span>
      )}
    </a>
  );
};
