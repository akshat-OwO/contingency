/**
 * What `contingency start` and `contingency web` print when they come up: the
 * watcher mark with the version beside it, an aligned block of facts, and one
 * status line. A pipe, a CI log, or a terminal that asked for no colour gets
 * the caller's plain lines instead, so scripts that read them keep working.
 */

export interface StartupRow {
  readonly label: string;
  /** Underlined, as terminals draw a link. */
  readonly link?: boolean;
  readonly value: string;
}

export interface StartupScreen {
  /** Dimmed after the status, such as how to stop. */
  readonly hint?: string;
  /** The lines printed where the screen cannot be drawn. */
  readonly plain: readonly string[];
  readonly rows: readonly StartupRow[];
  readonly status: string;
}

/** The mark's eyes, drawn in half blocks so three rows hold six pixels. */
const MARK = [
  "▀▄▄▄          ▄▄▄▀",
  "  ▀████▄  ▄████▀  ",
  "   ▀████  ████▀   ",
] as const;

const TAGLINE = "watching your features";

/** The mark, the gap, and the name with a version beside it. */
const MIN_COLUMNS = 48;

const ESC = "\u001B[";
// 256-colour because Terminal.app has no truecolor. Colour 136 (#af8700) is a
// darker amber than the Workspace's: the terminal's background is unknown, and
// this one keeps about 3:1 on white and 6:1 on black.
const amber = (text: string): string => `${ESC}38;5;136m${text}${ESC}39m`;
const bold = (text: string): string => `${ESC}1m${text}${ESC}22m`;
const dim = (text: string): string => `${ESC}2m${text}${ESC}22m`;
const underline = (text: string): string => `${ESC}4m${text}${ESC}24m`;

/**
 * Whether `stream` can show the screen: a terminal a person is reading, wide
 * enough for the mark, that has not opted out of colour.
 */
export const supportsStartupScreen = ({
  columns,
  env,
  isTTY,
}: {
  readonly columns: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean | undefined;
}): boolean =>
  isTTY === true &&
  (env.NO_COLOR === undefined || env.NO_COLOR === "") &&
  (env.CI === undefined || env.CI === "" || env.CI === "false") &&
  env.TERM !== "dumb" &&
  (columns === undefined || columns >= MIN_COLUMNS);

/** `path` with the user's home directory written as `~`. */
export const tildify = (path: string, home: string): string => {
  if (home === "" || home === "/") {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

export const renderStartupScreen = ({
  rich,
  screen,
  version,
}: {
  readonly rich: boolean;
  readonly screen: StartupScreen;
  readonly version: string;
}): string => {
  if (!rich) {
    return screen.plain.join("\n");
  }
  const labelWidth = Math.max(...screen.rows.map((row) => row.label.length));
  const hint = screen.hint === undefined ? "" : dim(` · ${screen.hint}`);
  return [
    "",
    `  ${amber(MARK[0])}`,
    `  ${amber(MARK[1])}   ${bold("contingency")} ${dim(`v${version}`)}`,
    `  ${amber(MARK[2])}   ${dim(TAGLINE)}`,
    "",
    ...screen.rows.map(
      (row) =>
        `  ${dim(row.label.padEnd(labelWidth))}  ${row.link ? underline(row.value) : row.value}`
    ),
    "",
    `  ${amber("●")} ${screen.status}${hint}`,
    "",
  ].join("\n");
};
