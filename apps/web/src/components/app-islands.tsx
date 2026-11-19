import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { islandControlClassName } from "@/components/agent/workspace-home-nav";
import { WatcherMark } from "@/components/brand";
import { FlowsButton } from "@/components/catalog/flows-button";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A link to the Workspace home. Inside the router it navigates in a View
 * Transition without a reload; outside it, as in component tests, it is a
 * plain link.
 */
const HomeLink = ({
  children,
  className,
  label,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly label?: string;
}) => {
  // SAFETY: with `warn: false`, useRouter returns the context value as is,
  // which is null outside a RouterProvider, as in component tests.
  const router = useRouter({ warn: false }) as ReturnType<
    typeof useRouter
  > | null;
  return (
    // oxlint-disable-next-line react-doctor/no-prevent-default -- Inside the router the home opens without a reload.
    <a
      aria-label={label}
      className={className}
      href="/"
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
        void router.navigate({
          search: { run: undefined, session: undefined },
          to: "/",
          viewTransition: true,
        });
      }}
    >
      {children}
    </a>
  );
};

/**
 * The two top islands every page without a session dock carries (#779): the
 * way home at the top left, and Flows, Docs and the theme at the top right.
 * They replace the header band.
 */
export const AppIslands = () => (
  <>
    <nav
      aria-label="Workspace"
      className="island absolute top-4 left-4 z-10 flex items-center p-1.5"
    >
      <HomeLink
        className="hover:bg-island-hover inline-flex items-center gap-2 rounded-[14px] px-2.5 py-1.5"
        label="Contingency home"
      >
        <WatcherMark className="text-island-brand" data-vt="brand-mark" />
        <span className="text-[15px] font-semibold tracking-[-0.04em] lowercase">
          Contingency
        </span>
      </HomeLink>
    </nav>
    <div className="island absolute top-4 right-4 z-10 flex items-center gap-1 p-1.5">
      <FlowsButton className="text-muted-foreground hover:bg-island-hover hover:text-foreground h-[34px] gap-[7px] rounded-xl px-3 text-sm" />
      <DocsLink className={islandControlClassName} />
      <ModeToggle className={islandControlClassName} />
    </div>
  </>
);

/** The one way out of a page that has nothing to show. */
export const GoToWorkspace = () => (
  <HomeLink className={cn(buttonVariants({ size: "island-lg" }), "mt-3")}>
    Go to the Workspace
  </HomeLink>
);

/**
 * A page with nothing to dock: an unknown route, the Workspace while it looks
 * for sessions, and a session link that no longer resolves. One card floats
 * on the canvas under the app islands; `island` frames it.
 */
export const StatusPage = ({
  busy = false,
  children,
  island = true,
}: {
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly island?: boolean;
}) => (
  <div className="workspace-canvas fixed inset-0">
    <AppIslands />
    <main
      aria-busy={busy || undefined}
      aria-live={busy ? "polite" : undefined}
      className="absolute inset-0 grid [place-items:safe_center] overflow-y-auto px-6 pt-22 pb-6"
    >
      <section
        className={cn(
          "grid w-full max-w-110 justify-items-center gap-2 text-center",
          island && "island px-7 pt-7 pb-6"
        )}
      >
        {children}
      </section>
    </main>
  </div>
);
