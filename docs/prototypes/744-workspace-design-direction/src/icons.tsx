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

/**
 * The watcher as a loader, as the Workspace draws it (`apps/web` brand.tsx):
 * the eyes look left, look right, then blink. The view box is wider than the
 * mark so the glance stays inside it.
 */
export const WatcherLoader = ({
  className,
}: {
  readonly className?: string;
}) => (
  <svg
    aria-hidden="true"
    className={className}
    data-slot="watcher-loader"
    fill="currentColor"
    viewBox="0 40 120 38"
  >
    <g data-slot="watcher-look">
      <g data-slot="watcher-blink">
        <path d="M14 44L54 58V74H36Z" />
        <path d="M106 44L66 58V74H84Z" />
      </g>
    </g>
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

export const StopIcon = () => (
  <Icon>
    <rect
      fill="currentColor"
      height="10"
      rx="2"
      stroke="none"
      width="10"
      x="7"
      y="7"
    />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect height="12" rx="2.5" width="12" x="8" y="8" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);

export const PanelCloseIcon = () => (
  <Icon>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M15 4v16" />
    <path d="m8 10 2 2-2 2" />
  </Icon>
);

export const CheckCircleIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.2 2.4 2.3 4.6-4.8" />
  </Icon>
);

export const XCircleIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
  </Icon>
);

export const AlertCircleIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4.5" />
    <circle cx="12" cy="16" fill="currentColor" r="0.6" />
  </Icon>
);

export const MinusCircleIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12h7" />
  </Icon>
);

export const CornerIcon = () => (
  <Icon>
    <path d="M6 4v7a3 3 0 0 0 3 3h9" />
    <path d="m14 10 4 4-4 4" />
  </Icon>
);

export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Icon>
);

export const SummaryIcon = () => (
  <Icon>
    <rect height="16" rx="3" width="16" x="4" y="4" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </Icon>
);

/* ------------------------------------------------- Web canvas (#763) */

export const FingerprintIcon = () => (
  <Icon>
    <path d="M12 11v2a8 8 0 0 1-1.2 4.3" />
    <path d="M8.5 7.4A5 5 0 0 1 17 11v1.5a12 12 0 0 1-.8 4.4" />
    <path d="M7 11a5 5 0 0 1 .3-1.7" />
    <path d="M7 13.5a9 9 0 0 1-1.4 4" />
    <path d="M5 8.6A8 8 0 0 1 19.6 9" />
    <path d="M14.3 15.5a14 14 0 0 1-1.3 4" />
  </Icon>
);

export const SparklesIcon = () => (
  <Icon>
    <path d="M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z" />
    <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
  </Icon>
);

export const TerminalIcon = () => (
  <Icon>
    <path d="m5 8 4 4-4 4" />
    <path d="M12 17h7" />
  </Icon>
);

export const GlobeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5S14.4 17.9 12 20.5C9.6 17.9 8.5 15.1 8.5 12S9.6 6.1 12 3.5z" />
  </Icon>
);

export const DatabaseIcon = () => (
  <Icon>
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
    <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
  </Icon>
);

export const ActivityIcon = () => (
  <Icon>
    <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
  </Icon>
);

export const RotateIcon = () => (
  <Icon>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7" />
    <path d="M20 4v4.7h-4.7" />
    <rect height="7" rx="1.5" width="10" x="7" y="11" />
  </Icon>
);

export const PhoneIcon = () => (
  <Icon>
    <rect height="18" rx="3" width="11" x="6.5" y="3" />
    <path d="M11 17.5h2" />
  </Icon>
);

export const TabletIcon = () => (
  <Icon>
    <rect height="18" rx="2.5" width="15" x="4.5" y="3" />
    <path d="M11 17.5h2" />
  </Icon>
);

export const DockRightIcon = () => (
  <Icon>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M14 4v16" />
  </Icon>
);

export const DockBottomIcon = () => (
  <Icon>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M3 14h18" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect height="9" rx="2" width="14" x="5" y="11" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6" />
    <path d="M20 4v4.6h-4.6" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16" />
    <path d="M9 7V4.5h6V7" />
    <path d="M6.5 7l1 12.5h9l1-12.5" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Icon>
);

export const ForwardArrowIcon = () => (
  <Icon>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </Icon>
);
