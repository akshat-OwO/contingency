import { cn } from "@/lib/utils";

const Eyes = () => (
  <>
    <path d="M14 44L54 58V74H36Z" />
    <path d="M106 44L66 58V74H84Z" />
  </>
);

/**
 * The watcher: two narrowed eyes. It is decorative wherever it appears, since
 * the text beside it carries the name.
 */
export const WatcherMark = ({ className }: { readonly className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("text-brand aspect-[100/38] h-3.5 shrink-0", className)}
    data-slot="watcher-mark"
    fill="currentColor"
    viewBox="10 40 100 38"
  >
    <Eyes />
  </svg>
);

/**
 * The watcher as a loader for waits that own a region: the eyes look left,
 * look right, then blink (`styles.css`). The view box is wider than the mark
 * so the glance stays inside it.
 */
export const WatcherLoader = ({
  className,
}: {
  readonly className?: string;
}) => (
  <svg
    aria-hidden="true"
    className={cn("text-brand aspect-[120/38] h-6 shrink-0", className)}
    data-slot="watcher-loader"
    fill="currentColor"
    viewBox="0 40 120 38"
  >
    <g data-slot="watcher-look">
      <g data-slot="watcher-blink">
        <Eyes />
      </g>
    </g>
  </svg>
);

/**
 * The mark and the name. The text stays "Contingency" for assistive
 * technology and is only drawn lowercase.
 */
export const Wordmark = () => (
  <span className="inline-flex shrink-0 items-center gap-2 text-base font-semibold tracking-[-0.04em]">
    <WatcherMark />
    <span className="lowercase">Contingency</span>
  </span>
);
