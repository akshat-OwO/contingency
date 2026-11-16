import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { HomePlatform } from "./workspace-home-state";

/**
 * The three platform marks the Workspace home draws on its tiles, its shelf
 * and the start card. They are decorative: the text beside each names it.
 */
const PlatformGlyph = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.75}
    viewBox="0 0 24 24"
  >
    {children}
  </svg>
);

export const WebIcon = ({
  className,
}: {
  readonly className?: string | undefined;
}) => (
  <PlatformGlyph className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </PlatformGlyph>
);

export const AndroidIcon = ({
  className,
}: {
  readonly className?: string | undefined;
}) => (
  <PlatformGlyph className={className}>
    <path d="M4.5 17.5a7.5 7.5 0 0 1 15 0z" />
    <path d="M7.6 10.9 5.9 8.2" />
    <path d="m16.4 10.9 1.7-2.7" />
    <circle cx="9.2" cy="14.2" fill="currentColor" r="1" stroke="none" />
    <circle cx="14.8" cy="14.2" fill="currentColor" r="1" stroke="none" />
  </PlatformGlyph>
);

export const AppleIcon = ({
  className,
}: {
  readonly className?: string | undefined;
}) => (
  <PlatformGlyph className={className}>
    <path d="M12 7.6c-1.4-1-4.3-1.3-5.9 1-1.8 2.6-.9 6.9 1.2 9.6.9 1.2 1.9 2 3.1 1.5.9-.4 1.4-.4 2.4 0 1.2.5 2.2-.3 3.1-1.5.8-1.1 1.4-2.3 1.8-3.5-1.6-.7-2.6-2.2-2.4-3.9.1-1.1.7-2 1.6-2.6-1.6-1.8-3.6-1.6-4.9-.6z" />
    <path d="M12 7.6c-.2-2 .9-3.8 2.9-4.4" />
  </PlatformGlyph>
);

export const PlatformIcon = ({
  className,
  platform,
}: {
  readonly className?: string | undefined;
  readonly platform: HomePlatform;
}) => {
  if (platform === "android") {
    return <AndroidIcon className={className} />;
  }
  if (platform === "ios") {
    return <AppleIcon className={className} />;
  }
  return <WebIcon className={className} />;
};
