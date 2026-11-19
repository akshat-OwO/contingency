/**
 * Teaching overlays (#775): the comment card, the pins and outlines its
 * comments leave on the stage, the inspect hint, the browser-check editor and
 * the demo password card. One comment card serves Web, Android and iOS; Web
 * adds scans and browser checks, which only a browser can collect.
 */
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/react/popover";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { TooltipTrigger } from "@ui-sdk/react/tooltip";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Tip } from "./canvas";
import type { PickedElement } from "./canvas";
import {
  ActivityIcon,
  CloseIcon,
  CommentIcon,
  CornerIcon,
  DatabaseIcon,
  EyeOffIcon,
  KeyIcon,
  PointerIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
} from "./icons";

/* ------------------------------------------------------------------ model */

type ScanMode = "reload" | "navigation" | "timespan" | "accessibility";
interface Scan {
  readonly mode: ScanMode;
  readonly phase: "start" | "stop";
}
const SCAN_LABEL: Record<ScanMode, string> = {
  accessibility: "Accessibility scan",
  navigation: "Measure the next navigation",
  reload: "Reload at this point",
  timespan: "Interaction timespan",
};
const scanLabel = (s: Scan) =>
  s.phase === "stop" ? "End interaction timespan" : SCAN_LABEL[s.mode];

interface Predicate {
  readonly id: string;
  readonly path: string;
  readonly operator: string;
  readonly expected: string;
}
/** A browser check attached to the comment (ADR 0056). */
interface Check {
  readonly id: string;
  readonly kind: "response" | "cookie";
  readonly required: boolean;
  readonly demonstrated: boolean;
  readonly when: string;
  readonly timeout: string;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly query: string;
  readonly timing: "matching" | "first";
  readonly name: string;
  readonly change: "created" | "changed" | "current";
  readonly itemPath: string;
  readonly predicates: readonly Predicate[];
}
const checkLabel = (c: Check) =>
  c.kind === "response"
    ? `${c.method} ${c.path} · ${c.predicates[0]?.path.replace(/^\["?|"?\]$/g, "").replaceAll('","', ".") || "response"}`
    : `cookie · ${c.name}`;

export interface TeachingComment {
  readonly id: string;
  readonly text: string;
  /** Seconds into the recording. */
  readonly at: number;
  readonly target: PickedElement | null;
  readonly scan?: Scan;
  readonly checks?: number;
}

const SEED_COMMENTS: Record<string, readonly TeachingComment[]> = {
  s1: [
    {
      at: 9,
      id: "c1",
      target: null,
      text: "Start signed out. The cart keeps items across sessions, so empty it first.",
    },
    {
      at: 21,
      id: "c2",
      target: {
        box: { h: 31, w: 108, x: 52, y: 218 },
        name: "Shop jackets",
        role: "button",
      },
      text: "Any jacket under $80 works. Prefer the first one in stock.",
    },
    {
      at: 33,
      id: "c3",
      scan: { mode: "accessibility", phase: "start" },
      target: null,
      text: "Run accessibility scan here.",
    },
  ],
};

interface Teaching {
  readonly comments: Readonly<Record<string, readonly TeachingComment[]>>;
  readonly highlighted: string | null;
  readonly add: (session: string, comment: TeachingComment) => void;
  readonly replace: (session: string, comment: TeachingComment) => void;
  readonly highlight: (id: string | null) => void;
}
const TeachingContext = createContext<Teaching>({
  add: () => {},
  comments: {},
  highlight: () => {},
  highlighted: null,
  replace: () => {},
});

export const TeachingProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [comments, setComments] =
    useState<Readonly<Record<string, readonly TeachingComment[]>>>(
      SEED_COMMENTS
    );
  const [highlighted, highlight] = useState<string | null>(null);
  return (
    <TeachingContext.Provider
      value={{
        add: (session, c) =>
          setComments((all) => ({
            ...all,
            [session]: [...(all[session] ?? []), c],
          })),
        comments,
        highlight,
        highlighted,
        replace: (session, c) =>
          setComments((all) => ({
            ...all,
            [session]: (all[session] ?? []).map((x) => (x.id === c.id ? c : x)),
          })),
      }}
    >
      {children}
    </TeachingContext.Provider>
  );
};

export const useCommentCount = (session: string) =>
  useContext(TeachingContext).comments[session]?.length ?? 0;

const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/* ---------------------------------------------------------- on the stage */

