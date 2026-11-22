import type {
  BrowserCookie,
  BrowserTabId,
  CookieSameSite,
  StorageKind,
} from "@contingency/protocol";
import {
  cookieIdentitiesEqual,
  cookieIdentityOf,
  httpOriginFromUrl,
  isCookieSameSite,
  isBrowserRpcError,
  STORAGE_LOCKED_MESSAGE as storageLockedMessage,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Cause, Effect, Fiber, Schedule } from "effect";
import { Atom } from "effect/reactivity";
import { PaperclipIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  dragAttachment,
  storageAttachment,
} from "@/components/agent/browser-check-attachments";
import {
  applyFetchedStorageSnapshot,
  applyTabUrlOriginChange,
  cookieDetailDraft,
  cookieDraftFromCookie,
  cookieIdentityChanged,
  cookieWriteFromDraft,
  defaultCookieDraft,
  defaultWebStorageDraft,
  formatCookieExpires,
  isStorageDraftDirty,
  selectedWebStorageValue,
  saveCookieMutation,
  truncateStorageValue,
  validateCookieName,
  validateStorageKey,
  visibleCookies,
  visibleWebStorageEntries,
  webStorageDraftFromEntry,
} from "@/components/browser/browser-storage-state";
import type {
  CookieDraft,
  StoragePanelUiState,
  StorageSelection,
  WebStorageDraft,
} from "@/components/browser/browser-storage-state";
import type {
  BrowserTooling,
  StorageErase,
  StorageWrite,
} from "@/components/browser/browser-tooling";
import { devtoolsFieldClassName } from "@/components/browser/devtools-field";
import { HighlightedBody } from "@/components/browser/highlighted-body";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DraftField } from "@/components/ui/draft-field";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const innerTabs: readonly {
  readonly kind: StorageKind;
  /** The store's own name, as Clear names what it empties. */
  readonly label: string;
  /** The short choice in the Storage area control. */
  readonly short: string;
}[] = [
  { kind: "cookies", label: "Cookies", short: "Cookies" },
  { kind: "local", label: "localStorage", short: "Local" },
  { kind: "session", label: "sessionStorage", short: "Session" },
];

const clearConfirmCopy = (kind: StorageKind): string => {
  if (kind === "cookies") {
    return "Clear all cookies for this origin?";
  }
  if (kind === "local") {
    return "Clear all localStorage for this origin?";
  }
  return "Clear all sessionStorage for this origin?";
};

const sameSiteLabel = (value: CookieSameSite | undefined): string =>
  value ?? "—";

const sameSiteUnsetValue = "unset";

const sameSiteFromSelectValue = (
  value: string | null,
  current: CookieSameSite | undefined
): CookieSameSite | undefined => {
  if (value === null || value === sameSiteUnsetValue) {
    return undefined;
  }
  return isCookieSameSite(value) ? value : current;
};

const flagLabel = (value: boolean): string => (value ? "Yes" : "No");

const toErrorMessage = <Failure,>(error: Failure): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Storage operation failed";

export type { StoragePanelUiState } from "@/components/browser/browser-storage-state";

export interface BrowserStoragePanelProps {
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly refreshNonce: number;
  readonly tooling: BrowserTooling;
  readonly setUiState: (
    update: (current: StoragePanelUiState) => StoragePanelUiState
  ) => void;
  readonly tabId: BrowserTabId;
  readonly tabUrl: string;
  readonly uiState: StoragePanelUiState;
}

const cookieIdentitiesEqualRow = (
  cookie: BrowserCookie,
  selection: StorageSelection | undefined
): boolean =>
  selection?.kind === "cookies" &&
  cookieIdentitiesEqual(cookie, selection.identity);

/**
 * Cookie columns, narrow enough that the DevTools panel shows Name, Domain
 * and Value at once. The flags keep their headers whole; whatever does not
 * fit scrolls sideways under a fade.
 */
const COOKIE_COLUMNS =
  "grid-cols-[minmax(4.5rem,1fr)_minmax(4.5rem,1fr)_3rem_minmax(4.5rem,1.25fr)_3.75rem_3.25rem_4rem_3.25rem]";

/** The whole table's width, so a narrow panel scrolls instead of clipping. */
const COOKIE_TABLE_MIN = "min-w-[34rem]";

/**
 * Whether a scroller holds more to its right than it shows. It measures again
 * when the scroller scrolls or either it or its content resizes.
 */
const useMoreToRight = () => {
  const [moreAtom] = useState(() => Atom.make(false));
  const [more, setMore] = useAtom(moreAtom);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (node === null) {
      return;
    }
    const measure = () =>
      setMore(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    measure();
    const resizes = new ResizeObserver(measure);
    resizes.observe(node);
    if (node.firstElementChild !== null) {
      resizes.observe(node.firstElementChild);
    }
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      resizes.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [node, setMore]);
  return [more, setNode] as const;
};

