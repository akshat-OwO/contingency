import type {
  BrowserSession,
  SessionId,
  Viewport,
} from "@contingency/protocol";
import { isBrowserRpcError } from "@contingency/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  LoaderCircleIcon,
  MonitorIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  browserSessionAttachMutation,
  browserSessionCloseMutation,
  browserSessionCreateMutation,
  browserSessionsAtom,
} from "@/lib/rpc";

const createItemPrefix = "__create_session__:";
const noSessions: readonly BrowserSession[] = [];
const validSessionSuffix = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Unable to update browser session";

const sessionNameToCreate = (
  sessions: readonly BrowserSession[],
  query: string
): string | undefined => {
  const trimmed = query.trim();
  const name = trimmed.startsWith("create-") ? trimmed : `create-${trimmed}`;
  const suffix = name.slice("create-".length);

  return validSessionSuffix.test(suffix) &&
    !sessions.some(({ id }) => id === name)
    ? name
    : undefined;
};

interface BrowserSessionPickerProps {
  readonly onDelete: (sessionId: SessionId) => void;
  readonly onSelect: (sessionId: SessionId, url: string) => void;
  readonly selectedSessionId: SessionId | undefined;
  readonly viewport: Viewport;
}

export const BrowserSessionPicker = ({
  onDelete,
  onSelect,
  selectedSessionId,
  viewport,
}: BrowserSessionPickerProps) => {
  const sessionsResult = useAtomValue(browserSessionsAtom);
  const refreshSessions = useAtomRefresh(browserSessionsAtom);
  const createSession = useAtomSet(browserSessionCreateMutation, {
    mode: "promise",
  });
  const attachSession = useAtomSet(browserSessionAttachMutation, {
    mode: "promise",
  });
  const closeSession = useAtomSet(browserSessionCloseMutation, {
    mode: "promise",
  });
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const sessions =
    sessionsResult._tag === "Success"
      ? sessionsResult.value.data.sessions
      : noSessions;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(
    () =>
      normalizedQuery.length === 0
        ? sessions
        : sessions.filter(({ id }) =>
            id.toLocaleLowerCase().includes(normalizedQuery)
          ),
    [normalizedQuery, sessions]
  );
  const createName = sessionNameToCreate(sessions, query);
  const createItemValue =
    createName === undefined ? undefined : `${createItemPrefix}${createName}`;
  const items = useMemo(
    () => [
      ...sessions.map(({ id }) => id),
      ...(createItemValue === undefined ? [] : [createItemValue]),
    ],
    [createItemValue, sessions]
  );
  const filteredItems = useMemo(
    () => [
      ...visibleSessions.map(({ id }) => id),
      ...(createItemValue === undefined ? [] : [createItemValue]),
    ],
    [createItemValue, visibleSessions]
  );
  const loading = sessionsResult._tag === "Initial" || sessionsResult.waiting;

  const completeAction = (sessionId: SessionId, url: string) => {
    onSelect(sessionId, url);
    setOpen(false);
    setQuery("");
    refreshSessions();
  };

  const runAction = async (
    action:
      | { readonly _tag: "create"; readonly name: string }
      | { readonly _tag: "attach"; readonly sessionId: SessionId }
  ) => {
    if (pending) {
      return;
    }

    setError(undefined);
    setPending(true);

    try {
      if (action._tag === "create") {
        const result = await createSession({
          payload: {
            data: { name: action.name, viewport },
            type: "browser.session.create",
          },
        });
        completeAction(result.data.sessionId, "");
      } else {
        const result = await attachSession({
          payload: {
            data: { sessionId: action.sessionId },
            type: "browser.session.attach",
          },
        });
        completeAction(result.data.sessionId, result.data.url);
      }
    } catch (actionError) {
      setError(toErrorMessage(actionError));
    } finally {
      setPending(false);
    }
  };

  const selectSession = async (nextValue: string | null) => {
    if (nextValue === null || pending) {
      return;
    }

    if (nextValue === createItemValue && createName !== undefined) {
      await runAction({ _tag: "create", name: createName });
      return;
    }

    const session = sessions.find(({ id }) => id === nextValue);
    if (session !== undefined) {
      await runAction({ _tag: "attach", sessionId: session.id });
    }
  };

  const createOnEnter = async (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || createName === undefined || pending) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await runAction({ _tag: "create", name: createName });
  };

  const deleteSelectedSession = async () => {
    if (selectedSessionId === undefined || pending) {
      return;
    }

    setError(undefined);
    setPending(true);
    try {
      await closeSession({
        payload: {
          data: { sessionId: selectedSessionId },
          type: "browser.session.close",
        },
      });
      onDelete(selectedSessionId);
      setOpen(false);
      setQuery("");
      refreshSessions();
    } catch (closeError) {
      setError(toErrorMessage(closeError));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Combobox
        filteredItems={filteredItems}
        items={items}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          setError(undefined);
          if (nextOpen) {
            refreshSessions();
          } else {
            setQuery("");
          }
        }}
        onValueChange={selectSession}
        open={open}
        value={selectedSessionId ?? null}
      >
        <ComboboxTrigger
          aria-label={
            selectedSessionId === undefined
              ? "Choose browser session"
              : `Browser session: ${selectedSessionId}`
          }
          className="max-w-52 shrink-0"
          disabled={pending}
          render={<Button size="sm" variant="outline" />}
        >
          <MonitorIcon data-icon="inline-start" />
          <span className="hidden max-w-32 truncate 2xl:inline">
            {selectedSessionId ?? "Session"}
          </span>
        </ComboboxTrigger>
        <ComboboxContent align="end" className="w-72">
          <div className="contents" onKeyDownCapture={createOnEnter}>
            <ComboboxInput
              autoFocus
              disabled={pending}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search or create a session..."
              showTrigger={false}
              value={query}
            />
          </div>
          <ComboboxList>
            {loading ? (
              <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading sessions...
              </div>
            ) : null}
            {loading || sessionsResult._tag !== "Failure" ? null : (
              <div className="text-destructive px-2 py-3 text-sm">
                Unable to load browser sessions.
              </div>
            )}
            {loading ? null : (
              <ComboboxEmpty>No matching sessions.</ComboboxEmpty>
            )}
            {loading || createName === undefined ? null : (
              <ComboboxItem disabled={pending} value={createItemValue}>
                <PlusIcon />
                <span className="truncate">Create session “{createName}”</span>
              </ComboboxItem>
            )}
            {loading
              ? null
              : visibleSessions.map(({ id }) => (
                  <ComboboxItem disabled={pending} key={id} value={id}>
                    <MonitorIcon />
                    <span className="truncate">{id}</span>
                  </ComboboxItem>
                ))}
          </ComboboxList>
          {pending ? (
            <div className="text-muted-foreground flex items-center gap-2 border-t px-2 py-2 text-xs">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Updating session...
            </div>
          ) : null}
          {error === undefined ? null : (
            <p
              className="text-destructive border-t px-2 py-2 text-xs"
              role="alert"
            >
              {error}
            </p>
          )}
        </ComboboxContent>
      </Combobox>
      <Button
        aria-label="Delete current browser session"
        disabled={selectedSessionId === undefined || pending}
        onClick={() => {
          void deleteSelectedSession();
        }}
        size="icon-sm"
        title="Delete current session"
        variant="ghost"
      >
        {pending ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <Trash2Icon />
        )}
      </Button>
    </div>
  );
};
