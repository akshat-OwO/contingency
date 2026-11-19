import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkPattern } from "@ui-sdk/core/testing";
import { ThemeProvider } from "next-themes";
import { afterEach, expect, test } from "vitest";

import { GoToWorkspace, StatusPage } from "@/components/app-islands";
import { ModeToggle } from "@/components/mode-toggle";

// jsdom does not scroll; the menu brings its highlighted item into view.
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {
  void this;
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
});

const renderToggle = () =>
  render(
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      storageKey="contingency-theme"
    >
      <ModeToggle />
    </ThemeProvider>
  );

test("the theme menu checks the saved choice and keeps System a choice", async () => {
  const user = userEvent.setup();
  renderToggle();
  // The keyboard opens it, so focus moves into the menu (APG menu button).
  screen.getByRole("button", { name: "Change color theme" }).focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await checkPattern(menu, "menu");
  // The test environment prefers light, so System says what it gives now.
  const system = within(menu).getByRole("menuitemradio", {
    name: "System, Light now",
  });
  expect(system).toHaveAttribute("aria-checked", "true");
  expect(
    within(menu).getByRole("menuitemradio", { name: "Light" })
  ).toHaveAttribute("aria-checked", "false");

  // jsdom has no pointer selection, so choose with the keys: Home is Light.
  await user.keyboard("{Home}{ArrowDown}{Enter}");
  expect(localStorage.getItem("contingency-theme")).toBe("dark");
  expect(document.documentElement).toHaveClass("dark");
  // Choosing closes the menu.
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Change color theme" }));
  expect(
    within(await screen.findByRole("menu")).getByRole("menuitemradio", {
      name: "Dark",
    })
  ).toHaveAttribute("aria-checked", "true");
});

test("a page with nothing to dock has the app islands and one way out", () => {
  render(
    <StatusPage>
      <h1>Page not found</h1>
      <GoToWorkspace />
    </StatusPage>
  );
  // No header band: the way home is the islands' Contingency home link.
  expect(
    screen.queryByRole("navigation", { name: "Primary navigation" })
  ).not.toBeInTheDocument();
  const nav = screen.getByRole("navigation", { name: "Workspace" });
  expect(
    within(nav).getByRole("link", { name: "Contingency home" })
  ).toHaveAttribute("href", "/");
  expect(
    screen.getByRole("button", { name: "Change color theme" })
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Go to the Workspace" })
  ).toHaveAttribute("href", "/");
});
