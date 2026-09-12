import type {
  AgentSessionId,
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserTab,
  BrowserTabId,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { httpOriginFromUrl, isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Effect, Fiber, Result, Schedule } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent } from "react";

import {
  devicePresets,
  RESPONSIVE_PRESET_ID,
} from "@/components/browser/browser-device-presets";
import { BrowserDevtools } from "@/components/browser/browser-devtools";
import { useAgentBrowserTooling } from "@/components/browser/browser-tooling";
import type { EmulationPatch } from "@/components/browser/emulation-patch";
import { EmulationPicker } from "@/components/browser/emulation-picker";
import type { SessionEmulationState } from "@/components/browser/emulation-picker";
import { UserAgentPicker } from "@/components/browser/user-agent-picker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

/**
 * How often the setup panel re-reads what it cannot be pushed: the browser's
 * tabs and the network requests they have made.
 */
const SETUP_POLL_INTERVAL = "2 seconds";

interface SetupState {
  readonly activeTab: BrowserTab | undefined;
  readonly emulation: SessionEmulationState;
  readonly error: string | undefined;
  /** The identity the session was asked for, which it does not report back. */
  readonly identity: UserAgentProfileId;
  readonly networkRequests: readonly BrowserNetworkRequest[];
  readonly pending: boolean;
  readonly presetId: string;
}

// SAFETY: "default" is a declared UserAgentProfileId, and the session reports
// its own identity as soon as the first read lands.
const DEFAULT_IDENTITY = "default" as UserAgentProfileId;

const initialSetupState: SetupState = {
  activeTab: undefined,
  emulation: { status: "unknown" },
  error: undefined,
  identity: DEFAULT_IDENTITY,
  networkRequests: [],
  pending: false,
  presetId: RESPONSIVE_PRESET_ID,
};

const setupStateAtom = Atom.make<SetupState>(initialSetupState);

const setupErrorMessage = <Failure,>(failure: Failure): string =>
  failure instanceof Error || isBrowserRpcError(failure)
    ? failure.message
    : "The Workspace could not configure the browser.";

const presetViewport = (
  presetId: string,
  current: Viewport | undefined
): Viewport | undefined => {
  const preset = devicePresets.find(({ id }) => id === presetId);
  if (preset === undefined) {
    return undefined;
  }
  return {
    deviceScaleFactor: current?.deviceScaleFactor ?? 1,
    height: preset.height,
    width: preset.width,
  };
};

const EMPTY_TABS: readonly BrowserTab[] = [];
const EMPTY_REQUESTS: readonly BrowserNetworkRequest[] = [];

/**
 * Browser setup tooling beside the live canvas: the Emulation the session
 * applies, the identity it presents, and the devtools panels that inspect what
 * the page stored and requested. Every call is addressed by Agent Session id —
 * the MCP-owned browser has no handle the Workspace can name (ADR 0038).
 */
