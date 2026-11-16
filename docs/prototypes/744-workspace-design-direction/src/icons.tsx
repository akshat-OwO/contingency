import type { ReactNode } from "react";

const Icon = ({ children }: { readonly children: ReactNode }) => (
  <svg
    aria-hidden="true"
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

export const WebIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </Icon>
);

export const AndroidIcon = () => (
  <Icon>
    <path d="M4.5 17.5a7.5 7.5 0 0 1 15 0z" />
    <path d="M7.6 10.9 5.9 8.2" />
    <path d="m16.4 10.9 1.7-2.7" />
    <circle cx="9.2" cy="14.2" fill="currentColor" r="1" stroke="none" />
    <circle cx="14.8" cy="14.2" fill="currentColor" r="1" stroke="none" />
  </Icon>
);

export const AppleIcon = () => (
  <Icon>
    <path d="M12 7.6c-1.4-1-4.3-1.3-5.9 1-1.8 2.6-.9 6.9 1.2 9.6.9 1.2 1.9 2 3.1 1.5.9-.4 1.4-.4 2.4 0 1.2.5 2.2-.3 3.1-1.5.8-1.1 1.4-2.3 1.8-3.5-1.6-.7-2.6-2.2-2.4-3.9.1-1.1.7-2 1.6-2.6-1.6-1.8-3.6-1.6-4.9-.6z" />
    <path d="M12 7.6c-.2-2 .9-3.8 2.9-4.4" />
  </Icon>
);

export const ChevronsIcon = () => (
  <Icon>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const FlowsIcon = () => (
  <Icon>
    <rect height="7" rx="1.5" width="7" x="3" y="3" />
    <rect height="7" rx="1.5" width="7" x="14" y="14" />
    <path d="M6.5 10v4.5a2 2 0 0 0 2 2H14" />
  </Icon>
);

export const DocsIcon = () => (
  <Icon>
    <path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h13" />
    <path d="M8 7h7" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon>
    <path d="M12 15V4M7 9l5-5 5 5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Icon>
);

export const HandIcon = () => (
  <Icon>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
    <path d="M11 11.5v-8a1.5 1.5 0 0 1 3 0v8" />
    <path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v7.5" />
    <path d="M8 13 6.6 11.4a1.6 1.6 0 0 0-2.4 2.1L8 18.5a5 5 0 0 0 4 2h1a5 5 0 0 0 5-5v-2" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const MonitorIcon = () => (
  <Icon>
    <rect height="13" rx="2" width="18" x="3" y="4" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const WatcherMark = ({ className }: { readonly className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="currentColor"
    viewBox="10 40 100 38"
  >
    <path d="M14 44L54 58V74H36Z" />
    <path d="M106 44L66 58V74H84Z" />
  </svg>
);