const CookieRow = ({
  cookie,
  mutationsLocked,
  onAttach,
  onDelete,
  onSelect,
  origin,
  selected,
}: {
  readonly cookie: BrowserCookie;
  readonly mutationsLocked: boolean;
  readonly onAttach: BrowserTooling["attachBrowserContext"];
  readonly onDelete: (cookie: BrowserCookie) => void;
  readonly onSelect: (cookie: BrowserCookie) => void;
  readonly origin: string;
  readonly selected: boolean;
}) => (
  <div
    className={cn(
      "hover:bg-muted/50 grid h-8 items-center gap-x-2 px-2 font-mono text-xs",
      COOKIE_COLUMNS,
      selected && "bg-muted"
    )}
    draggable={onAttach !== undefined}
    onDragStart={(event) =>
      dragAttachment(
        event,
        storageAttachment(origin, cookie.name, "cookie", cookie.path)
      )
    }
  >
    <button
      className="col-span-7 grid grid-cols-subgrid items-center text-left"
      onClick={() => {
        onSelect(cookie);
      }}
      type="button"
    >
      <span className="truncate" title={cookie.name}>
        {cookie.name}
      </span>
      <span className="truncate" title={cookie.domain}>
        {cookie.domain}
      </span>
      <span className="truncate" title={cookie.path}>
        {cookie.path}
      </span>
      <span className="truncate" title={cookie.value}>
        {truncateStorageValue(cookie.value)}
      </span>
      <span>{flagLabel(cookie.httpOnly)}</span>
      <span>{flagLabel(cookie.secure)}</span>
      <span>{sameSiteLabel(cookie.sameSite)}</span>
    </button>
    <div className="flex items-center justify-end">
      {onAttach === undefined ? null : (
        <Button
          aria-label={`Attach cookie ${cookie.name}`}
          size="icon-xs"
          variant="ghost"
          onClick={() =>
            onAttach(
              storageAttachment(origin, cookie.name, "cookie", cookie.path)
            )
          }
        >
          <PaperclipIcon />
        </Button>
      )}
      <Button
        aria-label={`Delete cookie ${cookie.name}`}
        className="size-6"
        disabled={mutationsLocked}
        onClick={() => {
          onDelete(cookie);
        }}
        size="icon-xs"
        title={mutationsLocked ? storageLockedMessage : undefined}
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </div>
  </div>
);

/**
 * The origin's cookies, one row each. Header and rows scroll together, so in
 * a narrow panel every column stays reachable: a thin scrollbar and a fade on
 * the right edge show that more columns wait past it.
 */
const CookieTable = ({
  onAttach,
  origin,
  cookies,
  empty,
  mutationsLocked,
  onDelete,
  onSelect,
  selected,
}: {
  readonly onAttach: BrowserTooling["attachBrowserContext"];
  readonly origin: string;
  readonly cookies: readonly BrowserCookie[];
  readonly empty: boolean;
  readonly mutationsLocked: boolean;
  readonly onDelete: (cookie: BrowserCookie) => void;
  readonly onSelect: (cookie: BrowserCookie) => void;
  readonly selected: StorageSelection | undefined;
}) => {
  const [moreToRight, scrollerRef] = useMoreToRight();
  return (
    <div
      className={cn(
        "@container min-h-0 flex-1 [scrollbar-width:thin] overflow-auto",
        moreToRight &&
          "[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.5rem),transparent)]"
      )}
      ref={scrollerRef}
    >
      <div className={cn("min-h-full", COOKIE_TABLE_MIN)}>
        <div
          className={cn(
            "text-muted-foreground bg-island-solid sticky top-0 z-[1] grid gap-x-2 border-b px-2 py-1 text-xs font-medium",
            COOKIE_COLUMNS
          )}
        >
          <span>Name</span>
          <span>Domain</span>
          <span>Path</span>
          <span>Value</span>
          <span>HttpOnly</span>
          <span>Secure</span>
          <span>SameSite</span>
          <span className="sr-only">Delete</span>
        </div>
        {cookies.length === 0 ? (
          // The note spans the visible width, not the table's, so it stays
          // centred in a narrow panel.
          <div className="text-muted-foreground sticky left-0 grid h-24 w-[100cqw] place-items-center px-4 text-center text-xs">
            {empty
              ? "Cookies for this origin will appear here."
              : "No cookies match this search."}
          </div>
        ) : (
          cookies.map((cookie) => (
            <CookieRow
              cookie={cookie}
              key={`${cookie.name}\0${cookie.domain}\0${cookie.path}`}
              mutationsLocked={mutationsLocked}
              onAttach={onAttach}
              onDelete={onDelete}
              onSelect={onSelect}
              origin={origin}
              selected={cookieIdentitiesEqualRow(cookie, selected)}
            />
          ))
        )}
      </div>
    </div>
  );
};

