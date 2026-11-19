/**
 * App chrome (#779): the theme menu and the pages that used to sit under the
 * header band. The header band is gone: every page carries the same two
 * islands as the Workspace home, the wordmark on the left and Flows, Docs
 * and the theme menu on the right.
 */
import { Button } from "@ui-sdk/react/button";
import {
  Menu,
  MenuContent,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  AlertCircleIcon,
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  WatcherLoader,
  WatcherMark,
} from "./icons";

type ThemeChoice = "light" | "dark" | "system";

/** The prod key, so a choice made here reads the same way there. */
const STORAGE_KEY = "contingency-theme";

const readChoice = (): ThemeChoice => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

const applyChoice = (choice: ThemeChoice) => {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
};

// Apply the saved choice before the first paint of the prototype.
applyChoice(readChoice());

const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

const CHOICES: readonly {
  readonly value: ThemeChoice;
  readonly label: string;
  readonly Icon: () => ReactNode;
}[] = [
  { Icon: SunIcon, label: "Light", value: "light" },
  { Icon: MoonIcon, label: "Dark", value: "dark" },
  { Icon: MonitorIcon, label: "System", value: "system" },
];

/**
 * One menu, three radio items. The checked one is the saved choice, so
 * System stays visible as a choice rather than collapsing into Light or
 * Dark. The trigger shows the theme in effect.
 */
export const ThemeMenu = () => {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const [dark, setDark] = useState(() =>
    choice === "system" ? systemDark() : choice === "dark"
  );
  useEffect(() => {
    if (choice !== "system") {
      setDark(choice === "dark");
      return;
    }
    const query = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setDark(query.matches);
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [choice]);
  const choose = (next: ThemeChoice) => {
    const commit = () => {
      try {
        if (next === "system") localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The choice still applies for this page.
      }
      applyChoice(next);
      setChoice(next);
    };
    // Cross-fade like prod: the view transition captures the old theme.
    if ("startViewTransition" in document) {
      document.startViewTransition(commit);
    } else {
      commit();
    }
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label="Change color theme" className="icon-btn" />}
      >
        {dark ? <MoonIcon /> : <SunIcon />}
      </MenuTrigger>
      <MenuContent align="end" className="popover island theme-menu">
        <MenuRadioGroup
          onValueChange={(value) => choose(value as ThemeChoice)}
          value={choice}
        >
          {CHOICES.map(({ Icon, label, value }) => (
            <MenuRadioItem
              className="theme-item"
              closeOnSelect
              key={value}
              value={value}
            >
              <span aria-hidden="true" className="theme-item-icon">
                <Icon />
              </span>
              <span className="theme-item-label">{label}</span>
              {value === "system" ? (
                <span className="theme-item-hint">
                  {/* Read as "System, Light now"; the column separates it. */}
                  <span className="sr-only">, </span>
                  {systemDark() ? "Dark now" : "Light now"}
                </span>
              ) : null}
              <MenuItemIndicator className="theme-item-check">
                <CheckIcon />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
};

export type StatusKind = "not-found" | "loading" | "unavailable";

export const STATUS_KINDS: readonly StatusKind[] = [
  "not-found",
  "loading",
  "unavailable",
];

/**
 * A page with nothing to dock: an unknown route, the Workspace while it
 * looks for sessions, and a session link that no longer resolves. They had
 * the header band; now they float one card on the canvas under the same
 * islands as the home.
 */
export const StatusPage = ({
  actions,
  kind,
  onHome,
}: {
  readonly actions: ReactNode;
  readonly kind: StatusKind;
  readonly onHome: () => void;
}) => (
  <>
    <nav aria-label="Workspace" className="chrome left island">
      <a
        aria-label="Contingency home"
        className="brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onHome();
        }}
      >
        <WatcherMark className="brand-mark" />
        <span className="brand-text">contingency</span>
      </a>
    </nav>
    {actions}
    <main
      aria-busy={kind === "loading" || undefined}
      aria-live={kind === "loading" ? "polite" : undefined}
      className="status-page"
    >
      {kind === "loading" ? (
        <section className="status-card">
          <WatcherLoader className="status-loader" />
          <h1>Loading Agent Sessions…</h1>
          <p>Looking for sessions owned by this local MCP process.</p>
        </section>
      ) : kind === "not-found" ? (
        <section className="status-card island">
          <span aria-hidden="true" className="status-code">
            404
          </span>
          <h1>Page not found</h1>
          <p>This route does not exist in Contingency.</p>
          <Button className="btn" onClick={onHome}>
            Go to the Workspace
          </Button>
        </section>
      ) : (
        <section className="status-card island">
          <div className="status-alert" role="alert">
            <AlertCircleIcon />
            <div>
              <h1>Agent Session unavailable</h1>
              <p>
                No Agent Session <code className="code">s-7f3a</code> in this
                MCP process. It may have closed, or another process owns it.
              </p>
            </div>
          </div>
          <p className="status-note">
            The session id selects a session; it is not an authentication token.
          </p>
          <Button className="btn" onClick={onHome}>
            Go to the Workspace
          </Button>
        </section>
      )}
    </main>
  </>
);
