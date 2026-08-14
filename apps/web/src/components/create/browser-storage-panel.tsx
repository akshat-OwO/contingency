import type {
  BrowserCookie,
  BrowserTabId,
  CookieSameSite,
  SessionId,
  StorageKind,
} from "@contingency/protocol";
import {
  cookieIdentityOf,
  httpOriginFromUrl,
  isBrowserRpcError,
  STORAGE_LOCKED_MESSAGE as storageLockedMessage,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Effect, Fiber, Schedule } from "effect";
import { PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  storageEntryCount,
  truncateStorageValue,
  validateCookieName,
  validateStorageKey,
  visibleCookies,
  visibleWebStorageEntries,
  webStorageDraftFromEntry,
} from "@/components/create/browser-storage-state";
import type {
  CookieDraft,
  StoragePanelUiState,
  StorageSelection,
  WebStorageDraft,
} from "@/components/create/browser-storage-state";
import { HighlightedBody } from "@/components/create/highlighted-body";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  browserStorageClearMutation,
  browserStorageDeleteMutation,
  browserStorageGetMutation,
  browserStorageSetMutation,
} from "@/lib/rpc";
import { cn } from "@/lib/utils";

const innerTabs: readonly {
  readonly kind: StorageKind;
  readonly label: string;
}[] = [
  { kind: "cookies", label: "Cookies" },
  { kind: "local", label: "localStorage" },
  { kind: "session", label: "sessionStorage" },
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

const flagLabel = (value: boolean): string => (value ? "Yes" : "No");

const toErrorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Storage operation failed";

export type { StoragePanelUiState } from "@/components/create/browser-storage-state";

export interface BrowserStoragePanelProps {
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly refreshNonce: number;
  readonly sessionId: SessionId;
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
  cookie.name === selection.identity.name &&
  cookie.domain === selection.identity.domain &&
  cookie.path === selection.identity.path;

const CookieTable = ({
  cookies,
  empty,
  mutationsLocked,
  onDelete,
  onSelect,
  selected,
}: {
  readonly cookies: readonly BrowserCookie[];
  readonly empty: boolean;
  readonly mutationsLocked: boolean;
  readonly onDelete: (cookie: BrowserCookie) => void;
  readonly onSelect: (cookie: BrowserCookie) => void;
  readonly selected: StorageSelection | undefined;
}) => (
  <>
    <div className="text-muted-foreground grid shrink-0 grid-cols-[minmax(5rem,1fr)_minmax(5rem,1fr)_3.5rem_minmax(5rem,1fr)_3.25rem_3.25rem_3.5rem_1.75rem] border-b px-2 py-1 text-[11px] font-medium">
      <span>Name</span>
      <span>Domain</span>
      <span>Path</span>
      <span>Value</span>
      <span>HttpOnly</span>
      <span>Secure</span>
      <span>SameSite</span>
      <span className="sr-only">Delete</span>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      {cookies.length === 0 ? (
        <div className="text-muted-foreground grid h-24 place-items-center px-4 text-center text-xs">
          {empty
            ? "Cookies for this origin will appear here."
            : "No cookies match this search."}
        </div>
      ) : (
        cookies.map((cookie) => (
          <div
            className={cn(
              "hover:bg-muted/50 grid h-8 grid-cols-[minmax(5rem,1fr)_minmax(5rem,1fr)_3.5rem_minmax(5rem,1fr)_3.25rem_3.25rem_3.5rem_1.75rem] items-center px-2 font-mono text-xs",
              cookieIdentitiesEqualRow(cookie, selected) && "bg-muted"
            )}
            key={`${cookie.name}\0${cookie.domain}\0${cookie.path}`}
          >
            <button
              className="col-span-7 grid grid-cols-subgrid items-center text-left"
              onClick={() => {
                onSelect(cookie);
              }}
              type="button"
            >
              <span className="truncate">{cookie.name}</span>
              <span className="truncate">{cookie.domain}</span>
              <span className="truncate">{cookie.path}</span>
              <span className="truncate" title={cookie.value}>
                {truncateStorageValue(cookie.value)}
              </span>
              <span>{flagLabel(cookie.httpOnly)}</span>
              <span>{flagLabel(cookie.secure)}</span>
              <span>{sameSiteLabel(cookie.sameSite)}</span>
            </button>
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
        ))
      )}
    </div>
  </>
);

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
      <Field>
        <Input
          aria-invalid={draft.fieldError !== undefined}
          aria-label="New storage key"
          className="h-7 font-mono text-xs"
          onChange={(event) =>
            onDraftChange({
              ...draft,
              fieldError: undefined,
              key: event.target.value,
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit(draft);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder="Key"
          value={draft.key}
        />
        {draft.fieldError === undefined ? null : (
          <FieldError>{draft.fieldError}</FieldError>
        )}
      </Field>
      <Input
        aria-label="New storage value"
        className="h-7 font-mono text-xs"
        onChange={(event) =>
          onDraftChange({ ...draft, value: event.target.value })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(draft);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Value"
        value={draft.value}
      />
    </div>
  );
};

const WebStorageTable = ({
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
      <div className="text-muted-foreground grid shrink-0 grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_1.75rem] border-b px-2 py-1 text-[11px] font-medium">
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
                "hover:bg-muted/50 grid h-8 grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_1.75rem] items-center px-2 font-mono text-xs",
                selectedKey === key && "bg-muted"
              )}
              key={key}
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
          <Field>
            <FieldLabel htmlFor="cookie-name">Name</FieldLabel>
            <Input
              aria-invalid={form.fieldError !== undefined}
              disabled={readOnly}
              id="cookie-name"
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
            <FieldLabel htmlFor="cookie-value">Value</FieldLabel>
            <Textarea
              disabled={readOnly}
              id="cookie-value"
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
            <FieldLabel htmlFor="cookie-domain">Domain</FieldLabel>
            <Input
              disabled={readOnly}
              id="cookie-domain"
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
            <FieldLabel htmlFor="cookie-path">Path</FieldLabel>
            <Input
              disabled={readOnly}
              id="cookie-path"
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
                  sameSite:
                    value === "none-set"
                      ? undefined
                      : (value as CookieSameSite),
                })
              }
              value={form.sameSite ?? "none-set"}
            >
              <SelectTrigger aria-label="SameSite" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none-set">—</SelectItem>
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
      <FieldLabel htmlFor="storage-value">Value</FieldLabel>
      <Textarea
        disabled={locked}
        id="storage-value"
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
  sessionId,
  setUiState,
  tabId,
  tabUrl,
  uiState,
}: {
  readonly dirty: boolean;
  readonly getStorage: (request: {
    readonly payload: {
      readonly data: {
        readonly kind: StorageKind;
        readonly sessionId: SessionId;
        readonly tabId: BrowserTabId;
      };
      readonly type: "browser.storage.get";
    };
  }) => Promise<{
    readonly data: {
      readonly snapshot: Parameters<typeof applyFetchedStorageSnapshot>[2];
    };
  }>;
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly pollPaused: boolean;
  readonly refreshNonce: number;
  readonly sessionId: SessionId;
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

  const fetchKind = useCallback(
    (kind: StorageKind) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          getStorageRef.current({
            payload: {
              data: { kind, sessionId, tabId },
              type: "browser.storage.get",
            },
          }),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setUiStateRef.current((current) =>
              applyFetchedStorageSnapshot(
                current,
                tabUrlRef.current,
                result.data.snapshot
              )
            );
          })
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            onErrorRef.current(toErrorMessage(Cause.squash(cause)))
          )
        )
      ),
    [sessionId, tabId]
  );

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
      return fetchKind(uiState.storageKind).pipe(
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
  }, [dirty, fetchKind, pollPaused, refreshNonce, tabUrl, uiState.storageKind]);

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
        <div
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
        >
          {innerTabs.map((tab) => (
            <Button
              aria-selected={uiState.storageKind === tab.kind}
              className="h-6 rounded-full px-2 text-[11px]"
              key={tab.kind}
              onClick={() => {
                setUiState((current) => ({
                  ...current,
                  storageDraft: undefined,
                  storageFocused: false,
                  storageKind: tab.kind,
                  storageMutateError: undefined,
                  storageSelection:
                    current.storageSelection?.kind === tab.kind
                      ? current.storageSelection
                      : undefined,
                }));
              }}
              role="tab"
              size="sm"
              variant={uiState.storageKind === tab.kind ? "secondary" : "ghost"}
            >
              {tab.label}
              <span className="text-muted-foreground tabular-nums">
                {storageEntryCount(uiState.storageSnapshots, tab.kind)}
              </span>
            </Button>
          ))}
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
        <p className="text-muted-foreground border-b px-2 py-1 text-[11px]">
          {storageLockedMessage}
        </p>
      ) : null}
      <div className="shrink-0 border-b p-1.5">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            aria-label="Search storage"
            className="h-7 pl-7 text-xs"
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
  readonly fetchKind: StorageFetchKind;
  readonly mutationsLocked: boolean;
  readonly onError: (message: string) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly sessionId: SessionId;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly tabId: BrowserTabId;
  readonly uiState: StoragePanelUiState;
}