const isFocusInside = (
  currentTarget: EventTarget,
  relatedTarget: EventTarget | null
): boolean =>
  relatedTarget instanceof Node &&
  currentTarget instanceof Node &&
  currentTarget.contains(relatedTarget);

const WebStorageInlineAdd = ({
  draft,
  onCancel,
  onCommit,
  onDraftChange,
  onFocusChange,
}: {
  readonly draft: WebStorageDraft;
  readonly onCancel: () => void;
  readonly onCommit: (draft: WebStorageDraft) => void;
  readonly onDraftChange: (draft: WebStorageDraft) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) => {
  const dirty = draft.key.length > 0 || draft.value.length > 0;
  return (
    <div
      className="grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_1.75rem] items-start gap-1 border-b px-2 py-1"
      onBlur={(event) => {
        if (isFocusInside(event.currentTarget, event.relatedTarget)) {
          return;
        }
        onFocusChange(false);
        if (dirty) {
          onCommit(draft);
        }
      }}
      onFocus={() => {
        onFocusChange(true);
      }}
    >
      <Field invalid={draft.fieldError !== undefined}>
        <DraftField
          variant="compact"
          aria-label="New storage key"
          className="h-7 font-mono text-xs md:text-xs"
          onCancel={onCancel}
          onChange={(event) =>
            onDraftChange({
              ...draft,
              fieldError: undefined,
              key: event.target.value,
            })
          }
          onCommit={() => onCommit(draft)}
          placeholder="Key"
          value={draft.key}
        />
        {draft.fieldError === undefined ? null : (
          <FieldError>{draft.fieldError}</FieldError>
        )}
      </Field>
      <DraftField
        variant="compact"
        aria-label="New storage value"
        className="h-7 font-mono text-xs md:text-xs"
        onCancel={onCancel}
        onChange={(event) =>
          onDraftChange({ ...draft, value: event.target.value })
        }
        onCommit={() => onCommit(draft)}
        placeholder="Value"
        value={draft.value}
      />
    </div>
  );
};

const WebStorageTable = ({
  onAttach,
  origin,
  draft,
  empty,
  entries,
  kind,
  mutationsLocked,
  onCancelDraft,
  onCommitDraft,
  onDelete,
  onDraftChange,
  onFocusChange,
  onSelect,
  selectedKey,
}: {
  readonly onAttach: BrowserTooling["attachBrowserContext"];
  readonly origin: string;
  readonly draft: WebStorageDraft | undefined;
  readonly empty: boolean;
  readonly entries: readonly (readonly [string, string])[];
  readonly kind: "local" | "session";
  readonly mutationsLocked: boolean;
  readonly onCancelDraft: () => void;
  readonly onCommitDraft: (draft: WebStorageDraft) => void;
  readonly onDelete: (key: string) => void;
  readonly onDraftChange: (draft: WebStorageDraft) => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onSelect: (key: string, value: string) => void;
  readonly selectedKey: string | undefined;
}) => {
  const adding = draft !== undefined && !draft.lockedKey;
  return (
    <>
      <div className="text-muted-foreground grid shrink-0 grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_3.5rem] gap-x-2 border-b px-2 py-1 text-xs font-medium">
        <span>Key</span>
        <span>Value</span>
        <span className="sr-only">Delete</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {adding ? (
          <WebStorageInlineAdd
            draft={draft}
            onCancel={onCancelDraft}
            onCommit={onCommitDraft}
            onDraftChange={onDraftChange}
            onFocusChange={onFocusChange}
          />
        ) : null}
        {entries.length === 0 && !adding ? (
          <div className="text-muted-foreground grid h-24 place-items-center px-4 text-center text-xs">
            {empty
              ? `${kind === "local" ? "localStorage" : "sessionStorage"} entries for this origin will appear here.`
              : "No entries match this search."}
          </div>
        ) : (
          entries.map(([key, value]) => (
            <div
              className={cn(
                "hover:bg-muted/50 grid h-8 grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_3.5rem] items-center gap-x-2 px-2 font-mono text-xs",
                selectedKey === key && "bg-muted"
              )}
              key={key}
              draggable={onAttach !== undefined}
              onDragStart={(event) =>
                dragAttachment(event, storageAttachment(origin, key, kind))
              }
            >
              <button
                className="col-span-2 grid grid-cols-subgrid items-center text-left"
                onClick={() => {
                  onSelect(key, value);
                }}
                type="button"
              >
                <span className="truncate">{key}</span>
                <span className="truncate" title={value}>
                  {truncateStorageValue(value)}
                </span>
              </button>
              <div className="flex items-center justify-end">
                {onAttach === undefined ? null : (
                  <Button
                    aria-label={`Attach ${kind} ${key}`}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      onAttach(storageAttachment(origin, key, kind))
                    }
                  >
                    <PaperclipIcon />
                  </Button>
                )}
                <Button
                  aria-label={`Delete ${key}`}
                  className="size-6"
                  disabled={mutationsLocked}
                  onClick={() => {
                    onDelete(key);
                  }}
                  size="icon-xs"
                  title={mutationsLocked ? storageLockedMessage : undefined}
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
};

const CookieDetail = ({
  cookie,
  draft,
  editing,
  mutationsLocked,
  onCancel,
  onClose,
  onDraftChange,
  onEdit,
  onFocusChange,
  onSave,
}: {
  readonly cookie: BrowserCookie | undefined;
  readonly draft: CookieDraft | undefined;
  readonly editing: boolean;
  readonly mutationsLocked: boolean;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly onDraftChange: (draft: CookieDraft) => void;
  readonly onEdit: () => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onSave: (draft: CookieDraft) => void;
}) => {
  const form = draft;
  if (form === undefined) {
    return null;
  }
  const readOnly = mutationsLocked || !editing;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center border-b px-2">
        <span className="text-xs font-medium">
          {form.identity === undefined ? "New cookie" : form.name}
        </span>
        <Button
          aria-label="Close cookie details"
          className="ml-auto"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          ×
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-2">
          <Field invalid={form.fieldError !== undefined}>
            <FieldLabel>Name</FieldLabel>
            <Input
              variant="compact"
              disabled={readOnly || form.identity !== undefined}
              onBlur={() => {
                onFocusChange(false);
              }}
              onChange={(event) =>
                onDraftChange({
                  ...form,
                  fieldError: undefined,
                  name: event.target.value,
                })
              }
              onFocus={() => {
                onFocusChange(true);
              }}
              value={form.name}
            />
            {form.fieldError === undefined ? null : (
              <FieldError>{form.fieldError}</FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel>Value</FieldLabel>
            <Textarea
              disabled={readOnly}
              onBlur={() => {
                onFocusChange(false);
              }}
              onChange={(event) =>
                onDraftChange({ ...form, value: event.target.value })
              }
              onFocus={() => {
                onFocusChange(true);
              }}
              value={form.value}
            />
          </Field>
          {readOnly ? <HighlightedBody value={form.value} /> : null}
          <Field>
            <FieldLabel>Domain</FieldLabel>
            <Input
              variant="compact"
              disabled={readOnly}
              onBlur={() => {
                onFocusChange(false);
              }}
              onChange={(event) =>
                onDraftChange({ ...form, domain: event.target.value })
              }
              onFocus={() => {
                onFocusChange(true);
              }}
              value={form.domain}
            />
          </Field>
          <Field>
            <FieldLabel>Path</FieldLabel>
            <Input
              variant="compact"
              disabled={readOnly}
              onBlur={() => {
                onFocusChange(false);
              }}
              onChange={(event) =>
                onDraftChange({ ...form, path: event.target.value })
              }
              onFocus={() => {
                onFocusChange(true);
              }}
              value={form.path}
            />
          </Field>
          <p className="text-muted-foreground text-xs">
            Expires:{" "}
            {cookie === undefined ? "Session" : formatCookieExpires(cookie)}
          </p>
          {cookie === undefined ? null : (
            <p className="text-muted-foreground text-xs">Size: {cookie.size}</p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.httpOnly}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                onDraftChange({ ...form, httpOnly: checked === true })
              }
            />
            HttpOnly
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.secure}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                onDraftChange({ ...form, secure: checked === true })
              }
            />
            Secure
          </label>
          <Field>
            <FieldLabel>SameSite</FieldLabel>
            <Select
              disabled={readOnly}
              onValueChange={(value) =>
                onDraftChange({
                  ...form,
                  sameSite: sameSiteFromSelectValue(value, form.sameSite),
                })
              }
              value={form.sameSite ?? sameSiteUnsetValue}
            >
              <SelectTrigger variant="compact" aria-label="SameSite" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent variant="compact">
                <SelectItem value={sameSiteUnsetValue}>—</SelectItem>
                <SelectItem value="Strict">Strict</SelectItem>
                <SelectItem value="Lax">Lax</SelectItem>
                <SelectItem value="None">None</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-1 border-t p-2">
        {editing ? (
          <>
            <Button onClick={onCancel} size="sm" variant="outline">
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={mutationsLocked}
              onClick={() => {
                onSave(form);
              }}
              size="sm"
              title={mutationsLocked ? storageLockedMessage : undefined}
            >
              Save
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={mutationsLocked}
            onClick={onEdit}
            size="sm"
            title={mutationsLocked ? storageLockedMessage : undefined}
          >
            Edit
          </Button>
        )}
      </div>
    </div>
  );
};

const WebStorageDetail = ({
  dirty,
  locked,
  onChange,
  onClose,
  onCommit,
  onFocusChange,
  storageKey,
  value,
}: {
  readonly dirty: boolean;
  readonly locked: boolean;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onCommit: () => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly storageKey: string;
  readonly value: string;
}) => (
  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
    <div className="flex h-8 shrink-0 items-center border-b px-2">
      <span className="truncate font-mono text-xs">{storageKey}</span>
      <Button
        aria-label="Close storage details"
        className="ml-auto"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        ×
      </Button>
    </div>
    <Field className="shrink-0 p-2">
      <FieldLabel>Value</FieldLabel>
      <Textarea
        disabled={locked}
        onBlur={() => {
          onFocusChange(false);
          if (!locked && dirty) {
            onCommit();
          }
        }}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onFocus={() => {
          onFocusChange(true);
        }}
        value={value}
      />
    </Field>
    <HighlightedBody value={value} />
  </div>
);

const useStoragePolling = ({
  dirty,
  getStorage,
  mutationsLocked,
  onError,
  onRefreshStateChange,
  pollPaused,
  refreshNonce,
  setUiState,
  tabId,
  tabUrl,
  uiState,
}: {
  readonly dirty: boolean;
  readonly getStorage: (
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Promise<Parameters<typeof applyFetchedStorageSnapshot>[2]>;
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly pollPaused: boolean;
  readonly refreshNonce: number;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly tabId: BrowserTabId;
  readonly tabUrl: string;
  readonly uiState: StoragePanelUiState;
}) => {
  const onRefreshStateChangeRef = useRef(onRefreshStateChange);
  const onErrorRef = useRef(onError);
  const getStorageRef = useRef(getStorage);
  const setUiStateRef = useRef(setUiState);
  const tabUrlRef = useRef(tabUrl);

  useEffect(() => {
    getStorageRef.current = getStorage;
    onErrorRef.current = onError;
    onRefreshStateChangeRef.current = onRefreshStateChange;
    setUiStateRef.current = setUiState;
    tabUrlRef.current = tabUrl;
  });

  const fetchKind = (kind: StorageKind) =>
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () => getStorageRef.current(tabId, kind),
    }).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          setUiStateRef.current((current) =>
            applyFetchedStorageSnapshot(current, tabUrlRef.current, snapshot)
          );
        })
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          onErrorRef.current(toErrorMessage(Cause.squash(cause)))
        )
      )
    );
  const fetchKindFromEffect = useEffectEvent(fetchKind);

  useEffect(() => {
    setUiStateRef.current((current) =>
      applyTabUrlOriginChange(current, tabUrl)
    );
  }, [tabUrl]);

  useEffect(() => {
    if (dirty) {
      return;
    }
    let cancelled = false;
    const trackedFetch = Effect.suspend(() => {
      onRefreshStateChangeRef.current(true);
      return fetchKindFromEffect(uiState.storageKind).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!cancelled) {
              onRefreshStateChangeRef.current(false);
            }
          })
        )
      );
    });
    const fiber = Effect.runFork(
      trackedFetch
        .pipe(
          Effect.andThen(
            pollPaused
              ? Effect.void
              : trackedFetch.pipe(Effect.repeat(Schedule.spaced("1 second")))
          )
        )
        .pipe(Effect.ignore)
    );
    return () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [dirty, pollPaused, refreshNonce, tabUrl, uiState.storageKind]);

  useEffect(() => {
    if (!(mutationsLocked && uiState.storageDraft !== undefined)) {
      return;
    }
    setUiStateRef.current((current) => {
      if (current.storageDraft === undefined) {
        return current;
      }
      return {
        ...current,
        storageDraft: undefined,
        storageFocused: false,
        storageMutateError: undefined,
      };
    });
  }, [mutationsLocked, uiState.storageDraft]);

  return fetchKind;
};

