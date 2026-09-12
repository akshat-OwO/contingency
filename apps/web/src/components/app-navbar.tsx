import { Link, useMatchRoute } from "@tanstack/react-router";

import { ModeToggle } from "@/components/mode-toggle";
import { buttonVariants } from "@/components/ui/button";

const AppNavbar = () => {
  const matchRoute = useMatchRoute();
  const isWorkspace = Boolean(matchRoute({ fuzzy: false, to: "/" }));

  return (
    <header className="grid h-14 grid-cols-[1fr_auto_1fr] items-center border-b px-4 sm:px-6">
      <Link
        className="w-fit text-base font-semibold tracking-tight"
        to="/"
        search={{ run: undefined, session: undefined }}
      >
        Contingency
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

      <div className="justify-self-end">
        <ModeToggle />
      </div>
    </header>
  );
};

export { AppNavbar };
