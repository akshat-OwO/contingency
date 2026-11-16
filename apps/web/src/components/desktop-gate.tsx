import { useSyncExternalStore } from "react";

import { WatcherMark } from "@/components/brand";

/** Narrower than this, the Workspace cannot fit a stage beside its chrome. */
const NARROW_QUERY = "(max-width: 1023.98px)";

const narrowQuery = (): MediaQueryList | undefined =>
  globalThis.matchMedia?.(NARROW_QUERY);

const subscribe = (onChange: () => void) => {
  const query = narrowQuery();
  query?.addEventListener("change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
  };
};

/**
 * Whether the window is wide enough for the Workspace. A browser without
 * `matchMedia` counts as a desktop, so nothing is hidden where it cannot ask.
 */
export const useDesktopViewport = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => narrowQuery()?.matches !== true,
    () => true
  );

/**
 * The Workspace drives browsers, emulators and simulators beside its chrome,
 * so below 1024px it is replaced by one notice rather than squeezed. That
 * includes a `?session=` link opened on a phone.
 */
export const DesktopGate = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => {
  const desktop = useDesktopViewport();
  if (desktop) {
    return children;
  }
  return (
    <main className="workspace-canvas grid h-svh place-items-center p-4">
      <section
        aria-labelledby="desktop-gate-title"
        className="island grid max-w-sm justify-items-center gap-2.5 rounded-[28px] px-6 py-7 text-center"
        role="alert"
      >
        <WatcherMark className="text-island-brand h-[22px]" />
        <h1
          className="mt-1.5 text-xl font-semibold tracking-[-0.02em]"
          id="desktop-gate-title"
        >
          Open Contingency on a desktop
        </h1>
        <p className="text-muted-foreground text-sm text-pretty">
          The Workspace drives browsers, emulators and simulators side by side.
          It needs a screen at least 1024 pixels wide.
        </p>
      </section>
    </main>
  );
};
