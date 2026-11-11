import { useAtomValue } from "@effect/atom-react";
import { Link, useMatchRoute } from "@tanstack/react-router";

import { workspaceChromeAtom } from "@/components/agent/agent-workspace-state";
import { Wordmark } from "@/components/brand";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";
import { buttonVariants } from "@/components/ui/button";

const AppNavbar = () => {
  const matchRoute = useMatchRoute();
  const isWorkspace = Boolean(matchRoute({ fuzzy: false, to: "/" }));
  // The Workspace chrome owns the whole viewport and carries the wordmark in
  // its dock, so the header band steps aside rather than stacking above it.
  const chrome = useAtomValue(workspaceChromeAtom);

  if (chrome) {
    return null;
  }

  return (
    <header className="grid h-14 grid-cols-[1fr_auto_1fr] items-center border-b px-4 sm:px-6">
      <Link
        className="flex w-fit"
        to="/"
        search={{ run: undefined, session: undefined }}
      >
        <Wordmark />
      </Link>

      <nav aria-label="Primary navigation">
        <Link
          aria-current={isWorkspace ? "page" : undefined}
          className={buttonVariants({
            variant: isWorkspace ? "default" : "outline",
          })}
          data-slot="button"
          to="/"
          search={{ run: undefined, session: undefined }}
        >
          Workspace
        </Link>
      </nav>

      <div
        id="workspace-header-actions"
        className="flex items-center gap-1.5 justify-self-end"
      >
        <DocsLink />
        <ModeToggle />
      </div>
    </header>
  );
};

export { AppNavbar };
