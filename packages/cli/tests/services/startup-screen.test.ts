import { stripVTControlCharacters } from "node:util";

import { expect, it } from "@effect/vitest";

import {
  renderStartupScreen,
  supportsStartupScreen,
  tildify,
} from "../../src/services/startup-screen.ts";
import type { StartupScreen } from "../../src/services/startup-screen.ts";

const screen: StartupScreen = {
  hint: "Ctrl+C to close",
  plain: ["Contingency UI available at http://127.0.0.1:7777/"],
  rows: [
    { label: "Workspace", link: true, value: "http://127.0.0.1:7777/" },
    { label: "Catalog Root", value: "~/store/.contingency" },
  ],
  status: "Workspace ready",
};

/** What the terminal would draw, without the styling sequences. */
const visible = stripVTControlCharacters;

it("draws the screen only on a terminal a person is reading", () => {
  const terminal = { columns: 120, env: {}, isTTY: true };
  expect(supportsStartupScreen(terminal)).toBe(true);
  expect(supportsStartupScreen({ ...terminal, columns: undefined })).toBe(true);
  expect(supportsStartupScreen({ ...terminal, isTTY: false })).toBe(false);
  expect(supportsStartupScreen({ ...terminal, isTTY: undefined })).toBe(false);
  expect(supportsStartupScreen({ ...terminal, columns: 40 })).toBe(false);
  expect(supportsStartupScreen({ ...terminal, env: { NO_COLOR: "1" } })).toBe(
    false
  );
  expect(supportsStartupScreen({ ...terminal, env: { NO_COLOR: "" } })).toBe(
    true
  );
  expect(supportsStartupScreen({ ...terminal, env: { CI: "true" } })).toBe(
    false
  );
  expect(supportsStartupScreen({ ...terminal, env: { TERM: "dumb" } })).toBe(
    false
  );
});

it("prints the caller's plain lines unchanged without a terminal", () => {
  expect(renderStartupScreen({ rich: false, screen, version: "1.2.3" })).toBe(
    "Contingency UI available at http://127.0.0.1:7777/"
  );
});

it("shows the mark, the version, aligned rows, and the status", () => {
  const lines = visible(
    renderStartupScreen({ rich: true, screen, version: "1.2.3" })
  ).split("\n");
  expect(lines).toStrictEqual([
    "",
    "  ▀▄▄▄          ▄▄▄▀",
    "    ▀████▄  ▄████▀     contingency v1.2.3",
    "     ▀████  ████▀      watching your features",
    "",
    "  Workspace     http://127.0.0.1:7777/",
    "  Catalog Root  ~/store/.contingency",
    "",
    "  ● Workspace ready · Ctrl+C to close",
    "",
  ]);
});

it("leaves the hint out when there is none", () => {
  const { hint: _hint, ...withoutHint } = screen;
  expect(
    visible(
      renderStartupScreen({ rich: true, screen: withoutHint, version: "1.2.3" })
    )
  ).toContain("  ● Workspace ready\n");
});

it("writes the home directory as a tilde", () => {
  expect(tildify("/Users/sam/store/.contingency", "/Users/sam")).toBe(
    "~/store/.contingency"
  );
  expect(tildify("/Users/sam", "/Users/sam")).toBe("~");
  expect(tildify("/Users/samantha/store", "/Users/sam")).toBe(
    "/Users/samantha/store"
  );
  expect(tildify("/srv/store", "")).toBe("/srv/store");
});