export const WorkspaceBrowserSetup = ({
  consoleEntries,
  onClearConsole,
  onClose,
  sessionId,
  userHoldsBrowser,
}: {
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  readonly onClearConsole: () => void;
  readonly onClose: () => void;
  readonly sessionId: AgentSessionId;
  readonly userHoldsBrowser: boolean;
}) => {
  const {
    agentBrowserEmulationMutation,
    agentBrowserEmulationQuery,
    agentBrowserNetworkRequestsMutation,
    agentBrowserTabsMutation,
  } = useRpcDependencies();
  const tooling = useAgentBrowserTooling(sessionId);
  const [state, setState] = useAtom(setupStateAtom);
  const readEmulation = useAtomSet(agentBrowserEmulationQuery, {
    mode: "promise",
  });
  const applyEmulation = useAtomSet(agentBrowserEmulationMutation, {
    mode: "promise",
  });
  const readTabs = useAtomSet(agentBrowserTabsMutation, { mode: "promise" });
  const readNetworkRequests = useAtomSet(agentBrowserNetworkRequestsMutation, {
    mode: "promise",
  });

  const refresh = Effect.gen(function* readBrowserSetup() {
    const emulation = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        readEmulation({
          payload: {
            data: { sessionId },
            type: "agent.browser.emulation.get",
          },
        }),
    });
    const tabs = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        readTabs({
          payload: { data: { sessionId }, type: "agent.browser.tabs.get" },
        }),
    });
    const activeTab =
      (tabs.data.tabs ?? EMPTY_TABS).find(({ active }) => active) ??
      tabs.data.tabs[0];
    const requests: readonly BrowserNetworkRequest[] =
      activeTab === undefined
        ? EMPTY_REQUESTS
        : (yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              readNetworkRequests({
                payload: {
                  data: { sessionId, tabId: activeTab.tabId },
                  type: "agent.browser.network.requests.get",
                },
              }),
          })).data.requests;
    setState((current) => ({
      ...current,
      activeTab,
      emulation: { emulation: emulation.data.emulation, status: "known" },
      error: undefined,
      identity: emulation.data.userAgentProfile,
      networkRequests: requests,
    }));
  }).pipe(
    Effect.catchCause(
      () =>
        // A poll that lost the browser must not blank what the panel shows: the
        // next tick recovers, and an error banner here would flicker.
        Effect.void
    )
  );
  const refreshFromEffect = useEffectEvent(() => refresh);

  useEffect(() => {
    setState(() => initialSetupState);
    const fiber = Effect.runFork(
      Effect.suspend(refreshFromEffect).pipe(
        Effect.repeat(Schedule.spaced(SETUP_POLL_INTERVAL))
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [sessionId, setState]);

  const patch = (
    change: EmulationPatch & {
      readonly userAgentProfile?: UserAgentProfileId | undefined;
      readonly viewport?: Viewport | undefined;
    }
  ) => {
    setState((current) => ({ ...current, error: undefined, pending: true }));
    Effect.runFork(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            applyEmulation({
              payload: {
                data: { ...change, sessionId },
                type: "agent.browser.emulation.set",
              },
            }),
        })
      ).pipe(
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            setState((current) =>
              Result.isFailure(outcome)
                ? {
                    ...current,
                    error: setupErrorMessage(outcome.failure),
                    pending: false,
                  }
                : {
                    ...current,
                    emulation: {
                      emulation: outcome.success.data.emulation,
                      status: "known",
                    },
                    error: undefined,
                    identity: outcome.success.data.userAgentProfile,
                    pending: false,
                  }
            );
          })
        )
      )
    );
  };

  const applied =
    state.emulation.status === "known" ? state.emulation.emulation : undefined;
  const disabled = !userHoldsBrowser || state.pending;
  const activeUrl = state.activeTab?.url;
  const origin =
    activeUrl === undefined ? undefined : httpOriginFromUrl(activeUrl)?.origin;

  return (
    <section
      aria-label="Browser setup"
      className="flex min-h-0 flex-col border-t"
    >
      <div className="bg-background flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        {/*
          An identity moves every signal it implies together (ADR 0013). The
          session applies the identity's own device metrics, so the identity
          travels alone rather than beside a viewport this View may not have
          read yet.
        */}
        <UserAgentPicker
          disabled={disabled}
          onValueChange={(userAgentProfile) => {
            setState((current) => ({
              ...current,
              presetId: RESPONSIVE_PRESET_ID,
            }));
            patch({ userAgentProfile });
          }}
          value={state.identity}
        />
        <Select
          disabled={disabled}
          onValueChange={(value) => {
            if (value === null) {
              return;
            }
            setState((current) => ({ ...current, presetId: value }));
            const viewport = presetViewport(value, applied?.viewport);
            if (viewport !== undefined) {
              patch({ viewport });
            }
          }}
          value={state.presetId}
        >
          <SelectTrigger aria-label="Device" className="w-44" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={RESPONSIVE_PRESET_ID}>Responsive</SelectItem>
            {devicePresets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <EmulationPicker
          applied={state.emulation}
          currentOrigin={origin}
          disabled={disabled}
          onPatch={patch}
        />
        {applied === undefined ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            {applied.viewport.width} × {applied.viewport.height}
          </span>
        )}
        <Button
          className="ml-auto"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Hide setup
        </Button>
      </div>
      {state.error === undefined ? null : (
        <p className="text-destructive border-b px-3 py-1.5 text-xs">
          {state.error}
        </p>
      )}
      {userHoldsBrowser ? null : (
        <p className="text-muted-foreground border-b px-3 py-1.5 text-xs">
          The agent holds the browser. Take control to change its Emulation or
          storage.
        </p>
      )}
      {state.activeTab === undefined ? (
        <p className="text-muted-foreground p-3 text-xs">
          Waiting for the browser to open a page.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <BrowserDevtools
            consoleEntries={consoleEntries}
            key={state.activeTab.tabId}
            mutationsLocked={!userHoldsBrowser}
            networkRequests={state.networkRequests}
            onClearConsole={onClearConsole}
            onClearNetwork={() =>
              setState((current) => ({ ...current, networkRequests: [] }))
            }
            onClose={onClose}
            onError={(message) =>
              setState((current) => ({ ...current, error: message }))
            }
            onRefreshNetwork={() => {
              Effect.runFork(refresh);
            }}
            refreshingNetwork={false}
            tabId={state.activeTab.tabId satisfies BrowserTabId}
            tabTitle={state.activeTab.title || "Current tab"}
            tabUrl={state.activeTab.url}
            tooling={tooling}
          />
        </div>
      )}
    </section>
  );
};