type StorageFetchKind = (kind: StorageKind) => Effect.Effect<unknown, unknown>;

type StorageMutationEffect = Effect.Effect<unknown, unknown>;

const useStorageMutations = (tooling: BrowserTooling, tabId: BrowserTabId) => {
  const setStorageEffect = (input: StorageWrite): StorageMutationEffect =>
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () => tooling.setStorage(tabId, input),
    });
  const deleteStorageEffect = (input: StorageErase): StorageMutationEffect =>
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () => tooling.deleteStorage(tabId, input),
    });
  return { deleteStorageEffect, setStorageEffect };
};

const runStorageMutate = (
  effect: Effect.Effect<unknown, unknown>,
  fetchKind: StorageFetchKind,
  kind: StorageKind,
  onError: (message: string) => void,
  onRefreshStateChange: (refreshing: boolean) => void,
  setUiState: BrowserStoragePanelProps["setUiState"]
) => {
  onRefreshStateChange(true);
  Effect.runFork(
    effect.pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          setUiState((current) => ({
            ...current,
            storageDraft: undefined,
            storageFocused: false,
            storageMutateError: undefined,
          }))
        )
      ),
      Effect.andThen(fetchKind(kind)),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const message = toErrorMessage(Cause.squash(cause));
          setUiState((current) => ({
            ...current,
            storageMutateError: message,
          }));
          onError(message);
        })
      ),
      Effect.ensuring(Effect.sync(() => onRefreshStateChange(false)))
    )
  );
};

