import { isBrowserRpcError } from "@contingency/protocol";
import type {
  BrowserInput,
  BrowserStreamEvent,
  BrowserTab,
  Geolocation,
  MouseButton,
  SessionId,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Effect, Fiber, Queue, Result, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Globe2Icon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  PanelBottomIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";

import { BrowserDevtools } from "@/components/create/browser-devtools";
import {
  appendConsoleEntry,
  browserDevtoolsAtom,
  clearTabConsole,
  clearTabNetwork,
  getTabDevtoolsData,
  mergeNetworkRequests,
  removeSessionDevtools,
} from "@/components/create/browser-devtools-state";
import { BrowserSessionPicker } from "@/components/create/browser-session-picker";
import { GeolocationPicker } from "@/components/create/geolocation-picker";
import { UserAgentPicker } from "@/components/create/user-agent-picker";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  browserInputMutation,
  browserGeolocationGetMutation,
  browserGeolocationMutation,
  browserNetworkRequestsMutation,
  browserNavigationMutation,
  browserOpenMutation,
  browserTabCloseMutation,
  browserTabNewMutation,
  browserTabsMutation,
  browserTabSwitchMutation,
  browserUserAgentMutation,
  browserViewportMutation,
  runBrowserStream,
} from "@/lib/rpc";

const RESPONSIVE_PRESET_ID = "responsive";
const DIMENSION_PATTERN = /^\d{0,4}$/u;
const userAgentProfileAtom = Atom.make<UserAgentProfileId>("default");
const browserTabsAtom = Atom.make<readonly BrowserTab[]>([]);
const sessionGeolocationsAtom = Atom.make<ReadonlyMap<SessionId, Geolocation>>(
  new Map()
);

const keyboardKeyInfo: Readonly<
  Record<string, { readonly keyCode: number; readonly text?: string }>
> = {
  ArrowDown: { keyCode: 40 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  ArrowUp: { keyCode: 38 },
  Backspace: { keyCode: 8, text: "\b" },
  Delete: { keyCode: 46 },
  End: { keyCode: 35 },
  Enter: { keyCode: 13, text: "\r" },
  Escape: { keyCode: 27 },
  Home: { keyCode: 36 },
  PageDown: { keyCode: 34 },
  PageUp: { keyCode: 33 },
  Tab: { keyCode: 9, text: "\t" },
};

const devicePresets = [
  { height: 667, id: "iphone-se", name: "iPhone SE", width: 375 },
  { height: 896, id: "iphone-xr", name: "iPhone XR", width: 414 },
  { height: 844, id: "iphone-12-pro", name: "iPhone 12 Pro", width: 390 },
  {
    height: 932,
    id: "iphone-14-pro-max",
    name: "iPhone 14 Pro Max",
    width: 430,
  },
  { height: 915, id: "pixel-7", name: "Pixel 7", width: 412 },
  {
    height: 740,
    id: "samsung-galaxy-s8-plus",
    name: "Samsung Galaxy S8+",
    width: 360,
  },
  {
    height: 915,
    id: "samsung-galaxy-s20-ultra",
    name: "Samsung Galaxy S20 Ultra",
    width: 412,
  },
  { height: 1024, id: "ipad-mini", name: "iPad Mini", width: 768 },
  { height: 1180, id: "ipad-air", name: "iPad Air", width: 820 },
  { height: 1366, id: "ipad-pro", name: "iPad Pro", width: 1024 },
  { height: 1368, id: "surface-pro-7", name: "Surface Pro 7", width: 912 },
  { height: 720, id: "surface-duo", name: "Surface Duo", width: 540 },
  {
    height: 882,
    id: "galaxy-z-fold-5",
    name: "Galaxy Z Fold 5",
    width: 344,
  },
  {
    height: 1280,
    id: "asus-zenbook-fold",
    name: "Asus Zenbook Fold",
    width: 853,
  },
  {
    height: 914,
    id: "samsung-galaxy-a51-71",
    name: "Samsung Galaxy A51/71",
    width: 412,
  },
  { height: 600, id: "nest-hub", name: "Nest Hub", width: 1024 },
  { height: 800, id: "nest-hub-max", name: "Nest Hub Max", width: 1280 },
] as const;

const presetName = (presetId: string): string => {
  if (presetId === RESPONSIVE_PRESET_ID) {
    return "Responsive";
  }
  return devicePresets.find(({ id }) => id === presetId)?.name ?? "Responsive";
};

const pointerButton = (button: number): typeof MouseButton.Type => {
  switch (button) {
    case 1: {
      return "middle";
    }
    case 2: {
      return "right";
    }
    case 3: {
      return "back";
    }
    case 4: {
      return "forward";
    }
    default: {
      return "left";
    }
  }
};

const keyboardModifiers = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
): number =>
  (event.altKey ? 1 : 0) +
  (event.ctrlKey ? 2 : 0) +
  (event.metaKey ? 4 : 0) +
  (event.shiftKey ? 8 : 0);

