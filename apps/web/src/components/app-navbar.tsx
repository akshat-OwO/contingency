import { Link, useMatchRoute } from "@tanstack/react-router";

import { ModeToggle } from "@/components/mode-toggle";
import { buttonVariants } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";

const AppNavbar = () => {
  const matchRoute = useMatchRoute();
  const isCreateView = Boolean(matchRoute({ fuzzy: false, to: "/" }));
  const isAuditView = Boolean(matchRoute({ fuzzy: false, to: "/audit" }));

  return (
    <header className="grid h-14 grid-cols-[1fr_auto_1fr] items-center border-b px-4 sm:px-6">
      <Link className="w-fit text-base font-semibold tracking-tight" to="/">
        Contingency
      </Link>

      <nav aria-label="Primary navigation">
        <ButtonGroup>
          <Link
            aria-current={isCreateView ? "page" : undefined}
            className={buttonVariants({
              variant: isCreateView ? "default" : "outline",
            })}
            data-slot="button"
            to="/"
          >
            Create
          </Link>
          <Link
            aria-current={isAuditView ? "page" : undefined}
            className={buttonVariants({
              variant: isAuditView ? "default" : "outline",
            })}
            data-slot="button"
            to="/audit"
          >
            Audit
          </Link>
        </ButtonGroup>
      </nav>

      <div className="justify-self-end">
        <ModeToggle />
      </div>
    </header>
  );
};

export { AppNavbar };