const StoragePanelChrome = ({
  host,
  mutationsLocked,
  onConfirmClear,
  setUiState,
  uiState,
}: {
  readonly host: string | undefined;
  readonly mutationsLocked: boolean;
  readonly onConfirmClear: () => void;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly uiState: StoragePanelUiState;
}) => {
  const mutateDisabledReason = mutationsLocked
    ? storageLockedMessage
    : undefined;
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          <SegmentedControl<StorageKind>
            aria-label="Storage area"
            onValueChange={(kind) => {
              setUiState((current) => ({
                ...current,
                storageDraft: undefined,
                storageFocused: false,
                storageKind: kind,
                storageMutateError: undefined,
                storageSelection:
                  current.storageSelection?.kind === kind
                    ? current.storageSelection
                    : undefined,
              }));
            }}
            size="sm"
            value={uiState.storageKind}
          >
            {innerTabs.map((tab) => (
              <SegmentedControlItem key={tab.kind} value={tab.kind}>
                {tab.short}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <Button
          aria-label={`Add ${uiState.storageKind === "cookies" ? "cookie" : "entry"}`}
          disabled={mutationsLocked}
          onClick={() => {
            const kind = uiState.storageKind;
            if (kind === "cookies") {
              setUiState((current) => ({
                ...current,
                storageDraft: defaultCookieDraft(host ?? ""),
                storageMutateError: undefined,
                storageSelection: undefined,
              }));
              return;
            }
            setUiState((current) => ({
              ...current,
              storageDraft: defaultWebStorageDraft(kind),
              storageMutateError: undefined,
              storageSelection: undefined,
            }));
          }}
          size="icon-sm"
          title={mutateDisabledReason}
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button
          aria-label={`Clear ${innerTabs.find((tab) => tab.kind === uiState.storageKind)?.label ?? "store"}`}
          disabled={mutationsLocked}
          onClick={onConfirmClear}
          size="sm"
          title={mutateDisabledReason}
          variant="ghost"
        >
          Clear
        </Button>
      </div>
      {mutationsLocked ? (
        <p className="text-muted-foreground border-b px-2 py-1 text-xs">
          {storageLockedMessage}
        </p>
      ) : null}
      <div className="shrink-0 border-b p-1.5">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            variant="compact"
            aria-label="Search storage"
            className={cn(devtoolsFieldClassName, "pl-7")}
            onBlur={() =>
              setUiState((current) => ({
                ...current,
                storageFocused: false,
              }))
            }
            onChange={(event) =>
              setUiState((current) => ({
                ...current,
                storageSearch: event.target.value,
              }))
            }
            onFocus={() =>
              setUiState((current) => ({
                ...current,
                storageFocused: true,
              }))
            }
            placeholder={
              uiState.storageKind === "cookies"
                ? "Search name, domain, path, or value"
                : "Search key or value"
            }
            value={uiState.storageSearch}
          />
        </div>
      </div>
      {uiState.storageMutateError === undefined ? null : (
        <Alert className="m-1.5" variant="destructive">
          <AlertDescription>{uiState.storageMutateError}</AlertDescription>
        </Alert>
      )}
    </>
  );
};

interface StorageWorkspaceProps {
  readonly tabUrl: string;
  readonly fetchKind: StorageFetchKind;
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly tooling: BrowserTooling;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly tabId: BrowserTabId;
  readonly uiState: StoragePanelUiState;
}

const storageOrigin = (url: string) => httpOriginFromUrl(url)?.origin ?? "";

const StorageCookiesWorkspace = ({
  tabUrl,
  fetchKind,
  mutationsLocked,
  onError,
  onRefreshStateChange,
  tooling,
  setUiState,
  tabId,
  uiState,
}: StorageWorkspaceProps) => {
  const { deleteStorageEffect, setStorageEffect } = useStorageMutations(
    tooling,
    tabId
  );
  const cookies = visibleCookies(
    uiState.storageSnapshots.cookies,
    uiState.storageSearch
  );
  const selectedCookie =
    uiState.storageSelection?.kind === "cookies"
      ? uiState.storageSnapshots.cookies.find((cookie) =>
          cookieIdentitiesEqualRow(cookie, uiState.storageSelection)
        )
      : undefined;
  const mutate = (effect: Effect.Effect<unknown, unknown>) =>
    runStorageMutate(
      effect,
      fetchKind,
      "cookies",
      onError,
      onRefreshStateChange,
      setUiState
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "flex min-w-0 flex-col",
          uiState.storageSelection === undefined &&
            uiState.storageDraft === undefined
            ? "flex-1"
            : "w-1/2 border-r"
        )}
      >
        <CookieTable
          onAttach={tooling.attachBrowserContext}
          origin={storageOrigin(tabUrl)}
          cookies={cookies}
          empty={uiState.storageSnapshots.cookies.length === 0}
          mutationsLocked={mutationsLocked}
          onDelete={(cookie) => {
            mutate(
              deleteStorageEffect({
                domain: cookie.domain,
                kind: "cookies",
                name: cookie.name,
                path: cookie.path,
              })
            );
          }}
          onSelect={(cookie) => {
            setUiState((current) => ({
              ...current,
              storageDraft: undefined,
              storageMutateError: undefined,
              storageSelection: {
                identity: cookieIdentityOf(cookie),
                kind: "cookies",
              },
            }));
          }}
          selected={uiState.storageSelection}
        />
      </div>
      {selectedCookie === undefined &&
      uiState.storageDraft?.kind !== "cookies" ? null : (
        <CookieDetail
          cookie={selectedCookie}
          draft={cookieDetailDraft(uiState.storageDraft, selectedCookie)}
          editing={uiState.storageDraft?.kind === "cookies"}
          mutationsLocked={mutationsLocked}
          onCancel={() =>
            setUiState((current) => ({
              ...current,
              storageDraft: undefined,
              storageFocused: false,
              storageMutateError: undefined,
              storageSelection:
                current.storageDraft?.kind === "cookies" &&
                current.storageDraft.identity === undefined
                  ? undefined
                  : current.storageSelection,
            }))
          }
          onClose={() =>
            setUiState((current) => ({
              ...current,
              storageDraft: undefined,
              storageSelection: undefined,
            }))
          }
          onDraftChange={(draft) =>
            setUiState((current) => ({
              ...current,
              storageDraft: draft,
            }))
          }
          onEdit={() => {
            if (selectedCookie === undefined) {
              return;
            }
            setUiState((current) => ({
              ...current,
              storageDraft: cookieDraftFromCookie(selectedCookie),
            }));
          }}
          onFocusChange={(focused) =>
            setUiState((current) => ({
              ...current,
              storageFocused: focused,
            }))
          }
          onSave={(draft) => {
            const fieldError = validateCookieName(draft.name);
            if (fieldError !== undefined) {
              setUiState((current) => ({
                ...current,
                storageDraft: { ...draft, fieldError },
              }));
              return;
            }
            const write = cookieWriteFromDraft(draft);
            if (write === undefined) {
              return;
            }
            const recreate = cookieIdentityChanged(draft);
            const { identity } = draft;
            mutate(
              saveCookieMutation(
                setStorageEffect({
                  cookie: write,
                  kind: "cookies",
                }),
                recreate && identity !== undefined
                  ? deleteStorageEffect({
                      domain: identity.domain,
                      kind: "cookies",
                      name: identity.name,
                      path: identity.path,
                    })
                  : undefined
              )
            );
          }}
        />
      )}
    </div>
  );
};