const mousePosition = (
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY">
) => {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
    y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
  };
};

const renderFrame = (
  canvas: HTMLCanvasElement,
  event: Extract<BrowserStreamEvent, { readonly type: "frame" }>
) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const binary = globalThis.atob(event.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
      }

      const bitmap = await globalThis.createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" })
      );
      const context = canvas.getContext("2d", { alpha: false });
      if (context !== null) {
        canvas.width = event.metadata.deviceWidth;
        canvas.height = event.metadata.deviceHeight;
        // Chromium keeps a wider capture surface for narrow viewports. Preserve
        // one CSS pixel per canvas pixel by cropping it instead of stretching it.
        const sourceWidth = Math.min(bitmap.width, canvas.width);
        const sourceHeight = Math.min(bitmap.height, canvas.height);
        context.drawImage(
          bitmap,
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
      }
      bitmap.close();
    },
  }).pipe(Effect.ignore);

const toErrorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Browser operation failed";

interface BrowserTabStripProps {
  readonly onClose: (tab: BrowserTab) => void;
  readonly onCreate: () => void;
  readonly onSwitch: (tab: BrowserTab) => void;
  readonly sessionSelected: boolean;
  readonly tabs: readonly BrowserTab[];
}

const BrowserTabStrip = ({
  onClose,
  onCreate,
  onSwitch,
  sessionSelected,
  tabs,
}: BrowserTabStripProps) => {
  if (!sessionSelected) {
    return null;
  }

  return (
    <div className="bg-muted/30 flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-2 pt-1">
      {tabs.map((tab) => (
        <div
          className={
            tab.active
              ? "bg-background flex h-8 max-w-56 min-w-28 items-center rounded-t-md border border-b-0"
              : "hover:bg-muted flex h-8 max-w-56 min-w-28 items-center rounded-t-md border border-transparent"
          }
          key={tab.tabId}
        >
          <button
            className="min-w-0 flex-1 truncate px-2 text-left text-xs"
            onClick={() => onSwitch(tab)}
            title={tab.title || tab.url || "New tab"}
            type="button"
          >
            {tab.title || (tab.url === "about:blank" ? "New tab" : tab.url)}
          </button>
          {tabs.length > 1 ? (
            <Button
              aria-label={`Close ${tab.title || "tab"}`}
              className="mr-0.5 size-6"
              onClick={() => onClose(tab)}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      ))}
      <Button
        aria-label="New tab"
        className="mb-0.5 shrink-0"
        onClick={onCreate}
        size="icon-sm"
        variant="ghost"
      >
        <PlusIcon />
      </Button>
    </div>
  );
};

const devtoolsContext = (
  open: boolean,
  sessionId: SessionId | undefined,
  activeTab: BrowserTab | undefined
):
  | { readonly activeTab: BrowserTab; readonly sessionId: SessionId }
  | undefined =>
  open && sessionId !== undefined && activeTab !== undefined
    ? { activeTab, sessionId }
    : undefined;

const useBrowserWorkspace = () => {
  const addressEditingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const frameRenderFiberRef = useRef<Fiber.Fiber<void, unknown> | null>(null);
  const inputQueueRef = useRef<Queue.Queue<BrowserInput> | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<BrowserInput | null>(null);
  const pendingFrameRef = useRef<Extract<
    BrowserStreamEvent,
    { readonly type: "frame" }
  > | null>(null);
  const knownTabIdsRef = useRef<ReadonlySet<string> | null>(null);
  const [address, setAddress] = useState("");
  const [devtoolsState, setDevtoolsState] = useAtom(browserDevtoolsAtom);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [frameReady, setFrameReady] = useState(false);
  const [height, setHeight] = useState("720");
  const [opening, setOpening] = useState(false);
  const [refreshingNetwork, setRefreshingNetwork] = useState(false);
  const [presetId, setPresetId] = useState(RESPONSIVE_PRESET_ID);
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId>();
  const [sessionGeolocations, setSessionGeolocations] = useAtom(
    sessionGeolocationsAtom
  );
  const [streamConnected, setStreamConnected] = useState(false);
  const [tabs, setTabs] = useAtom(browserTabsAtom);
  const [width, setWidth] = useState("1280");
  const [userAgentProfile, setUserAgentProfile] = useAtom(userAgentProfileAtom);
  const openBrowser = useAtomSet(browserOpenMutation, { mode: "promise" });
  const getBrowserGeolocation = useAtomSet(browserGeolocationGetMutation, {
    mode: "promise",
  });
  const updateBrowserGeolocation = useAtomSet(browserGeolocationMutation, {
    mode: "promise",
  });
  const runNavigation = useAtomSet(browserNavigationMutation, {
    mode: "promise",
  });
  const updateViewport = useAtomSet(browserViewportMutation, {
    mode: "promise",
  });
  const updateUserAgent = useAtomSet(browserUserAgentMutation, {
    mode: "promise",
  });
  const sendBrowserInput = useAtomSet(browserInputMutation, {
    mode: "promise",
  });
  const getBrowserTabs = useAtomSet(browserTabsMutation, { mode: "promise" });
  const newBrowserTab = useAtomSet(browserTabNewMutation, { mode: "promise" });
  const switchBrowserTab = useAtomSet(browserTabSwitchMutation, {
    mode: "promise",
  });
  const closeBrowserTab = useAtomSet(browserTabCloseMutation, {
    mode: "promise",
  });
  const getNetworkRequests = useAtomSet(browserNetworkRequestsMutation, {
    mode: "promise",
  });
  const selectedPresetName = presetName(presetId);
  const geolocation =
    selectedSessionId === undefined
      ? null
      : (sessionGeolocations.get(selectedSessionId) ?? null);
  const activeTab = tabs.find(({ active }) => active);
  const visibleDevtools = devtoolsContext(
    devtoolsOpen,
    selectedSessionId,
    activeTab
  );
  const activeTabData = getTabDevtoolsData(
    devtoolsState,
    selectedSessionId,
    activeTab?.tabId
  );
  const viewport: Viewport = {
    deviceScaleFactor: 1,
    height: Math.max(1, Number(height) || 720),
    width: Math.max(1, Number(width) || 1280),
  };

  useEffect(() => {
    knownTabIdsRef.current = null;
    activeTabIdRef.current = null;
    setTabs([]);
  }, [selectedSessionId, setTabs]);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      return;
    }

    let cancelled = false;
    const synchronizeGeolocation = async () => {
      try {
        const result = await getBrowserGeolocation({
          payload: {
            data: { sessionId: selectedSessionId },
            type: "browser.geolocation.get",
          },
        });
        if (!cancelled) {
          setSessionGeolocations((knownGeolocations) => {
            const updated = new Map(knownGeolocations);
            if (result.data.geolocation === null) {
              updated.delete(selectedSessionId);
            } else {
              updated.set(selectedSessionId, result.data.geolocation);
            }
            return updated;
          });
        }
      } catch (geolocationError) {
        if (!cancelled) {
          setError(toErrorMessage(geolocationError));
        }
      }
    };
    void synchronizeGeolocation();

    return () => {
      cancelled = true;
    };
  }, [getBrowserGeolocation, selectedSessionId, setSessionGeolocations]);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      return;
    }

    let cancelled = false;
    let refreshing = false;
    const synchronizeTabs = async (switchNewTab: boolean) => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      try {
        let result = await getBrowserTabs({
          payload: {
            data: { sessionId: selectedSessionId },
            type: "browser.tabs.get",
          },
        });
        const knownTabIds = knownTabIdsRef.current;
        const newTab =
          knownTabIds === null
            ? undefined
            : result.data.tabs.find(({ tabId }) => !knownTabIds.has(tabId));

        if (switchNewTab && newTab !== undefined) {
          await switchBrowserTab({
            payload: {
              data: { sessionId: selectedSessionId, tabId: newTab.tabId },
              type: "browser.tab.switch",
            },
          });
          if (!cancelled) {
            setFrameReady(false);
          }
          result = await getBrowserTabs({
            payload: {
              data: { sessionId: selectedSessionId },
              type: "browser.tabs.get",
            },
          });
        }

        if (!cancelled) {
          knownTabIdsRef.current = new Set(
            result.data.tabs.map(({ tabId }) => tabId)
          );
          setTabs(result.data.tabs);
          const activeSessionTab = result.data.tabs.find(
            ({ active }) => active
          );
          if (activeSessionTab !== undefined) {
            const activeTabChanged =
              activeTabIdRef.current !== activeSessionTab.tabId;
            activeTabIdRef.current = activeSessionTab.tabId;
            if (activeTabChanged || !addressEditingRef.current) {
              setAddress(
                activeSessionTab.url === "about:blank"
                  ? ""
                  : activeSessionTab.url
              );
            }
          }
        }
      } catch (tabsError) {
        if (!cancelled) {
          setError(toErrorMessage(tabsError));
        }
      } finally {
        refreshing = false;
      }
    };

    void synchronizeTabs(false);
    const interval = globalThis.setInterval(() => {
      void synchronizeTabs(true);
    }, 750);

    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
    };
  }, [getBrowserTabs, selectedSessionId, setTabs, switchBrowserTab]);

  const refreshNetwork = useCallback(async () => {
    if (selectedSessionId === undefined) {
      return;
    }
    try {
      const result = await getNetworkRequests({
        payload: {
          data: { sessionId: selectedSessionId },
          type: "browser.network.requests.get",
        },
      });
      const activeTabId = activeTabIdRef.current;
      if (activeTabId !== null) {
        setDevtoolsState((state) =>
          mergeNetworkRequests(
            state,
            selectedSessionId,
            activeTabId,
            result.data.requests
          )
        );
      }
    } catch (networkError) {
      setError(toErrorMessage(networkError));
    }
  }, [getNetworkRequests, selectedSessionId, setDevtoolsState]);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      return;
    }
    void refreshNetwork();
    const interval = globalThis.setInterval(() => {
      void refreshNetwork();
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, [refreshNetwork, selectedSessionId]);

  const manuallyRefreshNetwork = async () => {
    setRefreshingNetwork(true);
    try {
      await refreshNetwork();
    } finally {
      setRefreshingNetwork(false);
    }
  };

  const enqueueFrame = useCallback(
    (event: Extract<BrowserStreamEvent, { readonly type: "frame" }>) => {
      pendingFrameRef.current = event;
      if (frameRenderFiberRef.current !== null) {
        return;
      }

      const renderFrames = Effect.gen(function* renderLatestFrames() {
        while (pendingFrameRef.current !== null) {
          const latestFrame = pendingFrameRef.current;
          pendingFrameRef.current = null;
          const canvas = canvasRef.current;
          if (canvas !== null) {
            yield* renderFrame(canvas, latestFrame);
            setFrameReady(true);
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            frameRenderFiberRef.current = null;
          })
        )
      );
      frameRenderFiberRef.current = Effect.runFork(renderFrames);
    },
    []
  );

  useEffect(() => {
    if (selectedSessionId === undefined) {
      setFrameReady(false);
      setStreamConnected(false);
      return;
    }

    setError(undefined);
    setFrameReady(false);
    setStreamConnected(false);
    const streamEffect = Effect.gen(function* consumeBrowserStream() {
      const outcome = yield* Effect.result(
        runBrowserStream(selectedSessionId, (event) => {
          if (event.type === "frame") {
            return Effect.sync(() => enqueueFrame(event));
          }

          return Effect.sync(() => {
            if (event.type === "url") {
              setAddress(event.url);
              return;
            }

            if (event.type === "console" || event.type === "page_error") {
              const activeTabId = activeTabIdRef.current;
              if (activeTabId !== null) {
                setDevtoolsState((state) =>
                  appendConsoleEntry(
                    state,
                    selectedSessionId,
                    activeTabId,
                    event
                  )
                );
              }
              return;
            }

            if (event.type === "tabs") {
              setTabs(event.tabs);
              const activeSessionTab = event.tabs.find(({ active }) => active);
              if (activeSessionTab !== undefined) {
                const activeTabChanged =
                  activeTabIdRef.current !== activeSessionTab.tabId;
                activeTabIdRef.current = activeSessionTab.tabId;
                if (activeTabChanged || !addressEditingRef.current) {
                  setAddress(
                    activeSessionTab.url === "about:blank"
                      ? ""
                      : activeSessionTab.url
                  );
                }
              }
              return;
            }

            setStreamConnected(event.connected && event.screencasting);
            if (event.viewportWidth > 0 && event.viewportHeight > 0) {
              setPresetId(RESPONSIVE_PRESET_ID);
              setWidth(String(event.viewportWidth));
              setHeight(String(event.viewportHeight));
            }
          });
        })
      );

      if (Result.isFailure(outcome)) {
        setStreamConnected(false);
        setError(toErrorMessage(outcome.failure));
      }
    });
    const streamFiber = Effect.runFork(streamEffect);

    return () => {
      Effect.runFork(Fiber.interrupt(streamFiber));
      const frameFiber = frameRenderFiberRef.current;
      if (frameFiber !== null) {
        Effect.runFork(Fiber.interrupt(frameFiber));
        frameRenderFiberRef.current = null;
      }
      pendingFrameRef.current = null;
    };
  }, [enqueueFrame, selectedSessionId, setDevtoolsState, setTabs]);

  useEffect(
    () => () => {
      if (moveFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(moveFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedSessionId === undefined) {
      inputQueueRef.current = null;
      return;
    }

    let ownedQueue: Queue.Queue<BrowserInput> | null = null;
    const inputEffect = Effect.gen(function* forwardBrowserInput() {
      const queue = yield* Queue.make<BrowserInput>();
      ownedQueue = queue;
      inputQueueRef.current = queue;

      yield* Stream.fromQueue(queue).pipe(
        Stream.runForEach((input) =>
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              sendBrowserInput({
                payload: {
                  data: { input, sessionId: selectedSessionId },
                  type: "browser.input.send",
                },
              }),
          }).pipe(
            Effect.catch((inputError) =>
              Effect.sync(() => {
                setError(toErrorMessage(inputError));
              })
            )
          )
        )
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (inputQueueRef.current === ownedQueue) {
            inputQueueRef.current = null;
          }
        })
      )
    );
    const inputFiber = Effect.runFork(inputEffect);

    return () => {
      Effect.runFork(Fiber.interrupt(inputFiber));
    };
  }, [selectedSessionId, sendBrowserInput]);

  const dispatchInput = useCallback((input: BrowserInput) => {
    const queue = inputQueueRef.current;
    if (queue !== null) {
      Effect.runFork(Queue.offer(queue, input));
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dispatchInput({
        ...mousePosition(canvas, event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        eventType: "mouseWheel",
        modifiers: keyboardModifiers(event),
        type: "input_mouse",
      });
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [dispatchInput]);

  const submitAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (opening || address.trim().length === 0) {
      return;
    }

    setError(undefined);
    setOpening(true);
    try {
      const result = await openBrowser({
        payload: {
          data: {
            sessionId: selectedSessionId,
            url: address,
            userAgentProfile,
            viewport,
          },
          type: "browser.open",
        },
      });
      setSelectedSessionId(result.data.sessionId);
      setAddress(result.data.url);
    } catch (openError) {
      setError(toErrorMessage(openError));
    } finally {
      setOpening(false);
    }
  };

  const selectUserAgent = async (profile: UserAgentProfileId) => {
    setUserAgentProfile(profile);
    if (
      selectedSessionId === undefined ||
      address.trim().length === 0 ||
      opening
    ) {
      return;
    }

    setError(undefined);
    setOpening(true);
    try {
      const result = await updateUserAgent({
        payload: {
          data: {
            sessionId: selectedSessionId,
            url: address,
            userAgentProfile: profile,
            viewport,
          },
          type: "browser.user-agent.set",
        },
      });
      setAddress(result.data.url);
    } catch (userAgentError) {
      setError(toErrorMessage(userAgentError));
    } finally {
      setOpening(false);
    }
  };

  const applyGeolocation = async (nextGeolocation: Geolocation) => {
    if (selectedSessionId === undefined) {
      throw new Error("Choose a browser session before setting a location.");
    }
    const result = await updateBrowserGeolocation({
      payload: {
        data: {
          geolocation: nextGeolocation,
          sessionId: selectedSessionId,
        },
        type: "browser.geolocation.set",
      },
    });
    setSessionGeolocations(
      (knownGeolocations) =>
        new Map([
          ...knownGeolocations,
          [selectedSessionId, result.data.geolocation] as const,
        ])
    );
  };

  const navigate = async (action: "back" | "forward" | "reload") => {
    if (selectedSessionId === undefined) {
      return;
    }
    try {
      await runNavigation({
        payload: {
          data: { action, sessionId: selectedSessionId },
          type: "browser.navigation.run",
        },
      });
    } catch (navigationError) {
      setError(toErrorMessage(navigationError));
    }
  };

  const selectSession = (sessionId: SessionId, url: string) => {
    setAddress(url === "about:blank" ? "" : url);
    setSelectedSessionId(sessionId);
  };

  const deleteSession = (sessionId: SessionId) => {
    setDevtoolsState((state) => removeSessionDevtools(state, sessionId));
    setSessionGeolocations((knownGeolocations) => {
      const updated = new Map(knownGeolocations);
      updated.delete(sessionId);
      return updated;
    });
    if (selectedSessionId === sessionId) {
      setAddress("");
      setFrameReady(false);
      setStreamConnected(false);
      setSelectedSessionId(undefined);
    }
  };

  const createTab = async () => {
    if (selectedSessionId === undefined) {
      return;
    }
    try {
      await newBrowserTab({
        payload: {
          data: { sessionId: selectedSessionId },
          type: "browser.tab.new",
        },
      });
      setAddress("");
      setFrameReady(false);
    } catch (tabError) {
      setError(toErrorMessage(tabError));
    }
  };

  const switchTab = async (tab: BrowserTab) => {
    if (selectedSessionId === undefined || tab.active) {
      return;
    }
    try {
      await switchBrowserTab({
        payload: {
          data: { sessionId: selectedSessionId, tabId: tab.tabId },
          type: "browser.tab.switch",
        },
      });
      setAddress(tab.url === "about:blank" ? "" : tab.url);
      activeTabIdRef.current = tab.tabId;
      setFrameReady(false);
    } catch (tabError) {
      setError(toErrorMessage(tabError));
    }
  };

  const closeTab = async (tab: BrowserTab) => {
    if (selectedSessionId === undefined) {
      return;
    }
    try {
      await closeBrowserTab({
        payload: {
          data: { sessionId: selectedSessionId, tabId: tab.tabId },
          type: "browser.tab.close",
        },
      });
      const remainingTabIds = new Set<string>();
      for (const { tabId } of tabs) {
        if (tabId !== tab.tabId) {
          remainingTabIds.add(tabId);
        }
      }
      knownTabIdsRef.current = remainingTabIds;
      if (tab.active) {
        setFrameReady(false);
      }
    } catch (tabError) {
      setError(toErrorMessage(tabError));
    }
  };

  const applyViewport = async (nextViewport: Viewport) => {
    if (selectedSessionId === undefined) {
      return;
    }
    try {
      await updateViewport({
        payload: {
          data: { sessionId: selectedSessionId, viewport: nextViewport },
          type: "browser.viewport.set",
        },
      });
    } catch (viewportError) {
      setError(toErrorMessage(viewportError));
    }
  };

  const selectPreset = async (nextPresetId: string | null) => {
    if (nextPresetId === null) {
      return;
    }
    setPresetId(nextPresetId);
    const preset = devicePresets.find(({ id }) => id === nextPresetId);
    if (preset === undefined) {
      return;
    }
    setWidth(String(preset.width));
    setHeight(String(preset.height));
    await applyViewport({
      deviceScaleFactor: 1,
      height: preset.height,
      width: preset.width,
    });
  };

  const updateDimension = (
    nextValue: string,
    setDimension: (value: string) => void
  ) => {
    if (!DIMENSION_PATTERN.test(nextValue)) {
      return;
    }
    setPresetId(RESPONSIVE_PRESET_ID);
    setDimension(nextValue);
  };

  const commitViewport = async () => {
    await applyViewport(viewport);
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position = mousePosition(event.currentTarget, event);
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatchInput({
      ...position,
      button: pointerButton(event.button),
      clickCount: Math.max(1, event.detail),
      eventType: "mousePressed",
      modifiers: keyboardModifiers(event),
      type: "input_mouse",
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position = mousePosition(event.currentTarget, event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dispatchInput({
      ...position,
      button: pointerButton(event.button),
      clickCount: Math.max(1, event.detail),
      eventType: "mouseReleased",
      modifiers: keyboardModifiers(event),
      type: "input_mouse",
    });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const position = mousePosition(event.currentTarget, event);
    pendingMoveRef.current = {
      ...position,
      button: "none",
      eventType: "mouseMoved",
      modifiers: keyboardModifiers(event),
      type: "input_mouse",
    };
    if (moveFrameRef.current !== null) {
      return;
    }
    moveFrameRef.current = globalThis.requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const input = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (input !== null) {
        dispatchInput(input);
      }
    });
  };

  const handleKey = (
    event: KeyboardEvent<HTMLCanvasElement>,
    eventType: "keyDown" | "keyUp"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const info = keyboardKeyInfo[event.key];
    const text =
      eventType === "keyDown"
        ? (info?.text ?? (event.key.length === 1 ? event.key : undefined))
        : undefined;
    const windowsVirtualKeyCode =
      info?.keyCode ??
      (event.key.length === 1 ? (event.key.codePointAt(0) ?? 0) : 0);
    dispatchInput({
      code: event.code,
      eventType,
      key: event.key,
      modifiers: keyboardModifiers(event),
      ...(text === undefined ? {} : { text }),
      type: "input_keyboard",
      windowsVirtualKeyCode,
    });
  };

  return {
    activeTabData,
    address,
    addressEditingRef,
    applyGeolocation,
    canvasRef,
    closeTab,
    commitViewport,
    createTab,
    deleteSession,
    devtoolsOpen,
    error,
    frameReady,
    geolocation,
    handleKey,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    height,
    manuallyRefreshNetwork,
    navigate,
    opening,
    presetId,
    refreshingNetwork,
    selectPreset,
    selectSession,
    selectUserAgent,
    selectedPresetName,
    selectedSessionId,
    setAddress,
    setDevtoolsOpen,
    setDevtoolsState,
    setHeight,
    setWidth,
    streamConnected,
    submitAddress,
    switchTab,
    tabs,
    updateDimension,
    userAgentProfile,
    viewport,
    visibleDevtools,
    width,
  };
};

type BrowserWorkspaceController = ReturnType<typeof useBrowserWorkspace>;

const BrowserNavigationToolbar = ({
  controller,
}: {
  readonly controller: BrowserWorkspaceController;
}) => {
  const {
    address,
    addressEditingRef,
    closeTab,
    createTab,
    deleteSession,
    navigate,
    opening,
    selectedSessionId,
    selectSession,
    setAddress,
    submitAddress,
    switchTab,
    tabs,
    viewport,
  } = controller;

  return (
    <>
      <BrowserTabStrip
        onClose={(tab) => {
          void closeTab(tab);
        }}
        onCreate={() => {
          void createTab();
        }}
        onSwitch={(tab) => {
          void switchTab(tab);
        }}
        sessionSelected={selectedSessionId !== undefined}
        tabs={tabs}
      />
      <div className="bg-background flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
        <div
          aria-label="Browser navigation"
          className="flex gap-0.5"
          role="group"
        >
          <Button
            aria-label="Go back"
            disabled={selectedSessionId === undefined}
            onClick={() => navigate("back")}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            aria-label="Go forward"
            disabled={selectedSessionId === undefined}
            onClick={() => navigate("forward")}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowRightIcon />
          </Button>
          <Button
            aria-label="Reload page"
            disabled={selectedSessionId === undefined}
            onClick={() => navigate("reload")}
            size="icon-sm"
            variant="ghost"
          >
            <RotateCwIcon />
          </Button>
        </div>

        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <InputGroup className="bg-muted/40 h-8">
            <InputGroupAddon align="inline-start">
              {opening ? (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-3.5 animate-spin"
                />
              ) : (
                <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
              )}
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Browser address"
              disabled={opening}
              onBlur={() => {
                addressEditingRef.current = false;
              }}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => {
                addressEditingRef.current = true;
              }}
              placeholder="Enter a URL to start recording"
              spellCheck={false}
              value={address}
            />
          </InputGroup>
        </form>

        <BrowserSessionPicker
          onDelete={deleteSession}
          onSelect={selectSession}
          selectedSessionId={selectedSessionId}
          viewport={viewport}
        />
      </div>
    </>
  );
};

const BrowserDeviceToolbar = ({
  controller,
}: {
  readonly controller: BrowserWorkspaceController;
}) => {
  const {
    applyGeolocation,
    commitViewport,
    devtoolsOpen,
    height,
    geolocation,
    opening,
    presetId,
    selectedPresetName,
    selectedSessionId,
    selectPreset,
    selectUserAgent,
    setDevtoolsOpen,
    setHeight,
    setWidth,
    updateDimension,
    userAgentProfile,
    width,
  } = controller;

  return (
    <div className="bg-background flex h-10 shrink-0 items-center justify-center gap-1.5 overflow-x-auto overscroll-x-contain border-b px-2">
      <UserAgentPicker
        disabled={opening}
        onValueChange={(profile) => {
          void selectUserAgent(profile);
        }}
        value={userAgentProfile}
      />

      <Select onValueChange={selectPreset} value={presetId}>
        <SelectTrigger aria-label="Viewport preset" className="w-44" size="sm">
          <SelectValue>{selectedPresetName}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-72">
          <SelectItem value={RESPONSIVE_PRESET_ID}>Responsive</SelectItem>
          <SelectGroup>
            <SelectLabel>Standard</SelectLabel>
            {devicePresets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <span className="flex w-full items-center justify-between gap-5 pr-4">
                  <span>{preset.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {preset.width} × {preset.height}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Input
        aria-label="Viewport width"
        className="h-7 w-16 text-center tabular-nums"
        inputMode="numeric"
        onBlur={commitViewport}
        onChange={(event) => updateDimension(event.target.value, setWidth)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        value={width}
      />
      <span aria-hidden="true" className="text-muted-foreground text-sm">
        ×
      </span>
      <Input
        aria-label="Viewport height"
        className="h-7 w-16 text-center tabular-nums"
        inputMode="numeric"
        onBlur={commitViewport}
        onChange={(event) => updateDimension(event.target.value, setHeight)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        value={height}
      />
      <GeolocationPicker
        appliedGeolocation={geolocation}
        disabled={opening || selectedSessionId === undefined}
        key={selectedSessionId ?? "no-session"}
        onApply={applyGeolocation}
      />
      <Button
        aria-label={devtoolsOpen ? "Close DevTools" : "Open DevTools"}
        className="ml-auto shrink-0"
        onClick={() => setDevtoolsOpen((open) => !open)}
        size="sm"
        variant={devtoolsOpen ? "secondary" : "outline"}
      >
        <PanelBottomIcon />
        <span className="hidden xl:inline">DevTools</span>
      </Button>
    </div>
  );
};

const BrowserViewportPanels = ({
  controller,
}: {
  readonly controller: BrowserWorkspaceController;
}) => {
  const {
    activeTabData,
    canvasRef,
    devtoolsOpen,
    error,
    frameReady,
    handleKey,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    height,
    manuallyRefreshNetwork,
    navigate,
    refreshingNetwork,
    selectedSessionId,
    setDevtoolsOpen,
    setDevtoolsState,
    streamConnected,
    visibleDevtools,
    width,
  } = controller;

  return (
    <ResizablePanelGroup className="min-h-0 flex-1" orientation="vertical">
      <ResizablePanel defaultSize={devtoolsOpen ? 70 : 100} minSize={30}>
        <div className="bg-background relative grid size-full min-h-0 place-items-center overflow-hidden overscroll-contain p-2">
          {frameReady ? null : (
            <div className="absolute inset-0 grid place-items-center p-6">
              <div className="max-w-sm space-y-4 text-center">
                <div className="bg-muted/50 mx-auto grid size-12 place-items-center rounded-xl border shadow-sm">
                  {selectedSessionId === undefined || error !== undefined ? (
                    <Globe2Icon
                      aria-hidden="true"
                      className="text-muted-foreground size-5"
                    />
                  ) : (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="text-muted-foreground size-5 animate-spin"
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <h1 className="font-medium">
                    {error === undefined
                      ? "Your browser will appear here"
                      : "Browser unavailable"}
                  </h1>
                  <p className="text-muted-foreground text-sm text-balance">
                    {error ??
                      (selectedSessionId === undefined
                        ? "Choose a session or enter a URL to start an isolated Chromium browser."
                        : "Connecting to the browser stream...")}
                  </p>
                </div>
              </div>
            </div>
          )}
          <ContextMenu>
            <ContextMenuTrigger className="contents">
              <canvas
                aria-label="Interactive browser viewport"
                className="focus-visible:ring-ring max-h-full max-w-full touch-none overscroll-contain bg-white outline-none focus-visible:ring-2"
                onKeyDown={(event) => handleKey(event, "keyDown")}
                onKeyUp={(event) => handleKey(event, "keyUp")}
                onPointerCancel={handlePointerUp}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                ref={canvasRef}
                style={{ display: frameReady ? "block" : "none" }}
                tabIndex={0}
              />
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => navigate("back")}>
                <ArrowLeftIcon />
                Back
              </ContextMenuItem>
              <ContextMenuItem onClick={() => navigate("forward")}>
                <ArrowRightIcon />
                Forward
              </ContextMenuItem>
              <ContextMenuItem onClick={() => navigate("reload")}>
                <RotateCwIcon />
                Reload
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setDevtoolsOpen(true)}>
                <PanelBottomIcon />
                Open DevTools
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <output aria-live="polite" className="sr-only">
            {streamConnected
              ? "Browser stream connected."
              : "Browser stream disconnected."}
            Viewport set to {width || "0"} by {height || "0"}.
          </output>
        </div>
      </ResizablePanel>
      {visibleDevtools === undefined ? null : (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={30} minSize={15}>
            <BrowserDevtools
              consoleEntries={activeTabData.consoleEntries}
              key={`${visibleDevtools.sessionId}:${visibleDevtools.activeTab.tabId}`}
              networkRequests={activeTabData.networkRequests}
              onClearConsole={() => {
                setDevtoolsState((state) =>
                  clearTabConsole(
                    state,
                    visibleDevtools.sessionId,
                    visibleDevtools.activeTab.tabId
                  )
                );
              }}
              onClearNetwork={() => {
                setDevtoolsState((state) =>
                  clearTabNetwork(
                    state,
                    visibleDevtools.sessionId,
                    visibleDevtools.activeTab.tabId
                  )
                );
              }}
              onClose={() => setDevtoolsOpen(false)}
              onRefreshNetwork={() => {
                void manuallyRefreshNetwork();
              }}
              refreshingNetwork={refreshingNetwork}
              sessionId={visibleDevtools.sessionId}
              tabId={visibleDevtools.activeTab.tabId}
              tabTitle={visibleDevtools.activeTab.title || "Current tab"}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
};

const BrowserWorkspace = () => {
  const controller = useBrowserWorkspace();
  return (
    <section
      aria-label="Browser workspace"
      className="bg-muted/20 flex size-full min-h-0 flex-col"
    >
      <BrowserNavigationToolbar controller={controller} />
      <BrowserDeviceToolbar controller={controller} />
      <BrowserViewportPanels controller={controller} />
    </section>
  );
};

export { BrowserWorkspace };