/**
 * A numbered pin on every element a comment names, and the outline of the
 * one the card's list points at. Drawn in page (or screen) coordinates, so it
 * scales with the frame. Takes no pointer input (ADR 0076).
 */
export const CommentPins = ({ session }: { readonly session: string }) => {
  const { comments, highlighted } = useContext(TeachingContext);
  const list = comments[session] ?? [];
  return (
    <>
      {list.map((c, i) => {
        const box = c.target?.box;
        if (!box) return null;
        return (
          <span key={c.id}>
            {highlighted === c.id ? (
              <span
                aria-hidden="true"
                className="inspect-box comment-outline"
                style={{ height: box.h, left: box.x, top: box.y, width: box.w }}
              />
            ) : null}
            <span
              aria-hidden="true"
              className="comment-pin"
              data-on={highlighted === c.id || undefined}
              style={{ left: box.x + box.w, top: box.y }}
            >
              {i + 1}
            </span>
          </span>
        );
      })}
    </>
  );
};

/**
 * Shown while Attach element is picking. The hint drops in at the top centre
 * like a notice and turns into the error when a pick misses. It takes no
 * input: the pointer picks whatever is under it, and the hint fades away
 * while the pointer is there. Escape, or Attach element again, cancels.
 */
export const InspectHint = ({
  verb,
  error,
}: {
  readonly verb: "Click" | "Tap";
  readonly error: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [under, setUnder] = useState(false);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const pad = 12;
      setUnder(
        e.clientX > r.left - pad &&
          e.clientX < r.right + pad &&
          e.clientY > r.top - pad &&
          e.clientY < r.bottom + pad
      );
    };
    addEventListener("pointermove", onMove);
    return () => removeEventListener("pointermove", onMove);
  }, []);
  return (
    <div
      className="inspect-hint island"
      data-error={error || undefined}
      data-under={under || undefined}
      ref={ref}
      role={error ? "alert" : "status"}
    >
      <PointerIcon />
      <span>
        {error
          ? "Could not select this element. Try another visible element."
          : `${verb} an element to attach it to the comment`}
      </span>
      <kbd aria-label="Escape cancels">Esc</kbd>
    </div>
  );
};

/* ------------------------------------------------------- browser checks */

const COMPARISONS = ["exists", "equals", "contains", "gt", "gte", "lt", "lte"];

const sampleResponse = (): Check => ({
  change: "created",
  demonstrated: true,
  id: crypto.randomUUID(),
  itemPath: '["items","*"]',
  kind: "response",
  method: "GET",
  name: "",
  origin: "http://shop.localhost:4173",
  path: "/api/cart",
  predicates: [
    {
      expected: '"jacket-red-m"',
      id: crypto.randomUUID(),
      operator: "equals",
      path: '["sku"]',
    },
  ],
  query: "{}",
  required: true,
  timeout: "5000",
  timing: "matching",
  when: "After Add to cart",
});
const sampleCookie = (): Check => ({
  ...sampleResponse(),
  demonstrated: false,
  itemPath: "[]",
  kind: "cookie",
  name: "cookie-name",
  path: "",
  predicates: [
    { expected: "", id: crypto.randomUUID(), operator: "exists", path: "[]" },
  ],
  when: "",
});

const Labelled = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <label className="check-field">
    <span>{label}</span>
    {children}
  </label>
);