const StorageCookiesWorkspace = ({
  fetchKind,
  mutationsLocked,
  onError,
  onRefreshStateChange,
  sessionId,
  setUiState,
  tabId,
  uiState,
}: StorageWorkspaceProps) => {
  const setStorage = useAtomSet(browserStorageSetMutation, { mode: "promise" });
  const deleteStorage = useAtomSet(browserStorageDeleteMutation, {
    mode: "promise",
  });
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
          cookies={cookies}
          empty={uiState.storageSnapshots.cookies.length === 0}
          mutationsLocked={mutationsLocked}
          onDelete={(cookie) => {
            mutate(
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () =>
                  deleteStorage({
                    payload: {
                      data: {
                        domain: cookie.domain,
                        kind: "cookies",
                        name: cookie.name,
                        path: cookie.path,
                        sessionId,
                        tabId,
                      },
                      type: "browser.storage.delete",
                    },
                  }),
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
              Effect.gen(function* saveCookie() {
                if (recreate && identity !== undefined) {
                  yield* Effect.tryPromise({
                    catch: (cause) => cause,
                    try: () =>
                      deleteStorage({
                        payload: {
                          data: {
                            domain: identity.domain,
                            kind: "cookies",
                            name: identity.name,
                            path: identity.path,
                            sessionId,
                            tabId,
                          },
                          type: "browser.storage.delete",
                        },
                      }),
                  });
                }
                yield* Effect.tryPromise({
                  catch: (cause) => cause,
                  try: () =>
                    setStorage({
                      payload: {
                        data: {
                          cookie: write,
                          kind: "cookies",
                          sessionId,
                          tabId,
                        },
                        type: "browser.storage.set",
                      },
                    }),
                });
              })
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
  sessionId,
  setUiState,
  tabId,
  uiState,
}: StorageWorkspaceProps) => {
  const setStorage = useAtomSet(browserStorageSetMutation, { mode: "promise" });
  const deleteStorage = useAtomSet(browserStorageDeleteMutation, {
    mode: "promise",
  });
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
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () =>
                  setStorage({
                    payload: {
                      data: {
                        key: draft.key,
                        kind: draft.kind,
                        sessionId,
                        tabId,
                        value: draft.value,
                      },
                      type: "browser.storage.set",
                    },
                  }),
              })
            );
          }}
          onDelete={(key) => {
            mutate(
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () =>
                  deleteStorage({
                    payload: {
                      data: {
                        key,
                        kind: webKind,
                        sessionId,
                        tabId,
                      },
                      type: "browser.storage.delete",
                    },
                  }),
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
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () =>
                  setStorage({
                    payload: {
                      data: {
                        key: draft.key,
                        kind: draft.kind,
                        sessionId,
                        tabId,
                        value: draft.value,
                      },
                      type: "browser.storage.set",
                    },
                  }),
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
  sessionId,
  setUiState,
  tabId,
}: {
  readonly fetchKind: StorageFetchKind;
  readonly kind: StorageKind;
  readonly onError: (message: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefreshStateChange: (refreshing: boolean) => void;
  readonly open: boolean;
  readonly sessionId: SessionId;
  readonly setUiState: BrowserStoragePanelProps["setUiState"];
  readonly tabId: BrowserTabId;
}) => {
  const clearStorage = useAtomSet(browserStorageClearMutation, {
    mode: "promise",
  });
  return (
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
                  try: () =>
                    clearStorage({
                      payload: {
                        data: { kind, sessionId, tabId },
                        type: "browser.storage.clear",
                      },
                    }),
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
};

export const BrowserStoragePanel = ({
  mutationsLocked,
  onError,
  onRefreshStateChange,
  refreshNonce,
  sessionId,
  setUiState,
  tabId,
  tabUrl,
  uiState,
}: BrowserStoragePanelProps) => {
  const getStorage = useAtomSet(browserStorageGetMutation, { mode: "promise" });
  const [confirmClear, setConfirmClear] = useState(false);
  const host = httpOriginFromUrl(tabUrl)?.host;
  const dirty = isStorageDraftDirty(
    uiState.storageDraft,
    uiState.storageSnapshots
  );
  const pollPaused = uiState.storageFocused || dirty;
  const fetchKind = useStoragePolling({
    dirty,
    getStorage,
    mutationsLocked,
    onError,
    onRefreshStateChange,
    pollPaused,
    refreshNonce,
    sessionId,
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
    sessionId,
    setUiState,
    tabId,
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
        sessionId={sessionId}
        setUiState={setUiState}
        tabId={tabId}
      />
    </div>
  );
};