const StorageWebWorkspace = ({
  fetchKind,
  mutationsLocked,
  onError,
  onRefreshStateChange,
  tooling,
  setUiState,
  tabId,
  tabUrl,
  uiState,
}: StorageWorkspaceProps) => {
  const { deleteStorageEffect, setStorageEffect } = useStorageMutations(
    tooling,
    tabId
  );
  const webKind = uiState.storageKind === "session" ? "session" : "local";
  const webDraft =
    uiState.storageDraft !== undefined && uiState.storageDraft.kind === webKind
      ? uiState.storageDraft
      : undefined;
  const webEntries = visibleWebStorageEntries(
    webKind === "local"
      ? uiState.storageSnapshots.local
      : uiState.storageSnapshots.session,
    uiState.storageSearch
  );
  const selectedWebValue = selectedWebStorageValue(
    uiState.storageSelection,
    uiState.storageSnapshots,
    uiState.storageKind
  );
  const selectedKey =
    uiState.storageSelection !== undefined &&
    uiState.storageSelection.kind === webKind
      ? uiState.storageSelection.key
      : undefined;
  const mutate = (effect: Effect.Effect<unknown, unknown>) =>
    runStorageMutate(
      effect,
      fetchKind,
      webKind,
      onError,
      onRefreshStateChange,
      setUiState
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "flex min-w-0 flex-col",
          uiState.storageSelection === undefined &&
            uiState.storageDraft === undefined
            ? "flex-1"
            : "w-1/2 border-r"
        )}
      >
        <WebStorageTable
          onAttach={tooling.attachBrowserContext}
          origin={storageOrigin(tabUrl)}
          draft={webDraft}
          empty={
            Object.keys(
              webKind === "local"
                ? uiState.storageSnapshots.local
                : uiState.storageSnapshots.session
            ).length === 0 && uiState.storageDraft === undefined
          }
          entries={webEntries}
          kind={webKind}
          mutationsLocked={mutationsLocked}
          onCancelDraft={() =>
            setUiState((current) => ({
              ...current,
              storageDraft: undefined,
              storageFocused: false,
            }))
          }
          onCommitDraft={(draft) => {
            const fieldError = validateStorageKey(draft.key);
            if (fieldError !== undefined) {
              setUiState((current) => ({
                ...current,
                storageDraft: { ...draft, fieldError },
              }));
              return;
            }
            mutate(
              setStorageEffect({
                key: draft.key,
                kind: draft.kind,
                value: draft.value,
              })
            );
          }}
          onDelete={(key) => {
            mutate(
              deleteStorageEffect({
                key,
                kind: webKind,
              })
            );
          }}
          onDraftChange={(draft) =>
            setUiState((current) => ({
              ...current,
              storageDraft: draft,
            }))
          }
          onFocusChange={(focused) =>
            setUiState((current) => ({
              ...current,
              storageFocused: focused,
            }))
          }
          onSelect={(key, value) => {
            setUiState((current) => ({
              ...current,
              storageDraft: webStorageDraftFromEntry(webKind, key, value),
              storageMutateError: undefined,
              storageSelection: { key, kind: webKind },
            }));
          }}
          selectedKey={selectedKey}
        />
      </div>
      {selectedWebValue === undefined ||
      uiState.storageDraft === undefined ||
      uiState.storageDraft.kind === "cookies" ||
      !uiState.storageDraft.lockedKey ? null : (
        <WebStorageDetail
          dirty={isStorageDraftDirty(
            uiState.storageDraft,
            uiState.storageSnapshots
          )}
          locked={mutationsLocked}
          onChange={(value) =>
            setUiState((current) =>
              current.storageDraft?.kind === current.storageKind
                ? {
                    ...current,
                    storageDraft: { ...current.storageDraft, value },
                  }
                : current
            )
          }
          onClose={() =>
            setUiState((current) => ({
              ...current,
              storageDraft: undefined,
              storageSelection: undefined,
            }))
          }
          onCommit={() => {
            const draft = uiState.storageDraft;
            if (draft === undefined || draft.kind === "cookies") {
              return;
            }
            mutate(
              setStorageEffect({
                key: draft.key,
                kind: draft.kind,
                value: draft.value,
              })
            );
          }}
          onFocusChange={(focused) =>
            setUiState((current) => ({
              ...current,
              storageFocused: focused,
            }))
          }
          storageKey={
            uiState.storageSelection?.kind === "cookies"
              ? ""
              : (uiState.storageSelection?.key ?? "")
          }
          value={uiState.storageDraft.value}
        />
      )}
    </div>
  );
};