const SmallSelect = ({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (v: string) => void;
}) => (
  <Select onValueChange={(v) => onChange(String(v))} value={value}>
    <SelectTrigger aria-label={label} className="select-trigger compact">
      <SelectValue>
        {options.find(([v]) => v === value)?.[1] ?? value}
      </SelectValue>
    </SelectTrigger>
    <SelectContent className="select-list island">
      {options.map(([v, text]) => (
        <SelectItem className="select-item" key={v} value={v}>
          {text}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/**
 * The editor for one attached browser check. It opens beside the comment
 * card, so the comment stays readable while the check is shaped.
 */
const CheckCard = ({
  check,
  onChange,
  onRemove,
  onClose,
}: {
  readonly check: Check;
  readonly onChange: (c: Check) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}) => {
  const label = checkLabel(check);
  const set = (patch: Partial<Check>) =>
    onChange({ ...check, demonstrated: false, ...patch });
  const fieldsRead = check.kind === "response";
  return (
    <section aria-label={label} className="check-card island">
      <header className="tool-card-head">
        <h2>
          {check.kind === "response" ? <ActivityIcon /> : <DatabaseIcon />}
          <span className="mono check-title">{label}</span>
        </h2>
        <Tip label="Close check" side="top">
          <TooltipTrigger
            render={
              <Button
                aria-label="Close check"
                className="tool-btn"
                onClick={onClose}
                type="button"
              />
            }
          >
            <CloseIcon />
          </TooltipTrigger>
        </Tip>
      </header>
      <div className="tool-card-body check-body">
        <SegmentedControl
          aria-label={`Purpose for ${label}`}
          className="segmented wide"
          onValueChange={(v) =>
            onChange({ ...check, required: v === "required" })
          }
          value={check.required ? "required" : "context"}
        >
          <SegmentedControlIndicator className="segmented-indicator" />
          <SegmentedControlItem className="segmented-item" value="context">
            Context for the agent
          </SegmentedControlItem>
          <SegmentedControlItem className="segmented-item" value="required">
            Must happen
          </SegmentedControlItem>
        </SegmentedControl>
        {check.required ? (
          <>
            <div className="check-grid two">
              <Labelled label="When">
                <Input
                  aria-label="Check timing"
                  className="input compact"
                  onChange={(e) =>
                    onChange({ ...check, when: e.currentTarget.value })
                  }
                  value={check.when}
                />
              </Labelled>
              <Labelled label="Timeout (ms)">
                <Input
                  aria-label="Check timeout"
                  className="input compact mono"
                  inputMode="numeric"
                  onChange={(e) =>
                    onChange({ ...check, timeout: e.currentTarget.value })
                  }
                  value={check.timeout}
                />
              </Labelled>
            </div>
            <h3 className="check-section">
              {check.kind === "response" ? "Request" : "Cookie"}
            </h3>
            {check.kind === "response" ? (
              <>
                <div className="check-grid method">
                  <Labelled label="Method">
                    <Input
                      aria-label="Request method"
                      className="input compact mono"
                      onChange={(e) =>
                        set({ method: e.currentTarget.value.toUpperCase() })
                      }
                      value={check.method}
                    />
                  </Labelled>
                  <Labelled label="Path">
                    <Input
                      aria-label="Request path"
                      className="input compact mono"
                      onChange={(e) => set({ path: e.currentTarget.value })}
                      value={check.path}
                    />
                  </Labelled>
                </div>
                <Labelled label="Origin">
                  <Input
                    aria-label="Request origin"
                    className="input compact mono"
                    onChange={(e) => set({ origin: e.currentTarget.value })}
                    value={check.origin}
                  />
                </Labelled>
                <div className="check-grid two">
                  <Labelled label="Query constraints">
                    <Input
                      aria-label="Query constraints"
                      className="input compact mono"
                      onChange={(e) => set({ query: e.currentTarget.value })}
                      value={check.query}
                    />
                  </Labelled>
                  <Labelled label="Response">
                    <SmallSelect
                      label="Response timing"
                      onChange={(v) =>
                        onChange({
                          ...check,
                          timing: v === "first" ? "first" : "matching",
                        })
                      }
                      options={[
                        ["matching", "Wait for a match"],
                        ["first", "The first response"],
                      ]}
                      value={check.timing}
                    />
                  </Labelled>
                </div>
              </>
            ) : (
              <>
                <div className="check-grid two">
                  <Labelled label="Name">
                    <Input
                      aria-label="Storage check name"
                      className="input compact mono"
                      onChange={(e) => set({ name: e.currentTarget.value })}
                      value={check.name}
                    />
                  </Labelled>
                  <Labelled label="State">
                    <SmallSelect
                      label="Storage check change"
                      onChange={(v) =>
                        onChange({
                          ...check,
                          change:
                            v === "current"
                              ? "current"
                              : v === "changed"
                                ? "changed"
                                : "created",
                        })
                      }
                      options={[
                        ["created", "Created after the action"],
                        ["changed", "Changed after the action"],
                        ["current", "Current state"],
                      ]}
                      value={check.change}
                    />
                  </Labelled>
                </div>
                <Labelled label="Origin">
                  <Input
                    aria-label="Storage check origin"
                    className="input compact mono"
                    onChange={(e) => set({ origin: e.currentTarget.value })}
                    value={check.origin}
                  />
                </Labelled>
              </>
            )}
            <h3 className="check-section">Expect</h3>
            {fieldsRead ? (
              <Labelled label="Array item path">
                <Input
                  aria-label="Array item path"
                  className="input compact mono"
                  onChange={(e) => set({ itemPath: e.currentTarget.value })}
                  value={check.itemPath}
                />
              </Labelled>
            ) : null}
            <ol className="predicates">
              {check.predicates.map((p, i) => {
                const update = (patch: Partial<Predicate>) =>
                  set({
                    predicates: check.predicates.map((x) =>
                      x.id === p.id ? { ...x, ...patch } : x
                    ),
                  });
                return (
                  <li className="predicate" key={p.id}>
                    {fieldsRead ? (
                      <Input
                        aria-label={`Field path ${i + 1}`}
                        className="input compact mono"
                        onChange={(e) =>
                          update({ path: e.currentTarget.value })
                        }
                        value={p.path}
                      />
                    ) : null}
                    <SmallSelect
                      label={`Comparison ${i + 1}`}
                      onChange={(v) => update({ operator: v })}
                      options={(fieldsRead
                        ? COMPARISONS
                        : COMPARISONS.slice(0, 3)
                      ).map((o) => [o, o] as const)}
                      value={p.operator}
                    />
                    {p.operator === "exists" ? (
                      <span />
                    ) : (
                      <Input
                        aria-label={`Expected value ${i + 1}`}
                        className="input compact mono"
                        onChange={(e) =>
                          update({ expected: e.currentTarget.value })
                        }
                        value={p.expected}
                      />
                    )}
                    {check.predicates.length < 2 ? null : (
                      <Tip label="Remove predicate" side="top">
                        <TooltipTrigger
                          render={
                            <Button
                              aria-label={`Remove predicate ${i + 1}`}
                              className="icon-btn small"
                              onClick={() =>
                                set({
                                  predicates: check.predicates.filter(
                                    (x) => x.id !== p.id
                                  ),
                                })
                              }
                              type="button"
                            />
                          }
                        >
                          <CloseIcon />
                        </TooltipTrigger>
                      </Tip>
                    )}
                  </li>
                );
              })}
            </ol>
            <Button
              className="pill-btn add-predicate"
              disabled={check.predicates.length >= 20}
              onClick={() =>
                set({
                  predicates: [
                    ...check.predicates,
                    {
                      expected: "",
                      id: crypto.randomUUID(),
                      operator: "exists",
                      path: "[]",
                    },
                  ],
                })
              }
              type="button"
            >
              Add predicate to this item
            </Button>
            <p
              className="check-proof"
              data-ok={check.demonstrated || undefined}
            >
              {check.demonstrated
                ? "Observed during Teaching"
                : "Not demonstrated. A fresh Dry Run must pass this check."}
            </p>
          </>
        ) : null}
      </div>
      <footer className="check-foot">
        <Button className="pill-btn danger" onClick={onRemove} type="button">
          <TrashIcon />
          Remove attachment
        </Button>
      </footer>
    </section>
  );
};

/* ---------------------------------------------------------- the composer */

export interface ComposerSession {
  readonly id: string;
  readonly platform: "web" | "android" | "ios";
  readonly since: number;
}

const ScanMenu = ({
  openTimespan,
  disabled,
  onPick,
}: {
  readonly openTimespan: boolean;
  readonly disabled: boolean;
  readonly onPick: (s: Scan) => void;
}) => {
  const [open, setOpen] = useState(false);
  const pick = (s: Scan) => {
    onPick(s);
    setOpen(false);
  };
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tip label="Performance scan" side="top">
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label="Performance scan"
              className="tool-btn"
              disabled={disabled}
            />
          }
        >
          <ActivityIcon />
        </TooltipTrigger>
      </Tip>
      <PopoverContent
        className="popover island narrow menu"
        side="top"
        sideOffset={10}
      >
        <PopoverTitle className="popover-title">
          Teach a scan for later Runs
        </PopoverTitle>
        {openTimespan ? (
          <Button
            className="pill-btn wide"
            onClick={() => pick({ mode: "timespan", phase: "stop" })}
          >
            <StopIcon />
            End timespan
          </Button>
        ) : (
          (["reload", "navigation", "timespan"] as const).map((mode) => (
            <Button
              className="pill-btn wide"
              key={mode}
              onClick={() => pick({ mode, phase: "start" })}
            >
              {SCAN_LABEL[mode]}
            </Button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
};

const CheckMenu = ({
  disabled,
  onAdd,
}: {
  readonly disabled: boolean;
  readonly onAdd: (c: Check) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tip label="Browser check" side="top">
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label="Browser check"
              className="tool-btn"
              disabled={disabled}
            />
          }
        >
          <DatabaseIcon />
        </TooltipTrigger>
      </Tip>
      <PopoverContent
        className="popover island narrow menu"
        side="top"
        sideOffset={10}
      >
        <PopoverTitle className="popover-title">
          Check what the browser did
        </PopoverTitle>
        <Button
          className="pill-btn wide"
          onClick={() => {
            onAdd(sampleResponse());
            setOpen(false);
          }}
        >
          <ActivityIcon />
          GET /api/cart from Network
        </Button>
        <Button
          className="pill-btn wide"
          onClick={() => {
            onAdd(sampleCookie());
            setOpen(false);
          }}
        >
          <EyeOffIcon />
          Require an unseen cookie
        </Button>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The comment card. It sits above the Session status island it opens from,
 * stays open while you use the page, DevTools or the device rail, and closes
 * on Escape, Close or a saved comment. It never closes on an outside press:
 * Attach element needs that press to reach the stage.
 */
export const CommentCard = ({
  session,
  onPick,
  onClose,
  onSent,
}: {
  readonly session: ComposerSession;
  /** Starts Attach element; resolves with the pick or null on cancel. */
  readonly onPick: ((done: (el: PickedElement | null) => void) => void) | null;
  readonly onClose: () => void;
  readonly onSent: (text: string) => void;
}) => {
  const teaching = useContext(TeachingContext);
  const list = teaching.comments[session.id] ?? [];
  const web = session.platform === "web";
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<PickedElement | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [checks, setChecks] = useState<readonly Check[]>([]);
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [seconds, setSeconds] = useState(
    Math.floor((Date.now() - session.since) / 1000)
  );
  useEffect(() => {
    const t = setInterval(
      () => setSeconds(Math.floor((Date.now() - session.since) / 1000)),
      1000
    );
    return () => clearInterval(t);
  }, [session.since]);

  const openTimespan =
    list.filter((c) => c.scan?.mode === "timespan").at(-1)?.scan?.phase ===
    "start";

  // Escape closes the innermost surface: a check, then the card. A pick
  // handles its own Escape on the stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || picking) return;
      e.preventDefault();
      if (openCheck) setOpenCheck(null);
      else onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, openCheck, picking]);

  const focusField = () => requestAnimationFrame(() => field.current?.focus());
  const reset = () => {
    setDraft("");
    setAttached(null);
    setScan(null);
    setChecks([]);
    setOpenCheck(null);
    setEditing(null);
    setError(null);
  };
  const submit = () => {
    const text = draft.trim();
    if (text === "") return;
    if (/fail/i.test(text)) {
      setError("Could not save the comment. Try again.");
      return;
    }
    const comment: TeachingComment = {
      at: seconds,
      id: editing ?? crypto.randomUUID(),
      target: attached,
      text,
      ...(checks.length > 0 ? { checks: checks.length } : {}),
      ...(scan ? { scan } : {}),
    };
    if (editing) teaching.replace(session.id, comment);
    else teaching.add(session.id, comment);
    onSent(editing ? "Comment saved." : "Comment added to the recording.");
    reset();
  };
  const pick = () => {
    if (!onPick) return;
    // Attach element again cancels the pick, as Escape does on the stage.
    if (picking) {
      field.current?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
      return;
    }
    setPicking(true);
    onPick((el) => {
      setPicking(false);
      if (el) setAttached(el);
      focusField();
    });
  };
  const current = checks.find((c) => c.id === openCheck);

  return (
    <>
      <section
        aria-describedby="comment-help"
        aria-label="Comment"
        aria-modal="false"
        className="comment-card island"
        data-picking={picking || undefined}
        data-platform={session.platform}
        onDragOver={(e) => {
          if (web) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!web) return;
          e.preventDefault();
          setChecks((cs) => [...cs, sampleResponse()]);
        }}
        role="dialog"
      >
        <header className="comment-head">
          <h2>
            {editing ? "Edit comment" : "Comment"}{" "}
            <span className="mono">at {clock(seconds)}</span>
          </h2>
          <p className="sr-only" id="comment-help">
            Tell the agent something about this moment of the recording.
          </p>
          <Tip label="Close comment" side="top">
            <TooltipTrigger
              render={
                <Button
                  aria-label="Close comment"
                  className="tool-btn"
                  onClick={onClose}
                  type="button"
                />
              }
            >
              <CloseIcon />
            </TooltipTrigger>
          </Tip>
        </header>

        <div className="comment-body">
          {attached || scan || checks.length > 0 ? (
            <div className="comment-chips">
              {attached ? (
                <span className="attached-chip">
                  <PointerIcon />
                  <span className="mono">{attached.role}</span>
                  <span className="chip-text">{attached.name}</span>
                  <Button
                    aria-label="Remove attached element"
                    className="icon-btn small"
                    onClick={() => {
                      setAttached(null);
                      focusField();
                    }}
                    type="button"
                  >
                    <CloseIcon />
                  </Button>
                </span>
              ) : null}
              {scan ? (
                <span className="attached-chip scan">
                  <ActivityIcon />
                  <span className="chip-text">{scanLabel(scan)}</span>
                  <Button
                    aria-label="Remove scan"
                    className="icon-btn small"
                    onClick={() => {
                      setScan(null);
                      focusField();
                    }}
                    type="button"
                  >
                    <CloseIcon />
                  </Button>
                </span>
              ) : null}
              {checks.map((c) => (
                <span
                  className="attached-chip check"
                  data-open={openCheck === c.id || undefined}
                  data-required={c.required || undefined}
                  key={c.id}
                >
                  <Button
                    aria-expanded={openCheck === c.id}
                    className="chip-open"
                    onClick={() =>
                      setOpenCheck(openCheck === c.id ? null : c.id)
                    }
                    type="button"
                  >
                    {c.kind === "response" ? (
                      <ActivityIcon />
                    ) : (
                      <DatabaseIcon />
                    )}
                    <span className="chip-text mono">{checkLabel(c)}</span>
                    <span className="check-purpose">
                      {c.required ? "Must happen" : "Context"}
                    </span>
                  </Button>
                  <Button
                    aria-label={`Remove ${checkLabel(c)}`}
                    className="icon-btn small"
                    onClick={() => {
                      setChecks((cs) => cs.filter((x) => x.id !== c.id));
                      if (openCheck === c.id) setOpenCheck(null);
                      focusField();
                    }}
                    type="button"
                  >
                    <CloseIcon />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            aria-label="Comment"
            className="comment-field"
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Backspace" && draft === "" && attached) {
                e.preventDefault();
                setAttached(null);
              }
            }}
            placeholder={
              attached
                ? "What should change here?"
                : "What should the agent know about this moment?"
            }
            ref={field}
            rows={2}
            // The card opens from Comment, so typing starts at once.
            autoFocus
            value={draft}
          />
          {openTimespan && !scan ? (
            <p className="hint comment-note">
              A timespan is open. Later Runs collect it until you end it.
            </p>
          ) : null}
          {error ? (
            <p className="comment-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="comment-tools">
          <Tip
            label={web ? "Attach element (⌘⇧C)" : "Attach element"}
            side="top"
          >
            <TooltipTrigger
              render={
                <Button
                  aria-pressed={picking}
                  className="pill-btn"
                  disabled={!onPick}
                  onClick={pick}
                  type="button"
                />
              }
            >
              <PointerIcon />
              {attached ? "Change element" : "Attach element"}
            </TooltipTrigger>
          </Tip>
          {web ? (
            <>
              <ScanMenu
                disabled={scan !== null}
                onPick={(s) => {
                  setScan(s);
                  if (draft.trim() === "")
                    setDraft(
                      s.phase === "stop"
                        ? "Stop the timespan performance scan here."
                        : `Run ${SCAN_LABEL[s.mode].toLowerCase()} here.`
                    );
                  focusField();
                }}
                openTimespan={openTimespan}
              />
              <Tip label="Accessibility scan" side="top">
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Accessibility scan"
                      className="tool-btn"
                      disabled={scan !== null || openTimespan}
                      onClick={() => {
                        setScan({ mode: "accessibility", phase: "start" });
                        if (draft.trim() === "")
                          setDraft("Run accessibility scan here.");
                        focusField();
                      }}
                      type="button"
                    />
                  }
                >
                  <SparklesIcon />
                </TooltipTrigger>
              </Tip>
              <CheckMenu
                disabled={checks.length >= 50}
                onAdd={(c) => {
                  setChecks((cs) => [...cs, c]);
                  setOpenCheck(c.id);
                }}
              />
            </>
          ) : null}
          <span className="grow" />
          <Button
            className="btn compact"
            disabled={draft.trim() === ""}
            onClick={submit}
            type="button"
          >
            {editing ? "Save comment" : "Add comment"}
            <kbd className="on-primary" aria-hidden="true">
              <CornerIcon />
            </kbd>
          </Button>
        </div>

        <section aria-label="Earlier in this recording" className="earlier">
          <h3>
            Earlier in this recording
            <span className="mono">{list.length}</span>
          </h3>
          {list.length === 0 ? (
            <p className="hint earlier-empty">
              No comments yet. Type one, or attach an element first.
            </p>
          ) : (
            <ul aria-label="Earlier comments" className="earlier-list">
              {list
                .map((c, i) => ({ c, n: i + 1 }))
                .toReversed()
                .map(({ c, n }) => (
                  <li
                    data-editing={editing === c.id || undefined}
                    key={c.id}
                    onPointerEnter={() =>
                      c.target?.box ? teaching.highlight(c.id) : undefined
                    }
                    onPointerLeave={() => teaching.highlight(null)}
                  >
                    <span
                      aria-hidden="true"
                      className="earlier-pin"
                      data-pinned={c.target?.box ? "" : undefined}
                    >
                      {c.target ? n : <CommentIcon />}
                    </span>
                    <span className="earlier-text">
                      {c.text}
                      <span className="earlier-meta">
                        <span className="mono">{clock(c.at)}</span>
                        {c.target ? (
                          <span className="earlier-target">
                            <PointerIcon />
                            {c.target.name}
                          </span>
                        ) : (
                          <span>Page</span>
                        )}
                        {c.scan ? <span>{scanLabel(c.scan)}</span> : null}
                        {c.checks ? (
                          <span>
                            {c.checks} {c.checks === 1 ? "check" : "checks"}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <Button
                      aria-label={`Edit comment ${n}`}
                      className="pill-btn small edit"
                      onClick={() => {
                        setEditing(c.id);
                        setDraft(c.text);
                        setAttached(c.target);
                        setScan(c.scan ?? null);
                        focusField();
                      }}
                      type="button"
                    >
                      Edit
                    </Button>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </section>
      {current ? (
        <CheckCard
          check={current}
          key={current.id}
          onChange={(c) =>
            setChecks((cs) => cs.map((x) => (x.id === c.id ? c : x)))
          }
          onClose={() => setOpenCheck(null)}
          onRemove={() => {
            setChecks((cs) => cs.filter((x) => x.id !== current.id));
            setOpenCheck(null);
            focusField();
          }}
        />
      ) : null}
    </>
  );
};

/* ------------------------------------------------------- demo password */

/**
 * A demo Flow whose variation needs a password asks for one here, in the
 * corner requests use (Teaching never has requests). The recording keeps
 * DEMO_PASSWORD in place of the value.
 */
export const DemoPassword = ({
  onEntered,
}: {
  readonly onEntered: () => void;
}) => {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      aria-label="Teaching demo password"
      className="demo-password island"
    >
      <header>
        <span className="request-icon">
          <KeyIcon />
        </span>
        <div className="request-head">
          <span className="eyebrow">Demo sign-in</span>
          <h2>Record sign-in with a test password</h2>
        </div>
      </header>
      <ol className="demo-steps">
        <li>Click the store's Password field.</li>
        <li>Enter a demo password here, then continue in the store.</li>
      </ol>
      <form
        className="request-actions"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          setTimeout(() => {
            setPending(false);
            if (value === "wrongfield") {
              setError(
                "Could not enter the demo password. Click the store's Password field and try again."
              );
              setValue("");
              return;
            }
            setValue("");
            onEntered();
          }, 500);
        }}
      >
        <Input
          aria-label="Demo password"
          autoComplete="off"
          className="input mono grow"
          disabled={pending}
          minLength={8}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder="At least 8 characters"
          required
          value={value}
        />
        <Button
          className="btn"
          disabled={pending || value.length < 8}
          type="submit"
        >
          Enter demo password
        </Button>
      </form>
      {error ? (
        <p className="comment-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="hint demo-note">
          Your recording keeps <span className="code">DEMO_PASSWORD</span> in
          place of the value.
        </p>
      )}
    </section>
  );
};
