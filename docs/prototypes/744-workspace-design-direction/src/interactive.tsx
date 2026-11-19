/**
 * Interactive Run chrome (#777): what a Guided Run (ADR 0065) adds around the
 * stage. The control button lives in the Session status island, the Takeover
 * Variable is a card in the Requests island while you hold control (ADR
 * 0052), and the bot-protection notice joins the notices at the top centre.
 * Nothing here sits over the streamed frame, so Forwarded Input (ADR 0076)
 * is untouched.
 */
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { useState } from "react";
import type { ReactNode } from "react";

import { CheckCircleIcon, CloseIcon, KeyIcon, ShieldIcon } from "./icons";

/* ------------------------------------------------------------------ model */

/** Who holds the browser in a Guided recording. */
export type GuidedControl = "agent" | "requested" | "user";
export const GUIDED_CONTROLS: readonly GuidedControl[] = [
  "agent",
  "requested",
  "user",
];

/** The one control button's label, per holder. */
export const CONTROL_LABEL: Record<GuidedControl, string> = {
  agent: "Take control",
  requested: "Take over",
  user: "Return control",
};

/**
 * The status sentence. The chip already says who holds the browser, so the
 * sentence says only what happens next, or why the agent asked.
 */
export const controlSentence = (
  control: GuidedControl,
  reason: string
): string =>
  ({
    agent: "The agent is following the document. Take control at any time.",
    requested: `The agent asked for help: ${reason}`,
    user: "Capture continues while you drive. Return control when you're done.",
  })[control];

/**
 * Forces the Takeover Variable through one state, so a reviewer can walk it.
 * "live" behaves: a value of `fail` fails, anything else is entered.
 */
export const TAKEOVER_STATES = [
  "live",
  "empty",
  "filled",
  "invalid",
  "submitting",
  "error",
  "entered",
] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

const NAME = /^[A-Z][A-Z0-9_]*$/u;

/* -------------------------------------------------------------- control */

const Spinner = () => <span aria-hidden="true" className="btn-spinner" />;

/**
 * The one control button. It keeps its name while pending, and Take over is
 * filled in the needs-you tone: the agent has stopped and is waiting for you.
 */
export const ControlButton = ({
  control,
  pending,
  onClick,
}: {
  readonly control: GuidedControl;
  readonly pending: boolean;
  readonly onClick: () => void;
}) => (
  <Button
    aria-busy={pending || undefined}
    className={`btn ${control === "requested" ? "asked" : "ghosty"}`}
    disabled={pending}
    onClick={onClick}
  >
    {pending ? <Spinner /> : null}
    {CONTROL_LABEL[control]}
  </Button>
);

/* ------------------------------------------------------ takeover variable */

/**
 * Types a Variable into the field the user focused on the page, through
 * Teaching's masking path. The Timeline shows the value; the saved Flow keeps
 * the name, so the field shows what you type.
 */
export const TakeoverVariableCard = ({
  collapse,
  forced,
}: {
  readonly collapse: ReactNode;
  readonly forced: TakeoverState;
}) => {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [live, setLive] = useState<Exclude<TakeoverState, "live">>("empty");
  const [entered, setEntered] = useState<readonly string[]>([]);
  const state = forced === "live" ? live : forced;
  const shownName =
    forced === "live"
      ? name
      : state === "empty"
        ? ""
        : state === "invalid"
          ? "promo code"
          : "PROMO_CODE";
  const shownValue =
    forced === "live"
      ? value
      : state === "filled" || state === "submitting"
        ? "SPRING25"
        : "";
  const shownEntered =
    forced === "live" ? entered : state === "entered" ? ["PROMO_CODE"] : [];
  const pending = state === "submitting";
  const nameInvalid = state === "invalid";
  const id = "takeover-var";
  const submit = () => {
    if (forced !== "live") return;
    if (!NAME.test(name)) {
      setLive("invalid");
      return;
    }
    if (value === "") return;
    setLive("submitting");
    setTimeout(() => {
      setValue("");
      if (value === "fail") {
        setLive("error");
        return;
      }
      setEntered((all) => [...all.filter((n) => n !== name), name]);
      setLive("entered");
    }, 700);
  };
  return (
    <section
      aria-label="Takeover Variable"
      className="request-card"
      data-kind="takeover"
    >
      <header>
        <span className="request-icon">
          <KeyIcon />
        </span>
        <div className="request-head">
          <span className="eyebrow">While you have control</span>
          <h2>Takeover Variable</h2>
        </div>
        {collapse}
      </header>
      <p className="request-detail">
        Focus the page field first. The Timeline shows the value; the saved Flow
        keeps the name.
      </p>
      <form
        className="var-fields takeover-form"
        data-state={state}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="var-field">
          <label className="var-label" htmlFor={`${id}-name`}>
            <span>Variable name</span>
          </label>
          <Input
            aria-describedby={nameInvalid ? `${id}-name-message` : undefined}
            aria-invalid={nameInvalid || undefined}
            autoComplete="off"
            className="input mono"
            disabled={pending}
            id={`${id}-name`}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setLive("filled");
            }}
            placeholder="PROMO_CODE"
            spellCheck={false}
            value={shownName}
          />
          {nameInvalid ? (
            <p className="var-invalid" id={`${id}-name-message`}>
              Start with a capital letter. Use A–Z, 0–9 and _.
            </p>
          ) : null}
        </div>
        <div className="var-field">
          <label className="var-label" htmlFor={`${id}-value`}>
            <span>Variable value</span>
          </label>
          <div className="var-row">
            <span className="var-input">
              <Input
                autoComplete="off"
                className="input mono"
                disabled={pending}
                id={`${id}-value`}
                onChange={(e) => {
                  setValue(e.currentTarget.value);
                  setLive("filled");
                }}
                placeholder="Value"
                spellCheck={false}
                value={shownValue}
              />
            </span>
            <Button
              className="btn compact-btn"
              disabled={pending || shownName === "" || shownValue === ""}
              type="submit"
            >
              {pending ? <Spinner /> : null}
              Enter Variable
            </Button>
          </div>
        </div>
        {state === "error" ? (
          <p className="comment-error" role="alert">
            Could not enter the Variable. Focus the browser field and try again.
          </p>
        ) : null}
      </form>
      {shownEntered.length > 0 ? (
        <ul aria-label="Entered" className="var-answered">
          {shownEntered.map((n) => (
            <li data-answer="supplied" key={n}>
              <CheckCircleIcon />
              <span className="mono">{n}</span>
              <span className="faint">entered</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

/* ---------------------------------------------------------- bot protection */

/**
 * The site's bot protection refused the session's browser (#266). It stays
 * until dismissed, in the needs-you tone rather than as a failure: the page
 * and the Flow are fine, the site is turning automated browsers away.
 */
export const BotProtectionNotice = ({
  host,
  onDismiss,
}: {
  readonly host: string;
  readonly onDismiss: () => void;
}) => (
  <div className="notice island bot-notice" data-tone="warn" role="alert">
    <span aria-hidden="true" className="notice-mark">
      <ShieldIcon />
    </span>
    <div className="bot-notice-body">
      <strong>{host} blocked this browser</strong>
      <span>
        Cloudflare bot protection refused a request with HTTP 403. The site is
        turning away automated browsers, so the page is not broken and neither
        is the Flow.
      </span>
    </div>
    <Button
      aria-label="Dismiss bot protection notice"
      className="icon-btn small"
      onClick={onDismiss}
    >
      <CloseIcon />
    </Button>
  </div>
);