const StorageClearDialog = ({
  fetchKind,
  kind,
  onError,
  onOpenChange,
  onRefreshStateChange,
  open,
  tooling,
  setUiState,
  tabId,
}: {
  readonly fetchKind: StorageFetchKind;
  readonly kind: StorageKind;
  readonly onError: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly open: boolean;
  readonly tooling: BrowserTooling;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly tabId: BrowserTabId;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Clear this store?</AlertDialogTitle>
        <AlertDialogDescription>
          {clearConfirmCopy(kind)}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          onClick={() => {
            onOpenChange(false);
            runStorageMutate(
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () => tooling.clearStorage(tabId, kind),
              }),
              fetchKind,
              kind,
              onError,
              onRefreshStateChange,
              setUiState
            );
          }}
          variant="destructive"
        >
          Clear
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

export const BrowserStoragePanel = ({
  mutationsLocked,
  onError,
  onRefreshStateChange,
  refreshNonce,
  tooling,
  setUiState,
  tabId,
  tabUrl,
  uiState,
}: BrowserStoragePanelProps) => {
  const [confirmClear, setConfirmClear] = useState(false);
  const host = httpOriginFromUrl(tabUrl)?.host;
  const dirty = isStorageDraftDirty(
    uiState.storageDraft,
    uiState.storageSnapshots
  );
  const pollPaused = uiState.storageFocused || dirty;
  const fetchKind = useStoragePolling({
    dirty,
    getStorage: tooling.getStorage,
    mutationsLocked,
    onError,
    onRefreshStateChange,
    pollPaused,
    refreshNonce,
    setUiState,
    tabId,
    tabUrl,
    uiState,
  });
  const workspaceProps = {
    fetchKind,
    mutationsLocked,
    onError,
    onRefreshStateChange,
    setUiState,
    tabId,
    tabUrl,
    tooling,
    uiState,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StoragePanelChrome
        host={host}
        mutationsLocked={mutationsLocked}
        onConfirmClear={() => {
          setConfirmClear(true);
        }}
        setUiState={setUiState}
        uiState={uiState}
      />
      {uiState.storageKind === "cookies" ? (
        <StorageCookiesWorkspace {...workspaceProps} />
      ) : (
        <StorageWebWorkspace {...workspaceProps} />
      )}
      <StorageClearDialog
        fetchKind={fetchKind}
        kind={uiState.storageKind}
        onError={onError}
        onOpenChange={setConfirmClear}
        onRefreshStateChange={onRefreshStateChange}
        open={confirmClear}
        tooling={tooling}
        setUiState={setUiState}
        tabId={tabId}
      />
    </div>
  );
};
