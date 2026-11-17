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

export const TaskIcon = () => (
  <Icon>
    <path d="M8 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M10 11h6" />
    <path d="M10 15h4" />
  </Icon>
);

export const CommentIcon = () => (
  <Icon>
    <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
  </Icon>
);

export const PointerIcon = () => (
  <Icon>
    <path d="m5 4 13 6-5.5 1.8L10.5 18z" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
  </Icon>
);

export const KeyIcon = () => (
  <Icon>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8" />
    <path d="m16 7 2 2" />
  </Icon>
);

export const QuestionIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
    <circle cx="12" cy="17" fill="currentColor" r=".6" stroke="none" />
  </Icon>
);

export const MinimizeIcon = () => (
  <Icon>
    <path d="M6 12h12" />
  </Icon>
);

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" fill="currentColor" r=".6" stroke="none" />
  </Icon>
);

export const FileIcon = () => (
  <Icon>
    <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const FolderIcon = () => (
  <Icon>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <path d="M8 5v14M16 5v14" strokeWidth={3} />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

export const DraftIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
  </Icon>
);

export const VerifiedIcon = () => (
  <Icon>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);

export const ForwardIcon = () => (
  <Icon>
    <path d="M4 6v12l8-6zM12 6v12l8-6z" fill="currentColor" />
  </Icon>
);

export const EyeOffIcon = () => (
  <Icon>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 5 9 7a9 9 0 0 1-2.4 3.4M6.6 6.6C4.4 8 3 10.4 3 12c0 2 4 7 9 7a9.6 9.6 0 0 0 4.4-1.1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Icon>
);

export const RecordIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" fill="currentColor" r="3.5" stroke="none" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);
