import { CircleQuestionMarkIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/**
 * Opens the CLI-served `/docs` site in a new tab, so a live session view
 * stays open beside it. It sits with the theme control on every header.
 */
const DocsLink = ({ className }: { readonly className?: string }) => (
  <a
    aria-label="Docs (opens in a new tab)"
    className={buttonVariants({ className, size: "icon", variant: "outline" })}
    data-slot="button"
    href="/docs"
    rel="noopener"
    target="_blank"
    title="Docs"
  >
    <CircleQuestionMarkIcon aria-hidden="true" />
  </a>
);

export { DocsLink };
